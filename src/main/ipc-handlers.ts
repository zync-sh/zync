import { ipcMain, BrowserWindow } from 'electron';
import { sshManager, SSHConfig } from './ssh-manager';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);
import { sftpManager } from './sftp-manager';
import { sshShellManager } from './shell-manager';
import { settingsManager } from './settings-manager';
import { tunnelManager, TunnelConfig } from './tunnel-manager';
import { snippetManager, Snippet } from './snippets-manager';
import { SSHConfigParser } from './ssh-config-parser';
import { connectionStoreManager } from './connection-store-manager';
import { appConfigManager } from './app-config-manager';

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
  ipcMain.handle('tunnel:start', async (event, id: string) => {
    try {
      const config = tunnelManager.getTunnelConfig(id);
      if (!config) throw new Error('Tunnel not found');

      const client = sshManager.getClient(config.connectionId);
      if (!client) throw new Error('SSH Client not connected');

      await tunnelManager.startTunnel(client, id);

      // Broadcast update
      event.sender.send('tunnel:status-change', { id, status: 'active', error: undefined });

      return { success: true };
    } catch (e: any) {
      console.error('Tunnel Start Error', e);
      // We might want to broadcast error status too?
      // event.sender.send('tunnel:status-change', { id, status: 'error', error: e.message });
      throw e;
    }
  });

  ipcMain.handle('tunnel:stop', async (event, id: string) => {
    await tunnelManager.stopTunnel(id);
    event.sender.send('tunnel:status-change', { id, status: 'stopped', error: undefined });
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

  ipcMain.handle('tunnel:getAll', async () => {
    return tunnelManager.getAllTunnels();
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
    // Connect SSH first (terminal)
    await sshManager.connect(config);

    try {
      // Then connect SFTP (file manager)
      // Sequential execution prevents potential race conditions or auth rate limiting on some servers
      await sftpManager.connect(config);

      // Auto-start Tunnels
      const client = sshManager.getClient(config.id);
      if (client) {
        // Run in background so we don't block the connect response
        tunnelManager.startAutoTunnels(client, config.id).catch(err => {
          console.error('Failed to auto-start tunnels:', err);
        });
      }

      // Auto-detect OS Icon (Background)
      detectAndSaveOS(config.id).catch((err: any) => console.error('OS Detection failed', err));

    } catch (error) {
      console.error('Connection Failed:', error);
      // If SFTP fails, should we disconnect SSH? 
      // For now, let's treat it as a partial failure but allow terminal access?
      // But the UI expects both. Let's disconnect SSH and throw to ensure consistent state.
      sshManager.disconnect(config.id);
      throw error;
    }

    return { success: true };
  });

  ipcMain.handle('shell:open', async (_, url: string) => {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('shell:getWslDistros', async () => {
    if (process.platform !== 'win32') return [];
    try {
      // Use wsl --list --quiet for cleaner output (utf-16le issue possible, but usually handled by node exec?)
      // exec returns buffer usually? no string.
      const { stdout } = await execPromise('wsl --list --quiet');
      // Normalize output: split by newlines, trim, remove empty/null chars (formatting issues)
      return stdout
        .toString()
        .split(/[\r\n]+/)
        .map(s => s.trim().replace(/\0/g, '')) // Remove null bytes if UTF-16 issues
        .filter(s => s.length > 0);
    } catch (e) {
      console.error('Failed to list WSL distros:', e);
      return [];
    }
  });

  ipcMain.handle('ssh:disconnect', async (_, id: string) => {
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
    return !!sshManager.getClient(id);
  });

  // SFTP Operations
  ipcMain.handle('sftp:list', async (_, { id, path }) => {
    return sftpManager.list(id, path);
  });

  ipcMain.handle('sftp:cwd', async (_, { id }) => {
    return sftpManager.cwd(id);
  });

  ipcMain.handle('sftp:get', async (_, { id, remotePath, localPath }) => { // Download
    return sftpManager.get(id, remotePath, localPath);
  });

  ipcMain.handle('sftp:put', async (_, { id, localPath, remotePath }) => { // Upload
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

  ipcMain.handle('sftp:copyToServer', async (event, { sourceConnectionId, sourcePath, destinationConnectionId, destinationPath, transferId }) => {
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
          transferId
        });
      },
      transferId
    );
  });

  ipcMain.handle('sftp:cancelTransfer', async (_, { transferId }) => {
    return sftpManager.cancelTransfer(transferId);
  });


  // Native Dialogs
  const { dialog } = require('electron');

  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return result;
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result;
  });

  ipcMain.handle('dialog:saveFile', async (_, defaultPath) => {
    const result = await dialog.showSaveDialog({ defaultPath });
    return result;
  });

  // Terminal Operations
  ipcMain.handle('terminal:spawn', async (event, { connectionId, termId, rows, cols }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false };
    await sshShellManager.spawn(connectionId, termId, rows, cols, win);
    return { success: true };
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
  // Key Management
  ipcMain.handle('ssh:importKey', async (_, filePath: string) => {
    const { app } = require('electron');
    const fs = require('fs');
    const path = require('path');

    try {
      // Use the configured data path for portability
      const userDataPath = appConfigManager.getDataPath();
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

  // ... (readConfig is unchanged) ...

  // To save space, I will not include readConfig here if I can skip it, but replace_file_content needs contiguous block. 
  // I will skip to the config:set part if it's far away. 
  // ssh:importKey is around line 261. config:set is around 369. They are far apart.
  // I should make TWO calls or use multi_replace. Use multi_replace for safety.

  // Wait, I am using replace_file_content. I should ONLY update ssh:importKey here. I'll make a second call for config:set.


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
  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  // Zoom Controls
  ipcMain.handle('app:zoomIn', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const current = win.webContents.getZoomFactor();
    win.webContents.setZoomFactor(current + 0.1);
  });

  ipcMain.handle('app:zoomOut', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const current = win.webContents.getZoomFactor();
    if (current > 0.5) {
      win.webContents.setZoomFactor(current - 0.1);
    }
  });

  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  ipcMain.handle('window:is-maximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isMaximized();
  });
  // Auto Update handlers
  ipcMain.handle('update:install', () => {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall();
  });

  ipcMain.handle('update:check', async () => {
    const { autoUpdater } = require('electron-updater');
    // We can return the result, but the events are already wired in index.ts
    // triggering this will fire the events which the UI listens to.
    const result = await autoUpdater.checkForUpdates();
    return result;
  });

  ipcMain.handle('app:getVersion', () => {
    const { app } = require('electron');
    return app.getVersion();
  });

  ipcMain.handle('app:isAppImage', () => {
    return !!process.env.APPIMAGE;
  });

  // Connection Storage Operations (Main Process Authority)
  // Connection Storage Operations (Main Process Authority)
  ipcMain.handle('connections:get', async () => {
    return connectionStoreManager.getData();
  });

  ipcMain.handle('connections:save', async (event, data) => {
    connectionStoreManager.saveData(data);
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('connections:updated', data);
    });
    return { success: true };
  });

  // --- App Configuration & Onboarding ---

  ipcMain.handle('config:get', async () => {
    return appConfigManager.getConfig();
  });

  ipcMain.handle('config:set', async (event, config) => {
    const fs = require('fs');
    const path = require('path');

    const oldPath = appConfigManager.getDataPath();
    appConfigManager.setConfig(config);
    const newPath = appConfigManager.getDataPath();

    // If data path changed, migrate data and reload stores
    if (oldPath !== newPath && oldPath && newPath) {
      console.log(`[IPC] Data path changed from ${oldPath} to ${newPath}. Migrating data...`);

      try {
        // Ensure new directory exists
        if (!fs.existsSync(newPath)) {
          fs.mkdirSync(newPath, { recursive: true });
        }

        // Files to move
        const filesToMove = [
          'ssh-connections.json',
          'snippets.json',
          'tunnels.json',
          'config.json' // Settings
        ];

        // 1. Copy JSON Files
        for (const file of filesToMove) {
          const src = path.join(oldPath, file);
          const dest = path.join(newPath, file);
          if (fs.existsSync(src)) {
            // Only copy if destination doesn't exist to avoid overwriting existing data in target
            if (!fs.existsSync(dest)) {
              fs.copyFileSync(src, dest);
              console.log(`[Migration] Copied ${file}`);
            } else {
              console.log(`[Migration] Skipped ${file} (exists in destination)`);
            }
          }
        }
        // 2. Copy 'keys' and 'logs' Directory
        const dirsToMove = ['keys', 'logs'];
        for (const dir of dirsToMove) {
          const srcDir = path.join(oldPath, dir);
          const destDir = path.join(newPath, dir);

          if (fs.existsSync(srcDir)) {
            // Use cpSync (Node 16.7+ / Electron)
            if (fs.cpSync) {
              // Check if dest dir exists
              if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
              }
              // Copy contents
              fs.cpSync(srcDir, destDir, { recursive: true, force: false, errorOnExist: false });
              console.log(`[Migration] Copied ${dir} directory`);
            }
          }
        }
      } catch (err) {
        console.error('[Migration] Failed to migrate data:', err);
      }

      console.log('[IPC] Reloading all stores...');
      connectionStoreManager.reload();
      settingsManager.reload();
      snippetManager.reload();
      tunnelManager.reload();
    }
    return { success: true };
  });

  ipcMain.handle('config:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      title: 'Select Data Folder'
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
}

