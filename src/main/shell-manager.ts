import * as os from 'node:os';
import { spawn as spawnPty } from 'node-pty';
import { sshManager } from './ssh-manager';

export class SSHShellManager {
  private streams: Map<string, any> = new Map();

  async spawn(connectionId: string, termId: string, rows: number, cols: number, win: Electron.BrowserWindow) {
    if (connectionId === 'local') {
      const shell = process.env[os.platform() === 'win32' ? 'COMSPEC' : 'SHELL'] || '/bin/bash';

      try {
        const ptyProcess = spawnPty(shell, [], {
          name: 'xterm-color',
          cols: cols || 80,
          rows: rows || 24,
          cwd: process.env.HOME || process.cwd(),
          env: process.env as any,
        });

        this.streams.set(termId, ptyProcess);

        ptyProcess.onData((data) => {
          win.webContents.send('terminal:data', { termId, data });
        });

        ptyProcess.onExit(() => {
          win.webContents.send('terminal:closed', { termId });
          this.streams.delete(termId);
        });
      } catch (err) {
        console.error('Failed to spawn local PTY:', err);
        throw err;
      }
      return;
    }

    const client = sshManager.getClient(connectionId);
    if (!client) throw new Error('Client not connected');

    // Allow multiple shells per connection (Channels)
    client.shell({ term: 'xterm', rows, cols }, (err, stream) => {
      if (err) throw err;

      this.streams.set(termId, stream);

      stream.on('data', (data: any) => {
        win.webContents.send('terminal:data', {
          termId,
          data: data.toString(),
        });
      });

      stream.on('close', () => {
        win.webContents.send('terminal:closed', { termId });
        this.streams.delete(termId);
      });
    });
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
        stream.end(); // SSH
      }
      this.streams.delete(termId);
    }
  }
}

export const sshShellManager = new SSHShellManager();
