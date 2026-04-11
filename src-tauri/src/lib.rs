mod utils;
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
mod ai;

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
                            if let Err(e) = std::fs::create_dir_all(&default_dir) {
                                eprintln!("Failed to create default app_data_dir at {:?}: {}", default_dir, e);
                            }
                        }
                        let json = serde_json::to_string_pretty(&settings).unwrap_or_default();
                        if let Err(e) = std::fs::write(&settings_path, &json) {
                            eprintln!("Failed to write settings at {:?}: {}", settings_path, e);
                        }
                        
                        // Also write to exe directory
                        if !exe_dir.exists() {
                            if let Err(e) = std::fs::create_dir_all(exe_dir) {
                                eprintln!("Failed to create exe_dir at {:?}: {}", exe_dir, e);
                            }
                        }
                        let exe_settings_path = exe_dir.join("settings.json");
                        if let Err(e) = std::fs::write(&exe_settings_path, &json) {
                            eprintln!("Failed to write settings at {:?}: {}", exe_settings_path, e);
                        }
                    }
                }
            }
            
            // Now read the final data directory (will pick up the configured dataPath)
            let data_dir = (|| -> Option<std::path::PathBuf> {
                if !settings_path.exists() {
                    return Some(default_dir.clone());
                }

                let data = std::fs::read_to_string(&settings_path).ok()?;
                let settings = serde_json::from_str::<serde_json::Value>(&data).ok()?;
                let data_path = settings.get("dataPath")?.as_str()?;

                if data_path.is_empty() {
                    return None;
                }

                let custom_dir = std::path::PathBuf::from(data_path);
                if !custom_dir.exists() {
                    if let Err(e) = std::fs::create_dir_all(&custom_dir) {
                        eprintln!("Failed to create custom data directory at {:?}: {}", custom_dir, e);
                    }
                }
                Some(custom_dir)
            })().unwrap_or(default_dir);
            
            let app_state = AppState::new(data_dir);
            app.manage(app_state);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = webview.window().show();
            }
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Cancel all active agent runs so backend tasks don't outlive the window.
                    if window.label() == "main" {
                        if let Some(state) = window.try_state::<AppState>() {
                            if let Ok(runs) = state.agent_runs.try_lock() {
                                for cancel in runs.values() {
                                    cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                                }
                            }
                        }
                        api.prevent_close();
                        let _ = window.emit("app:request-close", ());
                    }
                }
                tauri::WindowEvent::DragDrop(drag_event) => {
                    match drag_event {
                        tauri::DragDropEvent::Enter { paths, .. } => {
                            let path_strings: Vec<String> = paths.iter()
                                .map(|p| p.to_string_lossy().to_string())
                                .collect();
                            let _ = window.emit("zync://drag-enter", path_strings);
                        }
                        tauri::DragDropEvent::Drop { paths, .. } => {
                            let path_strings: Vec<String> = paths.iter()
                                .map(|p| p.to_string_lossy().to_string())
                                .collect();
                            let _ = window.emit("zync://file-drop", path_strings);
                        }
                        tauri::DragDropEvent::Leave => {
                            let _ = window.emit("zync://drag-leave", ());
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_test_connection,
            commands::ssh_extract_pem,
            commands::ssh_migrate_all_keys,
            commands::ssh_disconnect,
            commands::terminal_write,
            commands::terminal_navigate,
            commands::terminal_resize,
            commands::terminal_create,
            commands::terminal_close,
            commands::connections_get,
            commands::connections_save,
            commands::connections_export_to_file,
            commands::connections_import_from_file,
            commands::fs_list,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::fs_cwd,
            commands::fs_touch,
            commands::fs_mkdir,
            commands::fs_rename,
            commands::fs_delete,
            commands::fs_delete_batch,
            commands::fs_copy,
            commands::fs_copy_batch,
            commands::fs_rename_batch,
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
            commands::ssh_import_config_from_file,
            commands::ssh_import_config_from_text,
            commands::ssh_import_config_by_source,
            commands::ssh_internalize_connections,
            commands::snippets_list,
            commands::snippets_save,
            commands::snippets_delete,
            commands::save_secret,
            commands::get_secret,
            commands::delete_secret,
            commands::get_system_info,
            commands::settings_get,
            commands::settings_set,
            commands::sftp_put,
            commands::sftp_get,
            commands::sftp_copy_to_server,
            commands::sftp_cancel_transfer,
            commands::sftp_download_as_zip,
            commands::shell_open,
            commands::app_get_exe_dir,
            commands::app_exit,
            commands::plugins_load,
            commands::plugins_toggle,
            commands::plugins_install,
            commands::plugins_install_local,
            commands::plugins_uninstall,
            commands::plugin_fs_read,
            commands::plugin_fs_write,
            commands::plugin_fs_list,
            commands::plugin_fs_exists,
            commands::plugin_fs_create_dir,
            commands::plugin_window_create,
            commands::config_select_folder,
            commands::system_install_cli,
            commands::ssh_parse_command,
            commands::ai_translate,
            commands::ai_translate_stream,
            commands::ai_check_ollama,
            commands::ai_get_ollama_models,
            commands::ai_get_provider_models,
            commands::ai_agent_run,
            commands::ai_agent_stop,
            commands::ai_agent_checkpoint_respond,
            commands::ai_agent_whitelist_command,
            commands::ai_clear_brain_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