/**
 * Helper to detect remote OS and update connection icon
 */
async function detectAndSaveOS(connectionId: string) {
  try {
    const storeData = connectionStoreManager.getData();
    const connIndex = storeData.connections.findIndex(c => c.id === connectionId);
    if (connIndex === -1) return;

    const conn = storeData.connections[connIndex];
    // Only update if icon is missing or default 'Server'
    if (conn.icon && conn.icon !== 'Server') return;

    // 1. Try /etc/os-release (Linux)
    try {
      const output = await sshManager.execCommand(connectionId, 'cat /etc/os-release');
      const match = output.match(/^ID="?([^"\n]+)"?/m);
      if (match && match[1]) {
        const id = match[1].toLowerCase();
        let icon = 'Linux'; // Default Linux

        if (id.includes('ubuntu') || id.includes('pop') || id.includes('mint')) icon = 'Ubuntu';
        else if (id.includes('debian') || id.includes('kali') || id.includes('raspbian')) icon = 'Debian';
        else if (id.includes('centos') || id.includes('fedora') || id.includes('rhel') || id.includes('alma') || id.includes('rocky') || id.includes('amazon')) icon = 'CentOS';
        else if (id.includes('arch') || id.includes('manjaro')) icon = 'Arch';
        else if (id.includes('alpine')) icon = 'Box';

        updateIcon(connectionId, icon);
        return;
      }
    } catch (e) { /* Ignore */ }

    // 2. Try uname -s (Mac/BSD/Other)
    try {
      const uname = await sshManager.execCommand(connectionId, 'uname -s');
      const sysName = uname.trim();
      if (sysName === 'Darwin') {
        updateIcon(connectionId, 'Apple');
      } else if (sysName === 'Linux') {
        updateIcon(connectionId, 'Linux');
      }
    } catch (e) { /* Ignore */ }

  } catch (err) {
    console.warn('Auto-OS Detection Error:', err);
  }
}

function updateIcon(connectionId: string, icon: string) {
  const storeData = connectionStoreManager.getData();
  const conn = storeData.connections.find(c => c.id === connectionId);
  if (conn) {
    conn.icon = icon;
    connectionStoreManager.saveData(storeData);
    // Broadcast update
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('connections:updated', storeData);
    });
  }
}
