// Lista telas e janelas para o seletor da webview, com miniatura em PNG (base64).

use base64::Engine;
use serde::Serialize;

use std::collections::BTreeMap;

use std::ffi::c_void;
use std::time::Duration;

use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, ShowWindow, GWL_EXSTYLE, GW_OWNER, SW_RESTORE, WS_EX_TOOLWINDOW,
};

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
    /// Só em janelas: processo dono, para sugerir o som por aplicativo.
    pid: Option<u32>,
    /// Janela minimizada: o capturador só enxerga janelas visíveis, então ela é restaurada ao transmitir.
    minimized: bool,
}

struct MinimizedScan {
    own_pid: u32,
    found: Vec<(u64, String, u32)>,
}

/// Janelas de aplicativo minimizadas (o DesktopCapturer do libwebrtc não as lista).
unsafe extern "system" fn collect_minimized(hwnd: HWND, param: LPARAM) -> BOOL {
    let scan = &mut *(param.0 as *mut MinimizedScan);
    if !IsWindowVisible(hwnd).as_bool() || !IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.0.is_null()) {
        return BOOL(1);
    }
    if (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
        return BOOL(1);
    }
    // Janelas de outras áreas de trabalho virtuais ficam "cloaked": não são candidatas.
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4).is_ok() && cloaked != 0 {
        return BOOL(1);
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return BOOL(1);
    }
    let mut buffer = vec![0u16; len as usize + 1];
    let copied = GetWindowTextW(hwnd, &mut buffer).max(0) as usize;
    let title = String::from_utf16_lossy(&buffer[..copied]);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != 0 && pid != scan.own_pid && !title.trim().is_empty() {
        scan.found.push((hwnd.0 as usize as u64, title, pid));
    }
    BOOL(1)
}

fn minimized_windows() -> Vec<(u64, String, u32)> {
    let mut scan = MinimizedScan { own_pid: std::process::id(), found: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(collect_minimized), LPARAM(&mut scan as *mut MinimizedScan as isize));
    }
    scan.found
}

/// Restaura a janela se estiver minimizada: sem isso o capturador não a encontra.
pub fn restore_if_minimized(kind: SourceKind, id: u64) {
    if kind != SourceKind::Window {
        return;
    }
    let hwnd = HWND(id as usize as *mut _);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            std::thread::sleep(Duration::from_millis(600));
        }
    }
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
                pid: (kind == SourceKind::Window).then(|| window_pid(source.id())).flatten(),
                minimized: false,
            });
        }
    }
    for (handle, title, pid) in minimized_windows().into_iter().take(MAX_WINDOWS) {
        let id = format!("window:{handle}");
        if items.iter().any(|item| item.id == id) {
            continue;
        }
        items.push(SourceInfo { id, kind: "window", title, thumbnail: None, pid: Some(pid), minimized: true });
    }
    Ok(items)
}

#[tauri::command]
pub async fn list_sources() -> Result<Vec<SourceInfo>, String> {
    tauri::async_runtime::spawn_blocking(collect)
        .await
        .map_err(|_| "Não foi possível listar as telas e janelas.".to_owned())?
}

fn window_pid(handle: u64) -> Option<u32> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(HWND(handle as usize as *mut _), Some(&mut pid)) };
    (pid != 0).then_some(pid)
}

#[derive(Serialize)]
pub struct AudioProcess {
    pid: u32,
    name: String,
}

unsafe extern "system" fn collect_window_pids(hwnd: HWND, param: LPARAM) -> BOOL {
    let pids = &mut *(param.0 as *mut Vec<u32>);
    if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            pids.push(pid);
        }
    }
    BOOL(1)
}

fn process_names() -> BTreeMap<u32, String> {
    let mut names = BTreeMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return names };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            names.insert(entry.th32ProcessID, exe.trim_end_matches(".exe").trim_end_matches(".EXE").to_owned());
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    names
}

/// Aplicativos com janela visível (candidatos ao som por aplicativo), sem o próprio PartilharTela.
#[tauri::command]
pub async fn list_audio_processes() -> Result<Vec<AudioProcess>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut pids: Vec<u32> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect_window_pids), LPARAM(&mut pids as *mut Vec<u32> as isize));
        }
        pids.sort_unstable();
        pids.dedup();
        let names = process_names();
        let own = std::process::id();
        let mut list: Vec<AudioProcess> = pids
            .into_iter()
            .filter(|pid| *pid != own)
            .filter_map(|pid| names.get(&pid).map(|name| AudioProcess { pid, name: name.clone() }))
            .collect();
        list.sort_by_key(|item| item.name.to_lowercase());
        list
    })
    .await
    .map_err(|_| "Não foi possível listar os aplicativos.".to_owned())
}
