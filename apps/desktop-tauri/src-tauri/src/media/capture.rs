// Captura de tela ou janela pelo DesktopCapturer do libwebrtc (DXGI + Windows.Graphics.Capture,
// com reserva em GDI). Entrega frames BGRA contíguos; a conversão para NV12 fica no fim do arquivo.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use libwebrtc::desktop_capturer::{CaptureError, CaptureSource, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions};

pub type Frame = (Vec<u8>, u32, u32);

#[derive(Clone, Copy, PartialEq)]
pub enum SourceKind {
    Screen,
    Window,
}

impl SourceKind {
    pub fn label(self) -> &'static str {
        match self {
            SourceKind::Screen => "screen",
            SourceKind::Window => "window",
        }
    }
}

/// Fontes do tipo pedido, em ordem estável. Janelas sem título ficam de fora.
pub fn list(kind: SourceKind) -> Result<Vec<CaptureSource>, String> {
    let capturer = open(kind)?;
    let mut sources = capturer.get_source_list();
    if kind == SourceKind::Window {
        sources.retain(|source| !source.title().trim().is_empty());
    }
    Ok(sources)
}

/// `"screen:<id>"` ou `"window:<id>"`, como a webview manda.
pub fn parse_source(spec: &str) -> Result<(SourceKind, u64), String> {
    let invalid = || "Fonte de captura inválida.".to_owned();
    let (kind, id) = spec.split_once(':').ok_or_else(invalid)?;
    let kind = match kind {
        "screen" => SourceKind::Screen,
        "window" => SourceKind::Window,
        _ => return Err(invalid()),
    };
    Ok((kind, id.parse().map_err(|_| invalid())?))
}

fn open(kind: SourceKind) -> Result<DesktopCapturer, String> {
    let mut options = DesktopCapturerOptions::new(match kind {
        SourceKind::Screen => DesktopCaptureSourceType::Screen,
        SourceKind::Window => DesktopCaptureSourceType::Window,
    });
    options.set_include_cursor(true);
    DesktopCapturer::new(options).ok_or_else(|| "Não foi possível iniciar a captura da tela neste Windows.".to_owned())
}

pub struct Capturer {
    capturer: DesktopCapturer,
    slot: Arc<Mutex<Option<Frame>>>,
    permanent: Arc<AtomicBool>,
    width: u32,
    height: u32,
}

impl Capturer {
    /// Abre a fonte e espera o primeiro frame (é dele que vem o tamanho).
    pub fn new(kind: SourceKind, id: u64) -> Result<Self, String> {
        let mut capturer = open(kind)?;
        let source = capturer
            .get_source_list()
            .into_iter()
            .find(|source| source.id() == id)
            .ok_or("Essa tela ou janela não está mais disponível.")?;
        let slot: Arc<Mutex<Option<Frame>>> = Arc::new(Mutex::new(None));
        let permanent = Arc::new(AtomicBool::new(false));
        {
            let (slot, permanent) = (slot.clone(), permanent.clone());
            capturer.start_capture(Some(source), move |result| match result {
                Ok(frame) => {
                    let (width, height) = (frame.width().max(0) as usize, frame.height().max(0) as usize);
                    if width == 0 || height == 0 {
                        return;
                    }
                    let (stride, data) = (frame.stride() as usize, frame.data());
                    let row = width * 4;
                    if stride < row || data.len() < stride * (height - 1) + row {
                        return;
                    }
                    let mut bgra = Vec::with_capacity(row * height);
                    for y in 0..height {
                        bgra.extend_from_slice(&data[y * stride..y * stride + row]);
                    }
                    *slot.lock().unwrap() = Some((bgra, width as u32, height as u32));
                }
                Err(CaptureError::Permanent) => permanent.store(true, Ordering::SeqCst),
                Err(CaptureError::Temporary) => {}
            });
        }

        let mut this = Self { capturer, slot, permanent, width: 0, height: 0 };
        for _ in 0..60 {
            if let Some(frame) = this.grab()? {
                this.width = frame.1;
                this.height = frame.2;
                this.slot.lock().unwrap().replace(frame);
                return Ok(this);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("A captura não entregou imagem. A janela pode estar minimizada ou protegida.".to_owned())
    }

    fn grab(&mut self) -> Result<Option<Frame>, String> {
        self.capturer.capture_frame();
        if self.permanent.load(Ordering::SeqCst) {
            return Err("A tela ou janela transmitida deixou de estar disponível.".to_owned());
        }
        Ok(self.slot.lock().unwrap().take())
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Espera `wait_ms` (o ritmo do chamador) e captura. `Ok(None)` = sem frame novo.
    pub fn acquire(&mut self, wait_ms: u32) -> Result<Option<Vec<u8>>, String> {
        std::thread::sleep(Duration::from_millis(u64::from(wait_ms)));
        Ok(self.grab()?.map(|(bgra, width, height)| {
            self.width = width;
            self.height = height;
            bgra
        }))
    }
}

/// Um frame BGRA da fonte, para a miniatura do seletor.
pub fn snapshot(kind: SourceKind, id: u64) -> Option<Frame> {
    let capturer = Capturer::new(kind, id).ok()?;
    let frame = capturer.slot.lock().unwrap().take();
    frame
}

/// BGRA (sRGB, full range) -> NV12 (BT.709, limited range), com redução por amostragem.
pub fn bgra_to_nv12(src: &[u8], src_width: u32, src_height: u32, dst: &mut [u8], dst_width: u32, dst_height: u32) {
    debug_assert_eq!(src.len(), (src_width * src_height * 4) as usize);
    debug_assert!(dst.len() >= (dst_width * dst_height * 3 / 2) as usize);

    let (sw, sh) = (src_width as usize, src_height as usize);
    let luma = (dst_width * dst_height) as usize;

    for y in 0..dst_height as usize {
        let sy = (y * sh / dst_height as usize).min(sh - 1);
        for x in 0..dst_width as usize {
            let sx = (x * sw / dst_width as usize).min(sw - 1);
            let i = (sy * sw + sx) * 4;
            let (b, g, r) = (src[i] as i32, src[i + 1] as i32, src[i + 2] as i32);
            dst[y * dst_width as usize + x] = (((47 * r + 157 * g + 16 * b) >> 8) + 16).clamp(0, 255) as u8;
        }
    }

    for y in (0..dst_height as usize).step_by(2) {
        let sy = (y * sh / dst_height as usize).min(sh - 1);
        for x in (0..dst_width as usize).step_by(2) {
            let sx = (x * sw / dst_width as usize).min(sw - 1);
            let i = (sy * sw + sx) * 4;
            let (b, g, r) = (src[i] as i32, src[i + 1] as i32, src[i + 2] as i32);
            let uv = luma + (y / 2) * dst_width as usize + x;
            dst[uv] = (((-26 * r - 87 * g + 112 * b) >> 8) + 128).clamp(0, 255) as u8;
            dst[uv + 1] = (((112 * r - 102 * g - 10 * b) >> 8) + 128).clamp(0, 255) as u8;
        }
    }
}
