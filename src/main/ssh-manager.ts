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

export class SSHManager {
  private connectionPools: Map<string, Client[]> = new Map();
  private configs: Map<string, SSHConfig> = new Map();
  private pendingConnections: Map<string, Promise<void>> = new Map();

  async connect(config: SSHConfig): Promise<void> {
    this.configs.set(config.id, config);

    // If already connected (pool exists), do nothing
    if (this.connectionPools.has(config.id)) return;

    // Check if connection is already in progress
    if (this.pendingConnections.has(config.id)) {
      return this.pendingConnections.get(config.id)!;
    }

    const connectPromise = this.connectRecursive(config)
      .then((client) => {
        this.connectionPools.set(config.id, [client]);
      })
      .finally(() => {
        this.pendingConnections.delete(config.id);
      });

    this.pendingConnections.set(config.id, connectPromise);
    return connectPromise;
  }

  // Returns a new connected Client
  private async connectRecursive(config: SSHConfig): Promise<Client> {
    // Check if there is a jump server
    if (config.jumpServerId) {
      // For jump host, we use the EXISTING pool of the jump server.
      // We need a helper to get *any* valid stream from jump server.
      const jumpPool = this.connectionPools.get(config.jumpServerId);
      if (!jumpPool || jumpPool.length === 0) {
        throw new Error(
          `Jump server (${config.jumpServerId}) is not connected. Please connect to the bastion host first.`,
        );
      }

      // Try with the last client in pool (most recently added)
      const jumpClient = jumpPool[jumpPool.length - 1];

      return new Promise((resolve, reject) => {
        jumpClient.forwardOut('127.0.0.1', 12345, config.host, config.port, (err, stream) => {
          if (err) return reject(err);
          this.establishConnection(config, stream).then(resolve).catch(reject);
        });
      });
    } else {
      return this.establishConnection(config);
    }
  }

  private async establishConnection(config: SSHConfig, sock?: NodeJS.ReadableStream): Promise<Client> {
    return new Promise((resolve, reject) => {
      const conn = new Client();

      const cleanup = () => {
        // Remove this specific client from pool on any close/error/end
        const pool = this.connectionPools.get(config.id);
        if (pool) {
          const newPool = pool.filter(c => c !== conn);
          if (newPool.length === 0) {
            this.connectionPools.delete(config.id);
          } else {
            this.connectionPools.set(config.id, newPool);
          }
        }
      };

      conn
        .on('ready', () => {
          resolve(conn);
        })
        .on('error', (err) => {
          // If error during initial connect, reject promise
          // If error after connect, just cleanup
          // We can't know easily state here, but if resolve hasn't been called logic is elsewhere.
          // Actually 'ready' resolves it.
          // So for pool maintenance:
          cleanup();
          // Note: rejecting here if already resolved does nothing, which is fine.
          reject(err);
        })
        .on('end', cleanup)
        .on('close', cleanup);

      const connectConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
        sock: sock,
        readyTimeout: 20000,
        keepaliveInterval: 10000
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

  // Add a new connection to the pool (Scaling)
  async addPoolConnection(id: string): Promise<Client> {
    const config = this.configs.get(id);
    if (!config) throw new Error("Config not found for " + id);

    const client = await this.connectRecursive(config);
    const pool = this.connectionPools.get(id) || [];
    pool.push(client);
    this.connectionPools.set(id, pool);
    return client;
  }

  disconnect(id: string): void {
    const pool = this.connectionPools.get(id);
    if (pool) {
      pool.forEach(c => c.end());
      this.connectionPools.delete(id);
    }
  }

  disconnectAll(): void {
    for (const [id, pool] of this.connectionPools) {
      pool.forEach(c => c.end());
    }
    this.connectionPools.clear();
  }

  async execCommand(id: string, command: string): Promise<string> {
    const pool = this.connectionPools.get(id);
    if (!pool || pool.length === 0) throw new Error(`Connection not found: ${id}`);

    // Try clients in reverse order (newest first)
    for (let i = pool.length - 1; i >= 0; i--) {
      try {
        return await this.execOnClient(pool[i], command);
      } catch (err: any) {
        if (err.message && err.message.includes('Channel open failure')) {
          // console.debug(`[SSH] Channel exhausted on client ${i}, trying next...`);
        } else {
          console.warn(`[SSH] Exec failed on client ${i}: ${err.message}. Trying next...`);
        }
        continue;
      }
    }

    // All failed? Try adding a new connection
    console.log(`[SSH] Scaling pool for ${id} (Active: ${pool.length})...`);
    const newClient = await this.addPoolConnection(id);
    return await this.execOnClient(newClient, command);
  }

  private async execOnClient(conn: Client, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);

        const timeout = setTimeout(() => {
          stream.close();
          reject(new Error(`Command timed out: ${command}`));
        }, 10000);

        let output = '';
        stream
          .on('close', () => {
            clearTimeout(timeout);
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

  // Deprecated usage, but kept for compatibility. Returns PRIMARY client.
  // Consumers should move to using pool awareness.
  getClient(id: string): Client | undefined {
    const pool = this.connectionPools.get(id);
    return pool ? pool[0] : undefined;
  }

  // New method for aware consumers
  getClientPool(id: string): Client[] | undefined {
    return this.connectionPools.get(id);
  }

  getActiveConnectionCount(): number {
    return this.connectionPools.size;
  }
}

export const sshManager = new SSHManager();
