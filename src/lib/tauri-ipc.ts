import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { check } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';
import { createUpdaterIpcHandler } from '../features/updater/updaterIpcCore';

const updaterIpc = createUpdaterIpcHandler({
  check,
  invoke,
  dispatchEvent: (name, detail) => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  },
});

// Map to track active listeners for cleanup
interface ListenerRegistration {
  unlisten: UnlistenFn;
  unsubscribed: boolean;
}
const eventListeners = new Map<string, Map<Function, ListenerRegistration>>();
const PENDING_UNLISTEN: UnlistenFn = () => { };
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasConnectionId = (
  value: unknown,
): value is Record<string, unknown> & { connectionId: unknown } =>
  value !== null && typeof value === 'object' && 'connectionId' in value;

// Tauri IPC wrapper to replace Electron's ipcRenderer
const ipcRenderer = {
  send(channel: string, ...args: any[]): void {
    // In Tauri, send() is replaced with invoke() since there's no fire-and-forget
    // We'll call invoke but not wait for the result
    const channelMap: Record<string, string> = {
      'terminal:write': 'terminal_write',
      'terminal:resize': 'terminal_resize',
      'terminal:kill': 'terminal_close',
    };

    const tauriCommand = channelMap[channel] || channel.replace(':', '_');
    const payload = args.length === 1 ? args[0] : { args };

    invoke(tauriCommand, payload).catch((error) => {
      console.error(`Tauri send() failed for ${channel} (${tauriCommand}):`, error);
    });
  },

  on(channel: string, listener: (event: any, ...args: any[]) => void): () => void {
    // Tauri uses events instead of IPC channels
    const channelListeners = eventListeners.get(channel) ?? new Map<Function, ListenerRegistration>();
    eventListeners.set(channel, channelListeners);
    const previousRegistration = channelListeners.get(listener);
    if (previousRegistration) {
      previousRegistration.unsubscribed = true;
      if (previousRegistration.unlisten !== PENDING_UNLISTEN) {
        previousRegistration.unlisten();
      }
      channelListeners.delete(listener);
    }

    const registration: ListenerRegistration = { unlisten: PENDING_UNLISTEN, unsubscribed: false };
    const localRegistration = registration;
    channelListeners.set(listener, localRegistration);

    const setupListener = async () => {
      try {
        const unlisten = await listen(channel, (event) => {
          // Map Tauri event { event: string, windowLabel: string, payload: T }
          // to Electron-like style (event wrapper, payload)
          listener({ sender: null }, event.payload);
        });

        if (localRegistration.unsubscribed) {
          unlisten();
          if (channelListeners.get(listener) === localRegistration) {
            channelListeners.delete(listener);
          }
          return unlisten;
        }

        localRegistration.unlisten = unlisten;
        if (channelListeners.get(listener) !== localRegistration) {
          unlisten();
          return unlisten;
        }

        return unlisten;
      } catch (error) {
        localRegistration.unsubscribed = true;
        if (channelListeners.get(listener) === localRegistration) {
          channelListeners.delete(listener);
        }
        console.error(`Failed to set up listener for ${channel}:`, error);
        return undefined;
      }
    };

    void setupListener();

    // Return a function that can be called to unsubscribe
    return () => {
      const current = channelListeners.get(listener);
      if (!current || current !== localRegistration || current.unsubscribed) return;
      current.unsubscribed = true;

      if (current.unlisten !== PENDING_UNLISTEN) {
        current.unlisten();
        if (channelListeners.get(listener) === localRegistration) {
          channelListeners.delete(listener);
        }
        return;
      }

      // setupListener handles pending-listen cleanup when unsubscribed=true.
    };
  },

  off(channel: string, listener: (event: any, ...args: any[]) => void): void {
    const channelListeners = eventListeners.get(channel);
    if (channelListeners && channelListeners.has(listener)) {
      const registration = channelListeners.get(listener);
      if (!registration) return;
      if (registration.unlisten === PENDING_UNLISTEN) {
        registration.unsubscribed = true;
        return;
      }
      if (registration.unlisten) {
        registration.unlisten();
        channelListeners.delete(listener);
      }
    }
  },

  async invoke(channel: string, ...args: any[]): Promise<any> {
    // Map Electron IPC channels to Tauri commands
    const channelMap: Record<string, string> = {
      'ssh:connect': 'ssh_connect',
      'ssh:cancelConnect': 'ssh_cancel_connect',
      'ssh:disconnect': 'ssh_disconnect',
      'ssh:transportLost': 'ssh_transport_lost',
      'ssh:agentSignatureRespond': 'ssh_agent_signature_respond',
      'terminal:write': 'terminal_write',
      'terminal:resize': 'terminal_resize',
      'terminal:create': 'terminal_create',
      'terminal:close': 'terminal_close',
      'terminal:has-active-processes': 'terminal_has_active_processes',
      'terminal:flush-stats': 'terminal_flush_stats',
      'connections:get': 'connections_get',
      'connections:save': 'connections_save',
      'connections:exportToFile': 'connections_export_to_file',
      'connections:importFromFile': 'connections_import_from_file',
      'fs_list': 'fs_list',
      'fs_read_file': 'fs_read_file',
      'fs_write_file': 'fs_write_file',
      'fs_cwd': 'fs_cwd',
      'fs_mkdir': 'fs_mkdir',
      'fs_rename': 'fs_rename',
      'fs_delete': 'fs_delete',
      'fs_copy': 'fs_copy',
      'fs_exists': 'fs_exists',
      'tunnel:getAll': 'tunnel_get_all',
      'tunnel:startLocal': 'tunnel_start_local',
      'tunnel:start_local': 'tunnel_start_local', // Add snake_case mapping
      'tunnel:startRemote': 'tunnel_start_remote',
      'tunnel:start_remote': 'tunnel_start_remote', // Add snake_case mapping
      'tunnel:start': 'tunnel_start',
      'tunnel:stop': 'tunnel_stop',
      'ssh:exec': 'ssh_exec',
      'ssh:connectionLatency': 'ssh_connection_latency',
      'ssh:test': 'ssh_test_connection',

      'ssh:extract-pem': 'ssh_extract_pem',
      'ssh:write-managed-key': 'ssh_write_managed_key',
      'ssh:read-local-key-file': 'ssh_read_local_key_file',
      'ssh:inspect-private-key': 'ssh_inspect_private_key',
      'ssh:private-key-readiness': 'ssh_private_key_readiness',
      'ssh:remember-key-passphrase': 'ssh_remember_key_passphrase',
      'ssh:forget-key-passphrase': 'ssh_forget_key_passphrase',
      'ssh:write-ephemeral-key': 'ssh_write_ephemeral_key',
      'ssh:delete-ephemeral-key': 'ssh_delete_ephemeral_key',
      'ssh:migrate-all-keys': 'ssh_migrate_all_keys',
      'ssh:importConfig': 'ssh_import_config',
      'ssh:importConfigFromFile': 'ssh_import_config_from_file',
      'ssh:importConfigFromText': 'ssh_import_config_from_text',
      'ssh:importConfigBySource': 'ssh_import_config_by_source',
      'ssh:readConfig': 'ssh_import_config',
      'ssh:internalize-connections': 'ssh_internalize_connections',
      'ssh:disconnectVaultBacked': 'ssh_disconnect_vault_backed',
      'sftp:put': 'sftp_put',
      'sftp:get': 'sftp_get',
      'sftp:copyToServer': 'sftp_copy_to_server',
      'sftp:cancelTransfer': 'sftp_cancel_transfer',
      'sftp:downloadAsZip': 'sftp_download_as_zip',
      'tunnel:list': 'tunnel_list',
      'tunnel:save': 'tunnel_save',
      'tunnel:delete': 'tunnel_delete',
      'tunnel:reconcileConnection': 'tunnel_reconcile_connection',
      'window:is-maximized': 'window_is_maximized',
      // Dialog commands handled specially below
      'dialog:openFile': 'dialog_open_file',
      'dialog:openDirectory': 'dialog_open_directory',
      'config:select-folder': 'config_select_folder',
      'shell:open': 'shell_open',
      'shell:getWslDistros': 'shell_get_wsl_distros',
      'read_wsl_zsh_init_files': 'read_wsl_zsh_init_files',
      'wsl_get_cwd': 'wsl_get_cwd',
      'fs_list_wsl': 'fs_list_wsl',
      'shell:getWindowsShells': 'shell_get_windows_shells',
      'shell:getAvailableShells': 'shell_get_available_shells',
      'shell:getConnectionShells': 'shell_get_connection_shells',
      'plugins:load': 'plugins_load',
      'plugins:developer_mode_get': 'plugins_developer_mode_get',
      'plugins:developer_mode_set': 'plugins_developer_mode_set',
      'plugins:registry_load': 'plugins_registry_load',
      'plugins:beta_plugins_get': 'plugins_beta_plugins_get',
      'plugins:beta_plugin_set': 'plugins_beta_plugin_set',
      'plugins:inspect_local': 'plugins_inspect_local',
      'plugins:inspect_marketplace': 'plugins_inspect_marketplace',
      'plugins:install_inspected': 'plugins_install_inspected',
      'plugins:commit_activation': 'plugins_commit_activation',
      'plugins:rollback_activation': 'plugins_rollback_activation',
      'plugins:rollback_version': 'plugins_rollback_version',
      'plugins:discard_inspection': 'plugins_discard_inspection',
      'plugins:runtime_start': 'plugins_runtime_start',
      'plugins:runtime_authorize': 'plugins_runtime_authorize',
      'plugins:runtime_register_command': 'plugins_runtime_register_command',
      'plugins:runtime_register_pane': 'plugins_runtime_register_pane',
      'plugins:storage_get': 'plugins_storage_get',
      'plugins:storage_keys': 'plugins_storage_keys',
      'plugins:storage_set': 'plugins_storage_set',
      'plugins:storage_delete': 'plugins_storage_delete',
      'plugins:filesystem_pick': 'plugins_filesystem_pick',
      'plugins:filesystem_pick_write_file': 'plugins_filesystem_pick_write_file',
      'plugins:filesystem_read_text': 'plugins_filesystem_read_text',
      'plugins:filesystem_write_text': 'plugins_filesystem_write_text',
      'plugins:filesystem_list': 'plugins_filesystem_list',
      'plugins:runtime_bind_pane': 'plugins_runtime_bind_pane',
      'plugins:runtime_unbind_pane': 'plugins_runtime_unbind_pane',
      'plugins:ssh_filesystem_list': 'plugins_ssh_filesystem_list',
      'plugins:ssh_command_execute': 'plugins_ssh_command_execute',
      'plugins:ssh_filesystem_read_text': 'plugins_ssh_filesystem_read_text',
      'plugins:runtime_stop': 'plugins_runtime_stop',
      'plugins:runtime_reset': 'plugins_runtime_reset',
      'plugins:network_fetch': 'plugins_network_fetch',
      'plugins:recovery_status': 'plugins_recovery_status',
      'plugins:recovery_record_failure': 'plugins_recovery_record_failure',
      'plugins:recovery_clear_safe_mode': 'plugins_recovery_clear_safe_mode',
      'plugins:recovery_clear_plugin_failures': 'plugins_recovery_clear_plugin_failures',
      'plugins:management_details': 'plugins_management_details',
      'plugins:runtime_optional_permission': 'plugins_runtime_optional_permission',
      'plugins:management_set_optional_permissions': 'plugins_management_set_optional_permissions',
      'plugins:management_clear_storage': 'plugins_management_clear_storage',
      'app:getExeDir': 'app_get_exe_dir',
      'app:relaunch': 'app_relaunch',
      'app:exit': 'app_exit',
      'ai:translate': 'ai_translate',
      'ai:checkOllama': 'ai_check_ollama',
    };

    const tauriCommand = channelMap[channel] || channel.replace(':', '_');

    try {
      // Handle Dialog commands locally via plugin
      if (channel === 'dialog:openFile') {
        const result = await dialogOpen({
          multiple: true,
          directory: false,
        });
        // Electron expects { filePaths: string[], canceled: boolean }
        if (result === null) return { filePaths: [], canceled: true };
        const paths = Array.isArray(result) ? result : [result];
        return { filePaths: paths, canceled: false };
      }

      if (channel === 'dialog:openDirectory') {
        const payload = args.length === 1 && args[0] && typeof args[0] === 'object' ? args[0] : {};
        const result = await dialogOpen({
          multiple: false,
          directory: true,
          defaultPath: payload.defaultPath,
        });
        if (result === null) return { filePaths: [], canceled: true };
        const paths = Array.isArray(result) ? result : [result];

        return { filePaths: paths, canceled: false };
      }

      if (channel === 'dialog:saveFile') {
        const payload = args.length === 1 ? args[0] : {};
        const result = await dialogSave({
          defaultPath: payload.defaultPath,
          filters: payload.filters,
        });
        if (result === null) return { filePath: null, canceled: true };
        return { filePath: result, canceled: false };
      }

      // App & Updater Handlers
      if (channel === 'config:get') {
        try {
          const settings = await invoke('settings_get');
          // Return settings with isConfigured flag for legacy compatibility
          const hasKeys = settings && typeof settings === 'object' && Object.keys(settings).length > 0;
          return { ...(settings as object), isConfigured: hasKeys };
        } catch (e) {
          console.error('config:get failed', e);
          return { isConfigured: false };
        }
      }

      if (channel === 'config:set') {
        // Backend-side merge: send patch only and let Rust merge+validate.
        const patch = args[0];
        if (!isPlainObject(patch)) {
          const receivedType = patch === null ? 'null' : Array.isArray(patch) ? 'array' : typeof patch;
          const message = `config:set expects a plain object patch, received ${receivedType}`;
          console.error(message, { receivedType });
          throw new Error(message);
        }
        return await invoke('settings_set', {
          settings: patch,
        });
      }

      if (channel === 'app:getVersion') {
        try {
          return await getVersion();
        } catch (e) {
          console.warn('Failed to get version:', e);
          return '2.0.0'; // Fallback
        }
      }

      if (channel === 'app:isAppImage') {
        // Simple heuristic for now, or returns false
        return false;
      }

      if (channel === 'update:check') {
        return await updaterIpc.handleCheck();
      }

      if (channel === 'update:download') {
        return await updaterIpc.handleDownload();
      }

      if (channel === 'update:install') {
        return await updaterIpc.handleInstall();
      }

      if (channel === 'app:relaunch') {
        return await invoke('app_relaunch');
      }

      // Tauri invoke expects a single object as the argument with named keys
      let payload = args.length === 1 && args[0] !== null && typeof args[0] === 'object' ? args[0] : { args };

      // Manual argument mapping for mismatched commands
      if (tauriCommand === 'ssh_connect' || tauriCommand === 'ssh_test_connection') {
        payload = { config: args[0] };
      } else if (
        tauriCommand === 'ssh_disconnect'
        || tauriCommand === 'ssh_transport_lost'
        || tauriCommand === 'ssh_connection_latency'
      ) {
        payload = { id: args[0] };
      } else if (tauriCommand === 'ssh_cancel_connect') {
        if (args.length === 1 && hasConnectionId(args[0])) {
          payload = { id: args[0].connectionId, attemptId: args[0].attemptId ?? null };
        } else {
          payload = { id: args[0], attemptId: args[1] ?? null };
        }
      } else if (tauriCommand === 'ssh_exec') {
        // Handle both object style {connectionId, command} and positional args
        if (args.length === 1 && hasConnectionId(args[0])) {
          payload = { connectionId: args[0].connectionId, command: args[0].command };
        } else {
          payload = { connectionId: args[0], command: args[1] };
        }
      } else if (
        tauriCommand === 'fs_list_wsl'
        || tauriCommand === 'wsl_get_cwd'
        || tauriCommand === 'read_wsl_zsh_init_files'
      ) {
        if (args.length === 1 && typeof args[0] === 'object') {
          payload = args[0];
        }
      } else if (tauriCommand === 'fs_list' || tauriCommand === 'fs_read_file' || tauriCommand === 'fs_mkdir' || tauriCommand === 'fs_delete' || tauriCommand === 'fs_exists') {
        if (args.length === 1 && hasConnectionId(args[0])) {
          payload = args[0]; // Already has camelCase keys { connectionId, path }
        } else {
          payload = { connectionId: args[0], path: args[1] };
        }
      } else if (tauriCommand === 'fs_write_file') {
        if (args.length === 1 && hasConnectionId(args[0])) {
          payload = args[0];
        } else {
          payload = { connectionId: args[0], path: args[1], content: args[2] };
        }
      } else if (tauriCommand === 'fs_rename') {
        if (args.length === 1 && hasConnectionId(args[0])) {
          payload = args[0]; // { connectionId, oldPath, newPath }
        } else {
          payload = { connectionId: args[0], oldPath: args[1], newPath: args[2] };
        }
      } else if (tauriCommand === 'fs_copy') {
        if (args.length === 1 && hasConnectionId(args[0])) {
          payload = args[0]; // { connectionId, from, to }
        } else {
          payload = { connectionId: args[0], from: args[1], to: args[2] };
        }
      } else if (tauriCommand === 'tunnel_list') {
        if (args.length === 1 && typeof args[0] === 'string') {
          payload = { connectionId: args[0] };
        } else if (args.length === 1 && hasConnectionId(args[0])) {
          payload = { connectionId: args[0].connectionId };
        }
      } else if (tauriCommand === 'tunnel_reconcile_connection') {
        if (args.length === 1 && typeof args[0] === 'string') {
          payload = { connection_id: args[0] };
        } else if (args.length === 1 && isPlainObject(args[0])) {
          const arg = args[0] as { connectionId?: string; connection_id?: string };
          payload = { connection_id: arg.connection_id ?? arg.connectionId };
        }
      } else if (tauriCommand === 'tunnel_save') {
        payload = { tunnelVal: args[0] };
      } else if (tauriCommand === 'tunnel_delete') {
        if (args.length === 1 && typeof args[0] === 'string') {
          payload = { id: args[0] };
        } else if (args.length === 2) {
          payload = { id: args[0] };
        }
      } else if (tauriCommand === 'tunnel_start_local') {
        // Handle both object style (from some paths) and positional args (from TunnelManager)
        if (args.length === 1 && hasConnectionId(args[0])) {
          const arg = args[0];
          payload = {
            connectionId: arg.connectionId,
            localPort: arg.localPort,
            remoteHost: arg.remoteHost,
            remotePort: arg.remotePort
          };
        } else if (args.length >= 4) {
          // From TunnelManager: connectionId, localPort, remoteHost, remotePort
          payload = {
            connectionId: args[0],
            localPort: args[1],
            remoteHost: args[2],
            remotePort: args[3]
          };
        }
      } else if (tauriCommand === 'tunnel_start_remote') {
        if (args.length === 1 && hasConnectionId(args[0])) {
          const arg = args[0];
          payload = {
            connectionId: arg.connectionId,
            remotePort: arg.remotePort,
            localHost: arg.localHost,
            localPort: arg.localPort
          };
        } else if (args.length >= 4) {
          // From TunnelManager: connectionId, remotePort, localHost, localPort
          payload = {
            connectionId: args[0],
            remotePort: args[1],
            localHost: args[2],
            localPort: args[3]
          };
        }

      } else if (tauriCommand === 'tunnel_start' || tauriCommand === 'tunnel_stop') {
        payload = { id: args[0] };
      } else if (tauriCommand === 'fs_cwd') {
        if (args.length === 1 && hasConnectionId(args[0])) {
          payload = { connectionId: args[0].connectionId };
        } else {
          payload = { connectionId: args[0] };
        }
      } else if (tauriCommand === 'ssh_extract_pem') {
        payload = { path: args[0] };
      } else if (tauriCommand === 'ssh_write_managed_key') {
        const first = args[0];
        if (first && typeof first === 'object' && 'content' in first) {
          payload = { request: first };
        } else {
          payload = { request: { content: args[0], suggestedName: args[1] ?? null } };
        }
      } else if (tauriCommand === 'ssh_read_local_key_file') {
        payload = { path: args[0] };
      } else if (tauriCommand === 'ssh_inspect_private_key') {
        payload = { request: args[0] };
      } else if (tauriCommand === 'ssh_private_key_readiness') {
        payload = { path: args[0] };
      } else if (tauriCommand === 'ssh_remember_key_passphrase') {
        payload = { request: args[0] };
      } else if (tauriCommand === 'ssh_forget_key_passphrase') {
        payload = { path: args[0] };
      } else if (tauriCommand === 'ssh_write_ephemeral_key') {
        const first = args[0];
        if (first && typeof first === 'object' && 'content' in first) {
          payload = first;
        } else {
          payload = { content: args[0] };
        }
      } else if (tauriCommand === 'ssh_delete_ephemeral_key') {
        payload = { path: args[0] };
      } else if (tauriCommand === 'shell_open') {
        payload = { path: args[0] };
      } else if (tauriCommand === 'ssh_import_config_from_file') {
        payload = { path: args[0] };
      } else if (tauriCommand === 'ssh_import_config_from_text') {
        payload = { content: args[0] };
      } else if (tauriCommand === 'ssh_import_config_by_source') {
        payload = { request: args[0] };
      } else if (tauriCommand === 'ssh_migrate_all_keys') {
        payload = {};
      } else if (tauriCommand === 'ssh_disconnect_vault_backed') {
        payload = {};
      } else if (tauriCommand === 'connections_export_to_file' || tauriCommand === 'connections_import_from_file') {
        payload = { request: args[0] };
      }

      return await invoke(tauriCommand, payload);
    } catch (error) {
      console.error(`Tauri invoke failed for ${channel} (${tauriCommand}):`, error);
      throw error;
    }
  },

};

// Platform detection
const platform = typeof navigator !== 'undefined'
  ? (navigator.platform.toLowerCase().includes('mac') ? 'darwin' :
    navigator.platform.toLowerCase().includes('win') ? 'win32' : 'linux')
  : 'linux';

const electronUtils = {
  getPathForFile(file: File): string {
    // In Tauri, we'll handle file paths differently
    // For now, return a placeholder
    return (file as any).path || '';
  },
  platform,
};

// Extend window object
declare global {
  interface Window {
    ipcRenderer: typeof ipcRenderer;
    electronUtils: typeof electronUtils;
  }
}

if (typeof window !== 'undefined') {
  window.ipcRenderer = ipcRenderer;
  window.electronUtils = electronUtils;
}

export { ipcRenderer, electronUtils };
