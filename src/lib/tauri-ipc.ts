import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { check } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';

let currentUpdate: any = null;

// Map to track active listeners for cleanup
const eventListeners = new Map<string, Map<Function, UnlistenFn>>();

// Progress tracking state
let downloadState = {
  downloaded: 0,
  total: 0
};

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
    const unsubscribe = async () => {
      const unlisten = await listen(channel, (event) => {
        // Map Tauri event { event: string, windowLabel: string, payload: T } 
        // to Electron-like style (event wrapper, payload)
        listener({ sender: null }, event.payload);
      });

      if (!eventListeners.has(channel)) {
        eventListeners.set(channel, new Map());
      }
      eventListeners.get(channel)!.set(listener, unlisten);

      return unlisten;
    };

    const unlistenPromise = unsubscribe();

    // Return a function that can be called to unsubscribe
    return () => {
      unlistenPromise.then(unlisten => {
        unlisten();
        eventListeners.get(channel)?.delete(listener);
      });
    };
  },

  off(channel: string, listener: (event: any, ...args: any[]) => void): void {
    const channelListeners = eventListeners.get(channel);
    if (channelListeners && channelListeners.has(listener)) {
      const unlisten = channelListeners.get(listener);
      if (unlisten) {
        unlisten();
        channelListeners.delete(listener);
      }
    }
  },

  async invoke(channel: string, ...args: any[]): Promise<any> {
    // Map Electron IPC channels to Tauri commands
    const channelMap: Record<string, string> = {
      'ssh:connect': 'ssh_connect',
      'ssh:disconnect': 'ssh_disconnect',
      'terminal:write': 'terminal_write',
      'terminal:resize': 'terminal_resize',
      'terminal:create': 'terminal_create',
      'terminal:close': 'terminal_close',
      'connections:get': 'connections_get',
      'connections:save': 'connections_save',
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
      'tunnel:startRemote': 'tunnel_start_remote',
      'tunnel:stop': 'tunnel_stop',
      'ssh:exec': 'ssh_exec',
      'ssh:test': 'ssh_test_connection',
      'ssh:extract-pem': 'ssh_extract_pem',
      'ssh:migrate-all-keys': 'ssh_migrate_all_keys',
      'ssh:importConfig': 'ssh_import_config',
      'ssh:readConfig': 'ssh_import_config',
      'sftp:put': 'sftp_put',
      'tunnel:list': 'tunnel_list',
      'tunnel:save': 'tunnel_save',
      'tunnel:delete': 'tunnel_delete',
      'window:is-maximized': 'window_is_maximized',
      // Dialog commands handled specially below
      'dialog:openFile': 'dialog_open_file',
      'dialog:openDirectory': 'dialog_open_directory',
      'config:set': 'settings_set',
      'shell:open': 'shell_open',
    };

    const tauriCommand = channelMap[channel] || channel.replace(':', '_');

    try {
      // Handle Dialog commands locally via plugin
      if (channel === 'dialog:openFile') {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const result = await open({
          multiple: true,
          directory: false,
        });
        // Electron expects { filePaths: string[], canceled: boolean }
        if (result === null) return { filePaths: [], canceled: true };
        const paths = Array.isArray(result) ? result : [result];
        return { filePaths: paths, canceled: false };
      }

      if (channel === 'dialog:openDirectory') {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const result = await open({
          multiple: false,
          directory: true,
        });
        if (result === null) return { filePaths: [], canceled: true };
        const paths = Array.isArray(result) ? result : [result];

        return { filePaths: paths, canceled: false };
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
        try {
          const update = await check();
          if (update?.available) {
            currentUpdate = update;
            return {
              updateInfo: {
                version: update.version,
                body: update.body,
                date: update.date
              }
            };
          }
          return null;
        } catch (e) {
          console.error('Update check error:', e);
          throw e;
        }
      }

      if (channel === 'update:download') {
        if (currentUpdate) {
          // Reset state
          downloadState = { downloaded: 0, total: 0 };

          // We use downloadAndInstall because it handles the specific flow better
          // But 'download' gives us more granular control if we want subsequent install
          await currentUpdate.downloadAndInstall((event: any) => {
            try {
              if (event.event === 'Started') {
                downloadState.total = event.data.contentLength || 0;
                downloadState.downloaded = 0;
                // Emit started event
                window.dispatchEvent(new CustomEvent('zync:update-progress', { detail: { percent: 0, status: 'started' } }));
              } else if (event.event === 'Progress') {
                downloadState.downloaded += event.data.chunkLength;
                let percent = 0;
                if (downloadState.total > 0) {
                  percent = (downloadState.downloaded / downloadState.total) * 100;
                }
                // Cap at 100
                percent = Math.min(100, percent);
                window.dispatchEvent(new CustomEvent('zync:update-progress', { detail: { percent, status: 'progress' } }));
              } else if (event.event === 'Finished') {
                window.dispatchEvent(new CustomEvent('zync:update-progress', { detail: { percent: 100, status: 'finished' } }));
              }
            } catch (err) {
              console.error('Error in download callback:', err);
            }
          });
        }
        return;
      }

      if (channel === 'update:install') {
        if (currentUpdate && typeof currentUpdate.install === 'function') {
          await currentUpdate.install();
        } else {
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        }
        return;
      }

      // Tauri invoke expects a single object as the argument with named keys
      let payload = args.length === 1 && typeof args[0] === 'object' ? args[0] : { args };

      // Manual argument mapping for mismatched commands
      if (tauriCommand === 'ssh_connect' || tauriCommand === 'ssh_test_connection') {
        payload = { config: args[0] };
      } else if (tauriCommand === 'ssh_disconnect') {
        payload = { id: args[0] };
      } else if (tauriCommand === 'ssh_exec') {
        // Handle both object style {connectionId, command} and positional args
        if (args.length === 1 && typeof args[0] === 'object' && 'connectionId' in args[0]) {
          payload = { connectionId: args[0].connectionId, command: args[0].command };
        } else {
          payload = { connectionId: args[0], command: args[1] };
        }
      } else if (tauriCommand === 'fs_list' || tauriCommand === 'fs_read_file' || tauriCommand === 'fs_mkdir' || tauriCommand === 'fs_delete' || tauriCommand === 'fs_exists') {
        if (args.length === 1 && typeof args[0] === 'object' && 'connectionId' in args[0]) {
          payload = args[0]; // Already has camelCase keys { connectionId, path }
        } else {
          payload = { connectionId: args[0], path: args[1] };
        }
      } else if (tauriCommand === 'fs_write_file') {
        if (args.length === 1 && typeof args[0] === 'object' && 'connectionId' in args[0]) {
          payload = args[0];
        } else {
          payload = { connectionId: args[0], path: args[1], content: args[2] };
        }
      } else if (tauriCommand === 'fs_rename') {
        if (args.length === 1 && typeof args[0] === 'object' && 'connectionId' in args[0]) {
          payload = args[0]; // { connectionId, oldPath, newPath }
        } else {
          payload = { connectionId: args[0], oldPath: args[1], newPath: args[2] };
        }
      } else if (tauriCommand === 'fs_copy') {
        if (args.length === 1 && typeof args[0] === 'object' && 'connectionId' in args[0]) {
          payload = args[0]; // { connectionId, from, to }
        } else {
          payload = { connectionId: args[0], from: args[1], to: args[2] };
        }
      } else if (tauriCommand === 'tunnel_list') {
        if (args.length === 1 && typeof args[0] === 'string') {
          payload = { connectionId: args[0] };
        } else if (args.length === 1 && typeof args[0] === 'object' && 'connectionId' in args[0]) {
          payload = { connectionId: args[0].connectionId };
        }
      } else if (tauriCommand === 'tunnel_save') {
        payload = { tunnel: args[0] };
      } else if (tauriCommand === 'tunnel_delete') {
        if (args.length === 1 && typeof args[0] === 'string') {
          payload = { id: args[0] };
        } else if (args.length === 2) {
          payload = { id: args[0] };
        }
      } else if (tauriCommand === 'tunnel_start') {
        payload = { id: args[0] };
      } else if (tauriCommand === 'tunnel_stop') {
        payload = { id: args[0] };
      } else if (tauriCommand === 'fs_cwd') {
        if (args.length === 1 && typeof args[0] === 'object' && 'connectionId' in args[0]) {
          payload = { connectionId: args[0].connectionId };
        } else {
          payload = { connectionId: args[0] };
        }
      } else if (tauriCommand === 'ssh_extract_pem') {
        payload = { path: args[0] };
      } else if (tauriCommand === 'shell_open') {
        payload = { path: args[0] };
      }

      if (tauriCommand === 'ssh_migrate_all_keys') {
        payload = {};
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
