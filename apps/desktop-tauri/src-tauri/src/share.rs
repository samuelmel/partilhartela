// Transmissão da tela pelo Rust: conecta ao LiveKit como um segundo participante
// (`<identity>-share`), captura a tela (DXGI) e o áudio do sistema (WASAPI) e publica.
// A webview só pede o token e chama estes comandos; ela nunca fala mídia com o Rust.

use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use libwebrtc::audio_frame::AudioFrame;
use libwebrtc::audio_source::native::NativeAudioSource;
use libwebrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use libwebrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame, NV12Buffer, VideoFrame, VideoRotation};
use libwebrtc::video_source::native::NativeVideoSource;
use libwebrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
use livekit::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::media::audio::{self, run_loopback, AudioSource};
use crate::media::capture::{bgra_to_nv12, parse_source, Capturer, SourceKind};
use crate::media::encoder::Encoder;

#[derive(Deserialize, Clone, Copy)]
pub struct Quality {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u64,
}

#[derive(Serialize, Clone)]
struct ShareStatePayload {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn emit_state(app: &AppHandle, state: &'static str, message: Option<String>) {
    let _ = app.emit("share:state", ShareStatePayload { state, message });
}

pub struct ShareSession {
    id: u64,
    stop: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    room: Arc<Room>,
    video: LocalTrackPublication,
    audio: Option<LocalTrackPublication>,
    threads: Vec<JoinHandle<()>>,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub struct ShareState {
    current: Mutex<Option<ShareSession>>,
    busy: AtomicBool,
    next_id: AtomicU64,
}

/// O que a thread de captura descobre antes de existir a fonte de vídeo.
struct CaptureInfo {
    size: (u32, u32),
    /// `true` = o encoder H.264 do Windows está ativo e a fonte é pré-codificada.
    encoded: bool,
}

/// Libera o `busy` mesmo se o comando falhar no meio.
struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn is_rpg(metadata: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(metadata)
        .ok()
        .and_then(|value| value.get("rpg").map(|rpg| rpg.is_object()))
        .unwrap_or(false)
}

/// Tamanho de envio: proporção da tela, limitado ao pedido (pares, para o NV12).
fn target_size(source: (u32, u32), quality: &Quality) -> (u32, u32) {
    let scale = (quality.width as f64 / source.0 as f64)
        .min(quality.height as f64 / source.1 as f64)
        .min(1.0);
    let width = ((source.0 as f64 * scale) as u32).max(2) & !1;
    let height = ((source.1 as f64 * scale) as u32).max(2) & !1;
    (width, height)
}

fn audio_source(mode: &str, pid: Option<u32>) -> Result<Option<AudioSource>, String> {
    let need_pid = || pid.filter(|pid| *pid != 0).ok_or_else(|| "Escolha o aplicativo do som.".to_owned());
    match mode {
        "none" => Ok(None),
        "system" => Ok(Some(AudioSource::System)),
        "application" => Ok(Some(AudioSource::Application(need_pid()?))),
        "system-excluding" => Ok(Some(AudioSource::SystemExcluding(need_pid()?))),
        _ => Err("Modo de áudio inválido.".to_owned()),
    }
}

fn validate(quality: &Quality) -> Result<(), String> {
    if !(2..=3840).contains(&quality.width) || !(2..=2160).contains(&quality.height) {
        return Err("Resolução de transmissão inválida.".to_owned());
    }
    if !(1..=60).contains(&quality.fps) {
        return Err("Taxa de quadros inválida (use de 1 a 60).".to_owned());
    }
    if !(100_000..=50_000_000).contains(&quality.bitrate) {
        return Err("Bitrate de transmissão inválido.".to_owned());
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_share(
    app: AppHandle,
    state: State<'_, ShareState>,
    url: String,
    token: String,
    quality: Quality,
    audio: String,
    source: Option<String>,
    audio_pid: Option<u32>,
) -> Result<(), String> {
    validate(&quality)?;
    let audio_source = audio_source(&audio, audio_pid)?;
    let source = source.as_deref().map(parse_source).transpose()?;
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("Você já está transmitindo.".to_owned());
    }
    let _busy = BusyGuard(&state.busy);
    emit_state(&app, "starting", None);

    if let Some((kind, id)) = source {
        // Janela minimizada: o capturador só a enxerga depois de restaurada.
        let _ = tauri::async_runtime::spawn_blocking(move || crate::sources::restore_if_minimized(kind, id)).await;
    }

    match connect_and_publish(&app, &state, url, token, quality, audio_source, source).await {
        Ok(session) => {
            *state.current.lock().unwrap() = Some(session);
            emit_state(&app, "live", None);
            Ok(())
        }
        Err(message) => {
            emit_state(&app, "error", Some(message.clone()));
            Err(message)
        }
    }
}

async fn connect_and_publish(
    app: &AppHandle,
    state: &ShareState,
    url: String,
    token: String,
    quality: Quality,
    audio_mode: Option<AudioSource>,
    source: Option<(SourceKind, u64)>,
) -> Result<ShareSession, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let stop = Arc::new(AtomicBool::new(false));
    let muted = Arc::new(AtomicBool::new(false));
    let rpg = Arc::new(AtomicBool::new(false));
    let (error_tx, mut error_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // A captura nasce numa thread própria (os objetos D3D não cruzam threads); ela avisa o tamanho da tela.
    let (size_tx, size_rx) = mpsc::channel::<Result<CaptureInfo, String>>();
    let (source_tx, source_rx) = mpsc::channel::<NativeVideoSource>();
    let mut threads = Vec::new();
    {
        let (stop, rpg, error_tx) = (stop.clone(), rpg.clone(), error_tx.clone());
        threads.push(std::thread::spawn(move || {
            capture_loop(quality, source, stop, rpg, size_tx, source_rx, error_tx);
        }));
    }
    let size = tokio::task::spawn_blocking(move || size_rx.recv())
        .await
        .map_err(|_| "A captura da tela não iniciou.".to_owned())?
        .map_err(|_| "A captura da tela não iniciou.".to_owned())
        .and_then(|result| result);
    let info = match size {
        Ok(info) => info,
        Err(message) => {
            stop.store(true, Ordering::SeqCst);
            join_threads(threads).await;
            return Err(message);
        }
    };
    let (width, height) = info.size;
    let resolution = VideoResolution { width, height };
    let source = if info.encoded {
        NativeVideoSource::new_encoded(resolution)
    } else {
        NativeVideoSource::new(resolution, true)
    };

    let mut room_options = RoomOptions::default();
    room_options.auto_subscribe = false;
    let connected = Room::connect(
        &url,
        &token,
        room_options,
    )
    .await;
    let (room, mut events) = match connected {
        Ok(pair) => pair,
        Err(error) => {
            stop.store(true, Ordering::SeqCst);
            join_threads(threads).await;
            return Err(format!("Não foi possível conectar ao servidor de mídia ({error})."));
        }
    };
    let room = Arc::new(room);

    let published = publish_tracks(&room, &source, info.encoded, &quality, audio_mode.is_some()).await;
    let (video, audio_pub, audio_source) = match published {
        Ok(tracks) => tracks,
        Err(message) => {
            stop.store(true, Ordering::SeqCst);
            join_threads(threads).await;
            let _ = room.close().await;
            return Err(message);
        }
    };

    rpg.store(is_rpg(&room.metadata()), Ordering::SeqCst);
    let mut tasks = Vec::new();

    // Eventos da sala: modo RPG (metadata) e queda da conexão.
    {
        let (rpg, error_tx) = (rpg.clone(), error_tx.clone());
        tasks.push(tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    RoomEvent::RoomMetadataChanged { metadata, .. } => {
                        rpg.store(is_rpg(&metadata), Ordering::SeqCst);
                    }
                    RoomEvent::Disconnected { .. } => {
                        let _ = error_tx.send("A conexão com a sala foi encerrada.".to_owned());
                        break;
                    }
                    _ => {}
                }
            }
        }));
    }

    // Áudio do sistema: thread WASAPI -> canal -> capture_frame.
    if let Some(source) = audio_source {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<i16>>(32);
        let (stop, muted, error_tx) = (stop.clone(), muted.clone(), error_tx.clone());
        let audio_from = audio_mode.unwrap_or(AudioSource::System);
        threads.push(std::thread::spawn(move || {
            if let Err(message) = run_loopback(audio_from, stop, muted, tx) {
                let _ = error_tx.send(message);
            }
        }));
        tasks.push(tauri::async_runtime::spawn(async move {
            while let Some(samples) = rx.recv().await {
                let frame = AudioFrame {
                    data: Cow::Owned(samples),
                    sample_rate: audio::SAMPLE_RATE,
                    num_channels: audio::CHANNELS,
                    samples_per_channel: 480,
                };
                if source.capture_frame(&frame).await.is_err() {
                    break;
                }
            }
        }));
    }

    // Entrega a fonte à thread de captura: ela começa a enviar frames.
    if source_tx.send(source).is_err() {
        stop.store(true, Ordering::SeqCst);
        join_threads(threads).await;
        let _ = room.close().await;
        return Err("A captura da tela terminou antes de começar.".to_owned());
    }

    // Erros em andamento (captura, conexão): encerra a sessão e avisa a webview.
    {
        let app = app.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            if let Some(message) = error_rx.recv().await {
                let state = app.state::<ShareState>();
                let session = {
                    let mut current = state.current.lock().unwrap();
                    if current.as_ref().map(|s| s.id) == Some(id) { current.take() } else { None }
                };
                if let Some(session) = session {
                    teardown(session).await;
                    emit_state(&app, "error", Some(message));
                }
            }
        }));
    }

    Ok(ShareSession { id, stop, muted, room, video, audio: audio_pub, threads, tasks })
}

