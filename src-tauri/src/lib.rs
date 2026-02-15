mod commands;
mod types;
mod pty;
mod fs;
mod ssh;
mod ssh_config;
pub mod tunnel;
mod snippets;
pub mod plugins;
mod ssh_parser;

use commands::AppState;
use tauri::{Manager, Emitter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Explicitly set a menu to override potential default conflicts
            // We use the default menu structure but this ensures we have control
            #[cfg(target_os = "macos")]
            {
                let menu = tauri::menu::Menu::default(app.handle())?;
                app.set_menu(menu)?;
            }

            let default_dir = app.path().app_data_dir().unwrap();
            let settings_path = default_dir.join("settings.json");
            
            // On Windows, auto-configure using installation directory
            #[cfg(target_os = "windows")]
            {
                if let Ok(exe_path) = std::env::current_exe() {
                    if let Some(exe_dir) = exe_path.parent() {
                        let exe_dir_str = exe_dir.to_string_lossy().to_string();
                        
                        // Read existing settings to preserve user preferences
                        let mut settings: serde_json::Value = if settings_path.exists() {
                            std::fs::read_to_string(&settings_path)
                                .ok()
                                .and_then(|data| serde_json::from_str(&data).ok())
                                .unwrap_or_else(|| serde_json::json!({}))
                        } else {
                            serde_json::json!({})
                        };
                        
                        // Always set dataPath to exe directory on Windows
                        if let Some(obj) = settings.as_object_mut() {
                            obj.insert("dataPath".to_string(), serde_json::json!(exe_dir_str));
                            obj.insert("logPath".to_string(), serde_json::json!(format!("{}\\logs", exe_dir_str)));
                            obj.insert("isConfigured".to_string(), serde_json::json!(true));
                            if !obj.contains_key("theme") {
                                obj.insert("theme".to_string(), serde_json::json!("dark"));
                            }
                        }
                        
                        // Write to bootstrap location
                        if !default_dir.exists() {
                            let _ = std::fs::create_dir_all(&default_dir);
                        }
                        let json = serde_json::to_string_pretty(&settings).unwrap_or_default();
                        let _ = std::fs::write(&settings_path, &json);
                        
                        // Also write to exe directory
                        if !exe_dir.exists() {
                            let _ = std::fs::create_dir_all(exe_dir);
                        }
                        let _ = std::fs::write(exe_dir.join("settings.json"), &json);
                    }
                }
            }
            
            // Now read the final data directory (will pick up the configured dataPath)
            let data_dir = if settings_path.exists() {
                if let Ok(data) = std::fs::read_to_string(&settings_path) {
                    if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&data) {
                        if let Some(data_path) = settings.get("dataPath").and_then(|v| v.as_str()) {
                            if !data_path.is_empty() {
                                let custom_dir = std::path::PathBuf::from(data_path);
                                if !custom_dir.exists() {
                                    let _ = std::fs::create_dir_all(&custom_dir);
                                }
                                custom_dir
                            } else {
                                default_dir.clone()
                            }
                        } else {
                            default_dir.clone()
                        }
                    } else {
                        default_dir.clone()
                    }
                } else {
                    default_dir.clone()
                }
            } else {
                default_dir.clone()
            };
            
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
            commands::fs_rename_batch,
            commands::fs_delete,
            commands::fs_copy,
            commands::fs_copy_batch,
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
            commands::ssh_internalize_connections,
            commands::snippets_list,
            commands::snippets_save,
            commands::snippets_delete,
            commands::settings_get,
            commands::settings_set,
            commands::sftp_put,
            commands::sftp_get,
            commands::sftp_copy_to_server,
            commands::sftp_cancel_transfer,
            commands::shell_open,
            commands::app_get_exe_dir,
            commands::app_exit,
            commands::plugins_load,
            commands::plugins_toggle,
            commands::plugin_fs_read,
            commands::plugin_fs_write,
            commands::plugin_fs_list,
            commands::plugin_fs_exists,
            commands::plugin_fs_create_dir,
            commands::plugin_window_create,
            commands::config_select_folder,
            commands::system_install_cli,
            commands::ssh_parse_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

