mod auth;
mod media;
mod share;
mod sources;

use tauri::RunEvent;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Primeiro plugin: uma instância só; abrir um link com o app aberto chega aqui (Windows).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let link = argv.iter().find(|arg| arg.starts_with("partilhartela://"));
            match link {
                Some(link) => auth::handle_deep_link(app, link),
                None => auth::focus_main_window(app),
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(share::ShareState::default())
        .manage(auth::AuthState::default())
        .invoke_handler(tauri::generate_handler![
            share::start_share,
            share::stop_share,
            share::set_share_audio_muted,
            sources::list_sources,
            sources::list_audio_processes,
            auth::authorize_discord,
            auth::consume_pending_join,
            auth::save_session,
            auth::load_session,
            auth::clear_session
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Em desenvolvimento o instalador não registrou o protocolo: registra em tempo de execução.
            #[cfg(debug_assertions)]
            let _ = app.deep_link().register_all();
            // App aberto pelo link (primeira instância): o link vem como argumento.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    auth::handle_deep_link(&handle, url.as_str());
                }
            }
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    auth::handle_deep_link(&handle, url.as_str());
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o PartilharTela");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            share::shutdown(handle);
        }
    });
}
