// Áudio do sistema via WASAPI loopback. O dispositivo de *render* é aberto como
// captura (Direction::Capture), que é como o Windows expõe o loopback.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use wasapi::{initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

/// De onde sai o som transmitido.
#[derive(Clone, Copy)]
pub enum AudioSource {
    /// Tudo o que toca no dispositivo padrão.
    System,
    /// Só o aplicativo (e seus processos filhos).
    Application(u32),
    /// Tudo menos o aplicativo (ex.: o Discord, para não devolver a voz dos amigos).
    SystemExcluding(u32),
}

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
const BYTES_PER_SAMPLE: usize = 4; // f32
const CHUNK_FRAMES: usize = 480; // 10 ms

pub fn run_loopback(source: AudioSource, stop: Arc<AtomicBool>, muted: Arc<AtomicBool>, tx: tokio::sync::mpsc::Sender<Vec<i16>>) -> Result<(), String> {
    capture(source, stop, muted, tx).map_err(|error| format!("Não foi possível capturar o som: {error}"))
}

fn capture(source: AudioSource, stop: Arc<AtomicBool>, muted: Arc<AtomicBool>, tx: tokio::sync::mpsc::Sender<Vec<i16>>) -> Result<(), Box<dyn std::error::Error>> {
    let _ = initialize_mta();

    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let (mut client, mode) = match source {
        AudioSource::System => {
            let enumerator = DeviceEnumerator::new()?;
            let device = enumerator.get_default_device(&Direction::Render)?;
            let client = device.get_iaudioclient()?;
            let (default_period, min_period) = client.get_device_period()?;
            let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: min_period.max(default_period) };
            (client, mode)
        }
        AudioSource::Application(pid) | AudioSource::SystemExcluding(pid) => {
            let include_tree = matches!(source, AudioSource::Application(_));
            let client = AudioClient::new_application_loopback_client(pid, include_tree).map_err(|error| {
                format!("O Windows não liberou o som por aplicativo ({error}). Isso exige o Windows 10 versão 2004 ou mais novo.")
            })?;
            (client, StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 })
        }
    };
    client.initialize_client(&format, &Direction::Capture, &mode)?;

    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    let mut queue: VecDeque<u8> = VecDeque::new();
    let chunk_bytes = BYTES_PER_SAMPLE * CHANNELS as usize * CHUNK_FRAMES;
    client.start_stream()?;

    while !stop.load(Ordering::Relaxed) {
        let _ = capture.read_from_device_to_deque(&mut queue);

        while queue.len() >= chunk_bytes {
            if muted.load(Ordering::Relaxed) {
                queue.drain(..chunk_bytes);
                continue;
            }

            let mut samples = Vec::with_capacity(CHUNK_FRAMES * CHANNELS as usize);
            for _ in 0..CHUNK_FRAMES * CHANNELS as usize {
                let bytes = [
                    queue.pop_front().unwrap(),
                    queue.pop_front().unwrap(),
                    queue.pop_front().unwrap(),
                    queue.pop_front().unwrap(),
                ];
                let sample = f32::from_le_bytes(bytes);
                samples.push((sample.clamp(-1.0, 1.0) * 32767.0) as i16);
            }

            if tx.blocking_send(samples).is_err() {
                client.stop_stream().ok();
                return Ok(());
            }
        }

        // Timeout aqui é normal quando a tela está em silêncio.
        let _ = event.wait_for_event(200);
    }

    client.stop_stream().ok();
    Ok(())
}