async fn publish_tracks(
    room: &Arc<Room>,
    source: &NativeVideoSource,
    encoded: bool,
    quality: &Quality,
    with_audio: bool,
) -> Result<(LocalTrackPublication, Option<LocalTrackPublication>, Option<NativeAudioSource>), String> {
    let video_track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
    let video = room
        .local_participant()
        .publish_track(
            LocalTrack::Video(video_track),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: VideoCodec::H264,
                simulcast: false,
                // Frames já codificados pelo Windows: o libwebrtc só empacota (pass-through).
                video_encoder: if encoded { VideoEncoderBackend::PreEncoded } else { VideoEncoderBackend::Auto },
                video_encoding: Some(VideoEncoding {
                    max_bitrate: quality.bitrate,
                    max_framerate: quality.fps as f64,
                }),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| format!("Não foi possível publicar a tela ({error})."))?;

    if !with_audio {
        return Ok((video, None, None));
    }
    let audio_source = NativeAudioSource::new(
        AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false },
        audio::SAMPLE_RATE,
        audio::CHANNELS,
        100,
    );
    let audio_track = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(audio_source.clone()));
    let audio = room
        .local_participant()
        .publish_track(
            LocalTrack::Audio(audio_track),
            TrackPublishOptions { source: TrackSource::ScreenshareAudio, ..Default::default() },
        )
        .await
        .map_err(|error| format!("Não foi possível publicar o som da tela ({error})."))?;
    Ok((video, Some(audio), Some(audio_source)))
}

