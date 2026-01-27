import * as os from 'node:os';
import { spawn as spawnPty } from 'node-pty';
import { sshManager } from './ssh-manager';
import { settingsManager } from './settings-manager';

export class SSHShellManager {
  private streams: Map<string, any> = new Map();

  async spawn(connectionId: string, termId: string, rows: number, cols: number, win: Electron.BrowserWindow) {
    if (connectionId === 'local') {
      const settings = settingsManager.getSettings();
      let shell = process.env[os.platform() === 'win32' ? 'COMSPEC' : 'SHELL'] || '/bin/bash';

      if (os.platform() === 'win32') {
        const configuredShell = settings.localTerm?.windowsShell || 'default';

        switch (configuredShell) {
          case 'powershell':
            shell = 'powershell.exe';
            break;
          case 'cmd':
            shell = 'cmd.exe';
            break;
          case 'wsl':
            shell = 'wsl.exe';
            break;
          case 'gitbash':
            // Try common Git Bash paths
            const commonPaths = [
              'C:\\Program Files\\Git\\bin\\bash.exe',
              'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
              'C:\\Users\\' + os.userInfo().username + '\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
            ];
            shell = 'C:\\Program Files\\Git\\bin\\bash.exe';
            break;
          default:
            // Custom path or 'default' or 'wsl:DistroName'
            if (configuredShell.startsWith('wsl:')) {
              shell = 'wsl.exe';
              // We need to pass arguments to node-pty.
              // The current spawn method uses `shell` as command and `[]` as args.
              // We need to change the logic to support args.
            } else if (configuredShell !== 'default') {
              shell = configuredShell;
            }
            break;
        }
      } else if (os.platform() === 'darwin') {
        // macOS Specific Fallback to fix 'posix_spawnp failed'
        // Electron apps launched from Finder/Dock often have issues with process.env.SHELL
        const fs = require('node:fs');
        const macShell = settings.localTerm?.macShell || 'default';

        if (macShell !== 'default') {
          shell = macShell;
        } else {
          // If process.env.SHELL looks valid, use it. Otherwise find a safe default.
          const envShell = process.env.SHELL;
          if (envShell && fs.existsSync(envShell)) {
            shell = envShell;
          } else {
            // Priority list of standard shells
            const candidates = [
              '/bin/zsh',        // Default since Catalina
              '/bin/bash',       // Legacy default
              '/usr/local/bin/zsh', // Homebrew
              '/usr/local/bin/bash', // Homebrew
              '/bin/sh'
            ];

            for (const candidate of candidates) {
              if (fs.existsSync(candidate)) {
                shell = candidate;
                break;
              }
            }
          }
        }
      }

      // Prepare args if needed (WSL specific)
      let args: string[] = [];
      if (os.platform() === 'win32') {
        const configuredShell = settings.localTerm?.windowsShell || 'default';
        if (configuredShell.startsWith('wsl:')) {
          const distro = configuredShell.split('wsl:')[1];
          if (distro) {
            args = ['-d', distro];
          }
        }
      }

      const cwd = os.homedir();

      try {
        const ptyProcess = spawnPty(shell, args, {
          name: 'xterm-256color',
          cols: cols || 80,
          rows: rows || 24,
          cwd: cwd,
          env: process.env as any,
        });

        this.streams.set(termId, ptyProcess);

        ptyProcess.onData((data) => {
          if (!win.isDestroyed()) {
            win.webContents.send('terminal:data', { termId, data });
          }
        });

        ptyProcess.onExit(() => {
          if (!win.isDestroyed()) {
            win.webContents.send('terminal:closed', { termId });
          }
          this.streams.delete(termId);
        });
      } catch (err) {
        console.error('Failed to spawn local PTY:', err);
        throw err;
      }
      return;
    }

    const pool = sshManager.getClientPool(connectionId);
    if (!pool || pool.length === 0) throw new Error('Client not connected');

    // Helper to spawn on a specific client
    const spawnOnClient = (client: any): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        client.shell({ term: 'xterm-256color', rows, cols }, (err: any, stream: any) => {
          if (err) return reject(err);

          this.streams.set(termId, stream);

          stream.on('data', (data: any) => {
            if (!win.isDestroyed()) {
              win.webContents.send('terminal:data', {
                termId,
                data: data.toString(),
              });
            }
          });

          stream.on('close', () => {
            if (!win.isDestroyed()) {
              win.webContents.send('terminal:closed', { termId });
            }
            this.streams.delete(termId);
          });

          resolve();
        });
      });
    };

    // Try last client first, then iterate backwards
    for (let i = pool.length - 1; i >= 0; i--) {
      try {
        await spawnOnClient(pool[i]);
        return;
      } catch (err: any) {
        // console.debug(`[SSH] Spawn failed on client ${i}: ${err.message}. Trying next...`);
        continue;
      }
    }

    // All failed? Add new connection and try once more
    console.log(`[SSH] Scaling pool for shell spawn ${connectionId} (Active: ${pool.length})...`);
    try {
      const newClient = await sshManager.addPoolConnection(connectionId);
      await spawnOnClient(newClient);
    } catch (err) {
      console.error('Failed to spawn shell even after scaling:', err);
      throw err;
    }
  }

  write(termId: string, data: string) {
    const stream = this.streams.get(termId);
    if (stream) {
      stream.write(data);
    }
  }

  resize(termId: string, rows: number, cols: number) {
    const stream = this.streams.get(termId);
    if (stream) {
      // Check if it's a PTY (has resize method) or SSH stream (has setWindow)
      if (typeof stream.resize === 'function') {
        stream.resize(cols, rows);
      } else if (typeof stream.setWindow === 'function') {
        stream.setWindow(rows, cols, 0, 0);
      }
    }
  }

  kill(termId: string) {
    const stream = this.streams.get(termId);
    if (stream) {
      if (typeof stream.kill === 'function') {
        stream.kill(); // PTY
      } else {
        stream.close(); // SSH - Force Close Channel
      }
      this.streams.delete(termId);
    }
  }
}

export const sshShellManager = new SSHShellManager();
