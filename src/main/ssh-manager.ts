import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';

export interface SSHConfig {
  id: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  jumpServerId?: string; // ID of the bastion host connection
}

import { EventEmitter } from 'node:events';

export class SSHManager extends EventEmitter {
  private connections: Map<string, Client> = new Map();

  async connect(config: SSHConfig): Promise<void> {
    // If already connected, do nothing (or should we reconnect? For now assume valid)
    if (this.connections.has(config.id)) return;

    return this.connectRecursive(config);
  }

  private async connectRecursive(config: SSHConfig): Promise<void> {
    // Check if there is a jump server
    if (config.jumpServerId) {
      // Ensure jump server is connected
      // We need to look up the jump server config.
      // Since we don't store configs here (only connections), we rely on the IPC caller to have ensured the jump server is connected?
      // OR we need to fetch the config.
      // Problem: SSHManager currently doesn't know about ALL stored configs.
      // Solution: The easiest way for now is to rely on existing connections.
      // If the jump server connection exists, we use it. If not, we fail.
      // The Frontend/IPC handler should orchestrate connecting to the global chain if needed.
      // But wait, to create a nested stream, we need the jump server's Client instance.

      const jumpClient = this.connections.get(config.jumpServerId);
      if (!jumpClient) {
        throw new Error(
          `Jump server (${config.jumpServerId}) is not connected. Please connect to the bastion host first.`,
        );
      }

      return new Promise((resolve, reject) => {
        // Forward a connection to the target host
        jumpClient.forwardOut('127.0.0.1', 12345, config.host, config.port, (err, stream) => {
          if (err) return reject(err);

          // Now connect to the target using this stream
          this.establishConnection(config, stream).then(resolve).catch(reject);
        });
      });
    } else {
      // Direct connection
      return this.establishConnection(config);
    }
  }

  private async establishConnection(config: SSHConfig, sock?: NodeJS.ReadableStream): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new Client();

      conn
        .on('ready', () => {
          console.log(`[SSH] Connection ready: ${config.id} (${config.host})`);
          this.connections.set(config.id, conn);
          resolve();
        })
        .on('error', (err) => {
          console.error(`[SSH] Connection error for ${config.id}:`, err.message);
          this.emit('error', config.id, err);
          reject(err);
        })
        .on('end', () => {
          console.log(`[SSH] Connection ended: ${config.id}`);
          this.emit('disconnect', config.id, 'Connection ended by server');
          this.connections.delete(config.id);
        })
        .on('close', () => {
          console.log(`[SSH] Connection closed: ${config.id}`);
          this.emit('disconnect', config.id, 'Connection closed');
          this.connections.delete(config.id);
        });

      const connectConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
        sock: sock, // Inject the stream if provided (Jump Server)
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        readyTimeout: 20000,
      };

      if (config.privateKeyPath) {
        try {
          connectConfig.privateKey = readFileSync(config.privateKeyPath);
          if (config.passphrase) {
            connectConfig.passphrase = config.passphrase;
          }
        } catch (error) {
          reject(new Error(`Failed to read private key: ${error}`));
          return;
        }
      } else if (config.password) {
        connectConfig.password = config.password;
      }

      conn.connect(connectConfig);
    });
  }

  disconnect(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.end();
      this.connections.delete(id);
    }
  }
  // ... rest of class remains same methods ...

  async execCommand(id: string, command: string): Promise<string> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`Connection not found: ${id}`);

    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);

        let output = '';
        stream
          .on('close', () => {
            resolve(output);
          })
          .on('data', (data: any) => {
            output += data;
          })
          .stderr.on('data', (data) => {
            console.error('STDERR:', data);
          });
      });
    });
  }

  getClient(id: string): Client | undefined {
    return this.connections.get(id);
  }
}

export const sshManager = new SSHManager();
