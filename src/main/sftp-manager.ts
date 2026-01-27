import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import { type SSHConfig, sshManager } from './ssh-manager';

export interface FileEntry {
  name: string;
  type: 'd' | '-' | 'l';
  size: number;
  modifyTime: number;
  accessTime: number;
  rights: { user: string; group: string; other: string };
  owner: number;
  group: number;
}

export class SFTPManager {
  private wrappers: Map<string, SFTPWrapper> = new Map();

  async connect(config: SSHConfig): Promise<void> {
    // Local connection doesn't need explicit SFTP connection
    if (config.id === 'local') return;

    // Reuse existing SSH connection
    const client = sshManager.getClient(config.id);
    if (!client) throw new Error('SSH Client disjointed. Please connect SSH first.');

    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        this.wrappers.set(config.id, sftp);
        resolve();
      });
    });
  }

  async disconnect(id: string) {
    if (id === 'local') return;
    const sftp = this.wrappers.get(id);
    if (sftp) {
      sftp.end(); // Ends the SFTP subsystem
      this.wrappers.delete(id);
    }
  }

  private getWrapper(id: string): SFTPWrapper {
    const sftp = this.wrappers.get(id);
    if (!sftp) throw new Error(`SFTP session not active for id: ${id}`);
    return sftp;
  }

  // Wrappers for SFTP operations
  async list(id: string, dirPath: string): Promise<FileEntry[]> {
    if (id === 'local') {
      try {
        const names = await fsp.readdir(dirPath);
        const entries = await Promise.all(
          names.map(async (name) => {
            try {
              const fullPath = path.join(dirPath, name);
              const stats = await fsp.stat(fullPath);
              return {
                name,
                type: stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-',
                size: stats.size,
                modifyTime: stats.mtimeMs,
                accessTime: stats.atimeMs,
                rights: { user: '', group: '', other: '' },
                owner: stats.uid,
                group: stats.gid,
              } as FileEntry;
            } catch (_e) {
              return null; // Ignore files we can't stat (permissions etc)
            }
          }),
        );
        return entries.filter((e): e is FileEntry => e !== null);
      } catch (e) {
        console.error('Local list error:', e);
        // If directory is redundant/empty or access denied, return empty
        throw e;
      }
    }

    const sftp = this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err);

        const entries = list.map(
          (item) =>
            ({
              name: item.filename,
              type: item.longname.startsWith('d') ? 'd' : item.longname.startsWith('l') ? 'l' : '-',
              size: item.attrs.size,
              modifyTime: item.attrs.mtime * 1000,
              accessTime: item.attrs.atime * 1000,
              rights: {
                user: '', // Helper to parse mode if needed, but not critical for basic List
                group: '',
                other: '',
              },
              owner: item.attrs.uid,
              group: item.attrs.gid,
            }) as FileEntry,
        );
        resolve(entries);
      });
    });
  }

  async cwd(id: string): Promise<string> {
    if (id === 'local') {
      return os.homedir();
    }

    const sftp = this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.realpath('.', (err, path) => {
        if (err) return reject(err);
        resolve(path);
      });
    });
  }

  async get(id: string, remotePath: string, localPath: string): Promise<void> {
    if (id === 'local') {
      // "Remote" is local, "Local" is local. Just copy.
      await fsp.copyFile(remotePath, localPath);
      return;
    }

    const sftp = this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async put(id: string, localPath: string, remotePath: string): Promise<void> {
    if (id === 'local') {
      await fsp.copyFile(localPath, remotePath);
      return;
    }

    const sftp = this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async mkdir(id: string, path: string): Promise<void> {
    if (id === 'local') {
      await fsp.mkdir(path, { recursive: true });
      return;
    }

    const sftp = this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.mkdir(path, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async rename(id: string, oldPath: string, newPath: string): Promise<void> {
    if (id === 'local') {
      await fsp.rename(oldPath, newPath);
      return;
    }

    const sftp = this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async delete(id: string, pathUrl: string): Promise<void> {
    if (id === 'local') {
      await fsp.rm(pathUrl, { recursive: true, force: true });
      return;
    }

    const sftp = this.getWrapper(id);
    // We need to know if it is a directory or file first
    // Use stat
    return new Promise((resolve, reject) => {
      sftp.stat(pathUrl, (err, stats) => {
        if (err) return reject(err);

        if (stats.isDirectory()) {
          sftp.rmdir(pathUrl, (err) => {
            if (err) reject(err);
            else resolve();
          });
        } else {
          // unlink checks
          sftp.unlink(pathUrl, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }
      });
    });
  }

  async readFile(id: string, path: string): Promise<string> {
    if (id === 'local') {
      return await fsp.readFile(path, 'utf-8');
    }

    const sftp = this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.readFile(path, (err, buffer) => {
        if (err) return reject(err);
        resolve(buffer.toString('utf-8'));
      });
    });
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    if (id === 'local') {
      await fsp.writeFile(path, content, 'utf-8');
      return;
    }

    const sftp = this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.writeFile(path, content, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  private activeTransfers = new Map<string, { readStream: any; writeStream: any }>();

  async copyBetweenServers(
    sourceId: string,
    sourcePath: string,
    destId: string,
    destPath: string,
    onProgress?: (transferred: number, total: number) => void,
    transferId?: string,
  ): Promise<void> {
    // Stats Logic
    let totalSize = 0;
    if (sourceId === 'local') {
      const stats = await fsp.stat(sourcePath);
      totalSize = stats.size;
    } else {
      const sftp = this.getWrapper(sourceId);
      await new Promise<void>((resolve, reject) => {
        sftp.stat(sourcePath, (err, stats) => {
          if (err || !stats) return reject(err || new Error('No stats'));
          totalSize = stats.size;
          resolve();
        });
      });
    }

    // Stream Creation
    let readStream: any;
    if (sourceId === 'local') {
      readStream = fs.createReadStream(sourcePath);
    } else {
      readStream = this.getWrapper(sourceId).createReadStream(sourcePath);
    }

    let writeStream: any;
    if (destId === 'local') {
      writeStream = fs.createWriteStream(destPath);
    } else {
      writeStream = this.getWrapper(destId).createWriteStream(destPath);
    }

    // Track active transfer
    if (transferId) {
      this.activeTransfers.set(transferId, { readStream, writeStream });
    }

    return new Promise((resolve, reject) => {
      let transferred = 0;

      readStream.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        if (onProgress) {
          onProgress(transferred, totalSize);
        }
      });

      readStream.on('error', (err: any) => {
        if (transferId) this.activeTransfers.delete(transferId);
        reject(new Error(`Failed to read source file: ${err.message}`));
      });

      writeStream.on('error', (err: any) => {
        if (transferId) this.activeTransfers.delete(transferId);
        reject(new Error(`Failed to write to destination: ${err.message}`));
      });

      writeStream.on('finish', () => {
        if (transferId) this.activeTransfers.delete(transferId);
        resolve();
      });

      // Pipe
      readStream.pipe(writeStream);
    });
  }

  cancelTransfer(transferId: string): boolean {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return false;

    // Destroy both streams to abort transfer
    if (transfer.readStream.destroy) transfer.readStream.destroy();
    if (transfer.writeStream.destroy) transfer.writeStream.destroy();
    this.activeTransfers.delete(transferId);
    return true;
  }
}

export const sftpManager = new SFTPManager();
