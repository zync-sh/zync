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
  private connectionPromises: Map<string, Promise<void>> = new Map();

  async connect(config: SSHConfig): Promise<void> {
    // Local connection doesn't need explicit SFTP connection
    if (config.id === 'local') return;

    // Return existing promise if connection is already in progress
    if (this.connectionPromises.has(config.id)) {
        return this.connectionPromises.get(config.id);
    }

    console.log(`[SFTP] Attempting SFTP connection for: ${config.id}`);
    
    // Reuse existing SSH connection
    const client = sshManager.getClient(config.id);
    if (!client) throw new Error('SSH Client disjointed. Please connect SSH first.');

    const connectionPromise = new Promise<void>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          console.error(`[SFTP] Failed to establish SFTP for ${config.id}:`, err.message);
          this.connectionPromises.delete(config.id);
          return reject(err);
        }
        
        // Check if we were disconnected while connecting
        if (!this.connectionPromises.has(config.id)) {
            console.log(`[SFTP] Connection for ${config.id} was aborted. Closing session.`);
            sftp.end();
            return resolve();
        }

        console.log(`[SFTP] SFTP session established for: ${config.id}`);
        this.wrappers.set(config.id, sftp);
        // We keep the promise resolved so future waiters get it immediately
        resolve();
      });
    });

    this.connectionPromises.set(config.id, connectionPromise);
    return connectionPromise;
  }

  async disconnect(id: string) {
    if (id === 'local') return;
    
    // Cancel any in-progress connection
    this.connectionPromises.delete(id);

    const sftp = this.wrappers.get(id);
    if (sftp) {
      sftp.end(); // Ends the SFTP subsystem
      this.wrappers.delete(id);
    }
  }

  private async getWrapper(id: string): Promise<SFTPWrapper> {
    // If we have an active connection prompt, wait for it
    if (this.connectionPromises.has(id)) {
        await this.connectionPromises.get(id);
    }

    const sftp = this.wrappers.get(id);
    if (!sftp) throw new Error(`SFTP session not active for id: ${id}`);
    return sftp;
  }

  public getWrapperSync(id: string): SFTPWrapper | undefined {
    return this.wrappers.get(id);
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

    const sftp = await this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err: Error | undefined, list: any[]) => {
        if (err) return reject(err);

        const entries = list.map(
          (item: any) =>
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

    const sftp = await this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.realpath('.', (err: Error | undefined, path: string) => {
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

    const sftp = await this.getWrapper(id);
    return new Promise((resolve, reject) => {
      (sftp as any).fastGet(remotePath, localPath, (err: Error | undefined) => {
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

    const sftp = await this.getWrapper(id);
    return new Promise((resolve, reject) => {
      (sftp as any).fastPut(localPath, remotePath, (err: Error | undefined) => {
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

    const sftp = await this.getWrapper(id);
    return new Promise((resolve, reject) => {
      (sftp as any).mkdir(path, (err: Error | undefined) => {
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

    const sftp = await this.getWrapper(id);
    return new Promise((resolve, reject) => {
      (sftp as any).rename(oldPath, newPath, (err: Error | undefined) => {
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

    const sftp = await this.getWrapper(id);
    // We need to know if it is a directory or file first
    // Use stat
    return new Promise((resolve, reject) => {
      sftp.stat(pathUrl, (err: Error | undefined, stats: any) => {
        if (err) return reject(err);

        if (stats.isDirectory()) {
          (sftp as any).rmdir(pathUrl, (err: Error | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        } else {
          // unlink checks
          (sftp as any).unlink(pathUrl, (err: Error | undefined) => {
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

    const sftp = await this.getWrapper(id);
    return new Promise((resolve, reject) => {
      sftp.readFile(path, (err: Error | undefined, buffer: Buffer) => {
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

    const sftp = await this.getWrapper(id);
    return new Promise((resolve, reject) => {
      // Use any to avoid strict type mismatch with Callback vs local signature
      (sftp as any).writeFile(path, content, (err: Error | undefined) => {
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
      const sftp = await this.getWrapper(sourceId);
      await new Promise<void>((resolve, reject) => {
        sftp.stat(sourcePath, (err: Error | undefined, stats: any) => {
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
      readStream = (await this.getWrapper(sourceId)).createReadStream(sourcePath);
    }

    let writeStream: any;
    if (destId === 'local') {
      writeStream = fs.createWriteStream(destPath);
    } else {
      writeStream = (await this.getWrapper(destId)).createWriteStream(destPath);
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
