import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserWindow, ipcMain } from 'electron';
import { type SSHConfig, sshManager } from './ssh-manager';

const execPromise = promisify(exec);

import { settingsManager } from './settings-manager';
import { sftpManager } from './sftp-manager';
import { sshShellManager } from './shell-manager';
import { type Snippet, snippetManager } from './snippets-manager';
import { SSHConfigParser } from './ssh-config-parser';
import { type TunnelConfig, tunnelManager } from './tunnel-manager';

export function setupIPC() {
  // Snippets Operations
  ipcMain.handle('snippets:getAll', async () => {
    return snippetManager.getAll();
  });

  ipcMain.handle('snippets:save', async (_, snippet: Snippet) => {
    return snippetManager.save(snippet);
  });

  ipcMain.handle('snippets:delete', async (_, id: string) => {
    snippetManager.delete(id);
    return { success: true };
  });

  // Tunnel Operations
  ipcMain.handle('tunnel:start', async (_, id: string) => {
    try {
      const config = tunnelManager.getTunnelConfig(id);
      if (!config) throw new Error('Tunnel not found');

      const client = sshManager.getClient(config.connectionId);
      if (!client) throw new Error('SSH Client not connected');

      await tunnelManager.startTunnel(client, id);
      return { success: true };
    } catch (e: any) {
      console.error('Tunnel Start Error', e);
      throw e;
    }
  });

  ipcMain.handle('tunnel:stop', async (_, id: string) => {
    await tunnelManager.stopTunnel(id);
    return { success: true };
  });

  ipcMain.handle('tunnel:save', async (_, config: TunnelConfig) => {
    return tunnelManager.saveTunnel(config);
  });

  ipcMain.handle('tunnel:delete', async (_, id: string) => {
    tunnelManager.deleteTunnel(id);
    return { success: true };
  });

  ipcMain.handle('tunnel:list', async (_, connectionId: string) => {
    return tunnelManager.getTunnelsForConnection(connectionId);
  });

  // Settings Operations
  ipcMain.handle('settings:get', async () => {
    return settingsManager.getSettings();
  });

  ipcMain.handle('settings:set', async (_, settings) => {
    settingsManager.setSettings(settings); // Replaces or merges? electron-store set(obj) merges top-level? No, set(object) sets multiple items.
    // But Store.set(obj) usually merges?
    // Let's rely on setSettings impl from manager.
    // Actually better to handle update.
    // For simplicity, we expect full object or partial.
    // electron-store .set(object) merges.
    settingsManager.setSettings(settings);
    return { success: true };
  });

  // SSH Session Management
  ipcMain.handle('ssh:connect', async (_, config: SSHConfig) => {
    console.log('[IPC] ssh:connect called for:', config.id);
    // Connect SSH first (terminal)
    await sshManager.connect(config);

    try {
      // Then connect SFTP (file manager)
      // Sequential execution prevents potential race conditions or auth rate limiting on some servers
      await sftpManager.connect(config);
    } catch (error: any) {
      console.error('SFTP Connection Failed (proceeding with Terminal only):', error);
      // Do NOT disconnect SSH. Allow terminal usage even if SFTP is disabled/failed.
      // sshManager.disconnect(config.id);
    }

    console.log('[IPC] ssh:connect completed for:', config.id);
    return { success: true };
  });

  ipcMain.handle('ssh:disconnect', async (_, id: string) => {
    console.log('[IPC] ssh:disconnect called for:', id);
    sshManager.disconnect(id);
    await sftpManager.disconnect(id);
    return { success: true };
  });

  ipcMain.handle('ssh:exec', async (_, { id, command }) => {
    if (id === 'local') {
      try {
        const { stdout } = await execPromise(command);
        return stdout;
      } catch (error: any) {
        // If the command fails (non-zero exit), we might still want stdout or stderr?
        // SSH exec usually throws on failure.
        throw new Error(`Local command failed: ${error.message}`);
      }
    }
    return sshManager.execCommand(id, command);
  });

  ipcMain.handle('ssh:status', async (_, id: string) => {
    const isAlive = !!sshManager.getClient(id);
    console.log(`[IPC] ssh:status check for ${id}: ${isAlive}`);
    return isAlive;
  });

  // SFTP Operations
  ipcMain.handle('sftp:list', async (_, { id, path }) => {
    return sftpManager.list(id, path);
  });

  ipcMain.handle('sftp:cwd', async (_, { id }) => {
    return sftpManager.cwd(id);
  });

  ipcMain.handle('sftp:get', async (_, { id, remotePath, localPath }) => {
    // Download
    return sftpManager.get(id, remotePath, localPath);
  });

  ipcMain.handle('sftp:put', async (_, { id, localPath, remotePath }) => {
    // Upload
    return sftpManager.put(id, localPath, remotePath);
  });

  ipcMain.handle('sftp:mkdir', async (_, { id, path }) => {
    return sftpManager.mkdir(id, path);
  });

  ipcMain.handle('sftp:delete', async (_, { id, path }) => {
    return sftpManager.delete(id, path);
  });

  ipcMain.handle('sftp:rename', async (_, { id, oldPath, newPath }) => {
    return sftpManager.rename(id, oldPath, newPath);
  });

  ipcMain.handle('sftp:readFile', async (_, { id, path }) => {
    return sftpManager.readFile(id, path);
  });

  ipcMain.handle('sftp:writeFile', async (_, { id, path, content }) => {
    return sftpManager.writeFile(id, path, content);
  });

  ipcMain.handle(
    'sftp:copyToServer',
    async (event, { sourceConnectionId, sourcePath, destinationConnectionId, destinationPath, transferId }) => {
      return sftpManager.copyBetweenServers(
        sourceConnectionId,
        sourcePath,
        destinationConnectionId,
        destinationPath,
        (transferred, total) => {
          event.sender.send('transfer:progress', {
            transferred,
            total,
            percentage: (transferred / total) * 100,
            sourcePath,
            transferId,
          });
        },
        transferId,
      );
    },
  );

  ipcMain.handle('sftp:cancelTransfer', async (_, { transferId }) => {
    return sftpManager.cancelTransfer(transferId);
  });

  // Native Dialogs
  const { dialog } = require('electron');

  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
    });
    return result;
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    return result;
  });

  ipcMain.handle('dialog:saveFile', async (_, defaultPath) => {
    const result = await dialog.showSaveDialog({ defaultPath });
    return result;
  });

  // Terminal Operations
  ipcMain.handle('terminal:spawn', async (event, { connectionId, termId, rows, cols }) => {
    console.log(`[IPC] terminal:spawn called for: ${connectionId} (termId: ${termId})`);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false };
    try {
      await sshShellManager.spawn(connectionId, termId, rows, cols, win);
      return { success: true };
    } catch (error: any) {
      console.error('[IPC] terminal:spawn failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on('terminal:write', (_, { termId, data }) => {
    sshShellManager.write(termId, data);
  });

  ipcMain.on('terminal:resize', (_, { termId, rows, cols }) => {
    sshShellManager.resize(termId, rows, cols);
  });

  ipcMain.on('terminal:kill', (_, { termId }) => {
    sshShellManager.kill(termId);
  });

  // Key Management
  ipcMain.handle('ssh:importKey', async (_, filePath: string) => {
    const { app } = require('electron');
    const fs = require('node:fs');
    const path = require('node:path');

    try {
      const userDataPath = app.getPath('userData');
      const keysDir = path.join(userDataPath, 'keys');

      if (!fs.existsSync(keysDir)) {
        fs.mkdirSync(keysDir, { recursive: true });
      }

      const fileName = path.basename(filePath);
      const destPath = path.join(keysDir, fileName);

      // Copy file
      fs.copyFileSync(filePath, destPath);

      // Set stricter permissions for key file (0o600)
      if (process.platform !== 'win32') {
        fs.chmodSync(destPath, 0o600);
      }

      return destPath;
    } catch (error: any) {
      console.error('Failed to import key:', error);
      throw error;
    }
  });

  ipcMain.handle('ssh:readConfig', async () => {
    try {
      const parser = new SSHConfigParser();
      return await parser.parse();
    } catch (e) {
      console.error('Failed to parse config:', e);
      throw e;
    }
  });

  // Window Controls
  ipcMain.handle('window:update-title-bar-overlay', (event, overlay) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      // titleBarOverlay is not supported on Linux and throws if not enabled
      if (process.platform === 'linux') return { success: true };

      try {
        win.setTitleBarOverlay(overlay);
        return { success: true };
      } catch (e: any) {
        // Silently fail if overlay is disabled or unsupported
        return { success: false, error: e.message };
      }
    }
    return { success: false };
  });
}
