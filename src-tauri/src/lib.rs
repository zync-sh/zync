mod ai;
mod atomic_io;
mod commands;
mod fs;
mod ghost;
pub mod plugins;
mod pty;
mod session;
mod shell_icons;
mod snippets;
mod ssh;
mod ssh_config;
mod ssh_parser;
mod sync;
pub mod tunnel;
mod types;
mod utils;
mod vault;

use commands::AppState;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Release builds only: dev (`tauri dev`) shares the same app identifier as the
    // installed app, so single-instance would focus the production window instead of
    // launching the dev instance.
    let builder = {
        #[cfg_attr(debug_assertions, allow(unused_mut))]
        let mut builder = tauri::Builder::default();
        #[cfg(all(desktop, not(debug_assertions)))]
        {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }));
        }
        builder
    };

    builder
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

            let app_handle = app.handle().clone();
            let data_dir = commands::get_data_dir(&app_handle);
            let app_state = AppState::new(data_dir.clone(), app_handle.clone());
            app.manage(app_state);
            app.manage(tokio::sync::Mutex::new(vault::store::VaultService::new(
                data_dir,
            )));
            commands::cleanup_stale_plugin_window_temp_files(&app_handle);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                let _ = webview.window().show();
            }
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Cancel all active agent runs so backend tasks don't outlive the window.
                    if window.label() == "main" {
                        if let Some(state) = window.try_state::<AppState>() {
                            let agent_runs = state.agent_runs.clone();
                            tauri::async_runtime::block_on(async move {
                                let runs = agent_runs.lock().await;
                                for cancel in runs.values() {
                                    cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                                }
                            });
                        }
                        api.prevent_close();
                        let _ = window.emit("app:request-close", ());
                    }
                }
                tauri::WindowEvent::DragDrop(drag_event) => match drag_event {
                    tauri::DragDropEvent::Enter { paths, .. } => {
                        let path_strings: Vec<String> = paths
                            .iter()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect();
                        let _ = window.emit("zync://drag-enter", path_strings);
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        let path_strings: Vec<String> = paths
                            .iter()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect();
                        let _ = window.emit("zync://file-drop", path_strings);
                    }
                    tauri::DragDropEvent::Leave => {
                        let _ = window.emit("zync://drag-leave", ());
                    }
                    _ => {}
                },
                tauri::WindowEvent::Destroyed => {
                    commands::cleanup_plugin_window_temp_file(window.label());
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
            commands::ssh_disconnect_vault_backed,
            commands::terminal_write,
            commands::terminal_navigate,
            commands::terminal_resize,
            commands::terminal_create,
            commands::terminal_close,
            commands::terminal_has_active_processes,
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
            commands::settings_get_path,
            commands::settings_read_raw,
            commands::settings_write_raw,
            commands::settings_restore_last_known_good,
            commands::sftp_put,
            commands::sftp_get,
            commands::sftp_copy_to_server,
            commands::sftp_cancel_transfer,
            commands::sftp_download_as_zip,
            commands::shell_open,
            commands::shell_get_wsl_distros,
            commands::shell_get_windows_shells,
            commands::shell_get_available_shells,
            commands::shell_get_connection_shells,
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
            ghost::commands::ghost_commit,
            ghost::commands::ghost_suggest,
            ghost::commands::ghost_accept,
            ghost::commands::ghost_candidates,
            session::session_load,
            session::session_save,
            vault::commands::vault_status,
            vault::commands::vault_initialize,
            vault::commands::vault_unlock,
            vault::commands::vault_forget_device,
            vault::commands::vault_lock,
            vault::commands::vault_item_create,
            vault::commands::vault_item_list,
            vault::commands::vault_item_get,
            vault::commands::vault_item_update,
            vault::commands::vault_item_delete,
            vault::commands::vault_item_revision_history,
            vault::commands::vault_item_restore_revision,
            vault::commands::vault_secure_to_vault_preview,
            vault::commands::vault_secure_to_vault,
            vault::commands::vault_backfill_connection_refs,
            vault::commands::vault_generate_recovery_key,
            vault::commands::vault_has_recovery_key,
            vault::commands::vault_unlock_with_recovery_key,
            vault::commands::vault_export,
            vault::commands::vault_import,
            sync::commands::sync_status,
            sync::commands::sync_collection_status,
            sync::commands::sync_collection_discover_remote,
            sync::commands::sync_collection_setup,
            sync::commands::sync_collection_unlock,
            sync::commands::sync_collection_regenerate_recovery_key,
            sync::commands::sync_collection_lock,
            sync::commands::sync_collection_forget_key,
            sync::commands::sync_collection_set_cache_ttl,
            sync::commands::sync_domain_policies,
            sync::commands::sync_domain_policy_set,
            sync::commands::sync_hosts_snapshot,
            sync::commands::sync_hosts_changes,
            sync::commands::sync_hosts_upload,
            sync::commands::sync_hosts_remote_inventory,
            sync::commands::sync_hosts_restore,
            sync::commands::sync_connections_restore,
            sync::commands::sync_connections_restore_preview,
            sync::commands::sync_tunnels_snapshot,
            sync::commands::sync_tunnels_upload,
            sync::commands::sync_tunnels_restore,
            sync::commands::sync_snippets_snapshot,
            sync::commands::sync_snippets_upload,
            sync::commands::sync_snippets_restore,
            sync::commands::sync_settings_upload,
            sync::commands::sync_settings_restore,
            sync::commands::sync_connect,
            sync::commands::sync_disconnect,
            sync::commands::sync_upload,
            sync::commands::sync_upload_credential,
            sync::commands::sync_upload_credentials,
            sync::commands::sync_restore_preview,
            sync::commands::sync_restore_credentials,
            sync::commands::sync_download,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