async fn join_threads(threads: Vec<JoinHandle<()>>) {
    let _ = tokio::task::spawn_blocking(move || {
        for thread in threads {
            let _ = thread.join();
        }
    })
    .await;
}

async fn teardown(session: ShareSession) {
    session.stop.store(true, Ordering::SeqCst);
    for task in &session.tasks {
        task.abort();
    }
    let participant = session.room.local_participant();
    let _ = participant.unpublish_track(&session.video.sid()).await;
    if let Some(audio) = &session.audio {
        let _ = participant.unpublish_track(&audio.sid()).await;
    }
    let _ = session.room.close().await;
    join_threads(session.threads).await;
}

/// Chamado no fechamento da janela.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<ShareState>();
    let session = state.current.lock().unwrap().take();
    if let Some(session) = session {
        tauri::async_runtime::block_on(teardown(session));
    }
}

#[tauri::command]
pub async fn stop_share(app: AppHandle, state: State<'_, ShareState>) -> Result<(), String> {
    let session = state.current.lock().unwrap().take();
    if let Some(session) = session {
        teardown(session).await;
    }
    emit_state(&app, "stopped", None);
    Ok(())
}

#[tauri::command]
pub async fn set_share_audio_muted(state: State<'_, ShareState>, muted: bool) -> Result<(), String> {
    let current = state.current.lock().unwrap();
    let session = current.as_ref().ok_or("Você não está transmitindo.")?;
    let audio = session.audio.as_ref().ok_or("Esta transmissão não tem áudio para mutar.")?;
    session.muted.store(muted, Ordering::SeqCst);
    if muted { audio.mute() } else { audio.unmute() }
    Ok(())
}

