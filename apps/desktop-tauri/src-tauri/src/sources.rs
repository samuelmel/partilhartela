// Lista telas e janelas para o seletor da webview, com miniatura em PNG (base64).

use base64::Engine;
use serde::Serialize;

use crate::media::capture::{self, SourceKind};

const THUMB_WIDTH: usize = 320;
const MAX_WINDOWS: usize = 30;

#[derive(Serialize)]
pub struct SourceInfo {
    /// `"screen:<id>"` ou `"window:<id>"`, o mesmo valor que `start_share` recebe.
    id: String,
    kind: &'static str,
    title: String,
    /// `data:image/png;base64,...`; ausente se a miniatura falhou.
    thumbnail: Option<String>,
}

fn thumbnail(kind: SourceKind, id: u64) -> Option<String> {
    let (bgra, width, height) = capture::snapshot(kind, id)?;
    let (width, height) = (width as usize, height as usize);
    let out_w = THUMB_WIDTH.min(width);
    let out_h = (height * out_w / width).max(1);
    let mut rgb = Vec::with_capacity(out_w * out_h * 3);
    for y in 0..out_h {
        let sy = (y * height / out_h).min(height - 1);
        for x in 0..out_w {
            let i = (sy * width + (x * width / out_w).min(width - 1)) * 4;
            rgb.extend_from_slice(&[bgra[i + 2], bgra[i + 1], bgra[i]]);
        }
    }
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, out_w as u32, out_h as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder.write_header().ok()?.write_image_data(&rgb).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png_bytes)))
}

fn collect() -> Result<Vec<SourceInfo>, String> {
    let mut items = Vec::new();
    for (kind, limit) in [(SourceKind::Screen, usize::MAX), (SourceKind::Window, MAX_WINDOWS)] {
        for (index, source) in capture::list(kind)?.into_iter().take(limit).enumerate() {
            let title = match kind {
                SourceKind::Screen => format!("Tela {}", index + 1),
                SourceKind::Window => source.title(),
            };
            items.push(SourceInfo {
                id: format!("{}:{}", kind.label(), source.id()),
                kind: kind.label(),
                title,
                thumbnail: thumbnail(kind, source.id()),
            });
        }
    }
    Ok(items)
}

#[tauri::command]
pub async fn list_sources() -> Result<Vec<SourceInfo>, String> {
    tauri::async_runtime::spawn_blocking(collect)
        .await
        .map_err(|_| "Não foi possível listar as telas e janelas.".to_owned())?
}
