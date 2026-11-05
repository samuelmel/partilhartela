mod media;
mod share;

use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(share::ShareState::default())
        .invoke_handler(tauri::generate_handler![
            share::start_share,
            share::stop_share,
            share::set_share_audio_muted
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o PartilharTela");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            share::shutdown(handle);
        }
    });
}