/// Thread de captura: cria o Capturer, informa o tamanho e envia frames até `stop`.
fn capture_loop(
    quality: Quality,
    source_spec: Option<(SourceKind, u64)>,
    stop: Arc<AtomicBool>,
    rpg: Arc<AtomicBool>,
    size_tx: mpsc::Sender<Result<CaptureInfo, String>>,
    source_rx: mpsc::Receiver<NativeVideoSource>,
    error_tx: tokio::sync::mpsc::UnboundedSender<String>,
) {
    // Sem fonte escolhida, usa a primeira tela.
    let spec = match source_spec {
        Some(spec) => Ok(spec),
        None => crate::media::capture::list(SourceKind::Screen).and_then(|screens| {
            screens.first().map(|screen| (SourceKind::Screen, screen.id())).ok_or_else(|| "Nenhuma tela encontrada.".to_owned())
        }),
    };
    let mut capturer = match spec.and_then(|(kind, id)| Capturer::new(kind, id)) {
        Ok(capturer) => capturer,
        Err(message) => {
            let _ = size_tx.send(Err(message));
            return;
        }
    };
    let (dst_w, dst_h) = target_size(capturer.size(), &quality);
    let interval = Duration::from_micros(1_000_000 / quality.fps as u64);
    // H.264 do Windows primeiro; se nenhum encoder funcionar, o libwebrtc codifica os frames crus.
    let mut encoder = match Encoder::new(dst_w, dst_h, quality.fps, quality.bitrate.min(u32::MAX as u64) as u32) {
        Ok(encoder) => Some(encoder),
        Err(message) => {
            eprintln!("[PartilharTela] Sem encoder H.264 do Windows ({message}); usando o do libwebrtc.");
            None
        }
    };
    let _ = size_tx.send(Ok(CaptureInfo { size: (dst_w, dst_h), encoded: encoder.is_some() }));
    let Ok(source) = source_rx.recv() else { return };

    let idle_resend = Duration::from_millis(500);
    let started = Instant::now();
    let mut last_sent = Instant::now() - interval;
    let mut last_frame: Option<(Vec<u8>, u32, u32)> = None;
    let mut nv12 = vec![0u8; (dst_w * dst_h * 3 / 2) as usize];
    let mut was_rpg = false;
    let mut want_key = false;

    while !stop.load(Ordering::Relaxed) {
        if encoder.is_some() {
            if source.take_keyframe_request() {
                want_key = true;
            }
            if let (Some(request), Some(encoder)) = (source.take_rate_control_request(), encoder.as_mut()) {
                encoder.set_bitrate(request.target_bitrate_bps.min(u32::MAX as u64) as u32);
            }
        }
        let wait = if want_key { 1 } else { interval.saturating_sub(last_sent.elapsed()).as_millis().max(1) as u32 };
        let fresh = match capturer.acquire(wait) {
            Ok(frame) => frame,
            Err(message) => {
                let _ = error_tx.send(message);
                return;
            }
        };
        if let Some(bgra) = fresh {
            let (w, h) = capturer.size();
            last_frame = Some((bgra, w, h));
        } else if !want_key && last_sent.elapsed() < idle_resend {
            continue;
        }
        if rpg.load(Ordering::Relaxed) {
            // Modo RPG: o vídeo não é enviado (o áudio continua).
            was_rpg = true;
            last_sent = Instant::now();
            continue;
        }
        if was_rpg {
            was_rpg = false;
            want_key = true;
        }
        if !want_key && last_sent.elapsed() < interval {
            continue;
        }
        let Some((bgra, w, h)) = last_frame.as_ref() else { continue };

        bgra_to_nv12(bgra, *w, *h, &mut nv12, dst_w, dst_h);
        let timestamp_us = started.elapsed().as_micros() as i64 + 1;

        if let Some(encoder) = encoder.as_mut() {
            let force = std::mem::take(&mut want_key);
            if force && !encoder.can_force_keyframe() {
                if let Err(message) = encoder.restart() {
                    let _ = error_tx.send(message);
                    return;
                }
            }
            match encoder.encode(&nv12, timestamp_us, force) {
                Ok(frames) => {
                    for frame in frames {
                        source.capture_encoded_frame(&EncodedVideoFrame {
                            codec: EncodedVideoCodec::H264,
                            payload: &frame.data,
                            timestamp_us,
                            frame_type: if frame.key { EncodedFrameType::Key } else { EncodedFrameType::Delta },
                            resolution: VideoResolution { width: dst_w, height: dst_h },
                            frame_metadata: None,
                        });
                    }
                }
                Err(message) => {
                    let _ = error_tx.send(message);
                    return;
                }
            }
        } else {
            want_key = false;
            let mut buffer = NV12Buffer::new(dst_w, dst_h);
            {
                let (y, uv) = buffer.data_mut();
                let luma = (dst_w * dst_h) as usize;
                y[..luma].copy_from_slice(&nv12[..luma]);
                uv[..nv12.len() - luma].copy_from_slice(&nv12[luma..]);
            }
            source.capture_frame(&VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us,
                frame_metadata: None,
                buffer,
            });
        }
        last_sent = Instant::now();
    }
}
