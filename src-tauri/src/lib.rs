mod commands;
mod types;
mod pty;
mod fs;
mod ssh;
mod ssh_config;
pub mod tunnel;
mod snippets;
pub mod plugins;

use commands::AppState;
use tauri::{Manager, Emitter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().unwrap();
            let app_state = AppState::new(data_dir);
            app.manage(app_state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Only handle graceful shutdown for the main window
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.emit("app:request-close", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_test_connection,
            commands::ssh_extract_pem,
            commands::ssh_migrate_all_keys,
            commands::ssh_disconnect,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_create,
            commands::terminal_close,
            commands::connections_get,
            commands::connections_save,
            commands::fs_list,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::fs_cwd,
            commands::fs_mkdir,
            commands::fs_rename,
            commands::fs_delete,
            commands::fs_copy,
            commands::fs_exists,
            commands::tunnel_get_all,
            commands::tunnel_start_local,
            commands::tunnel_start_remote,
            commands::tunnel_stop,
            commands::tunnel_list,
            commands::tunnel_save,
            commands::tunnel_delete,
            commands::tunnel_start,
            commands::window_is_maximized,
            commands::window_maximize,
            commands::window_minimize,
            commands::window_close,
            commands::ssh_exec,
            commands::ssh_import_config,
            commands::snippets_list,
            commands::snippets_save,
            commands::snippets_delete,
            commands::settings_get,
            commands::settings_set,
            commands::sftp_put,
            commands::shell_open,
            commands::app_exit,
            commands::plugins_load,
            commands::plugins_toggle,
            commands::plugin_fs_read,
            commands::plugin_fs_write,
            commands::plugin_fs_list,
            commands::plugin_fs_exists,
            commands::plugin_fs_create_dir,
            commands::plugin_window_create,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

