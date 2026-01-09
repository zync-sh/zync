import { EventEmitter } from 'node:events';
import net from 'node:net';
import Store from 'electron-store';
import type { Client } from 'ssh2';

export interface TunnelConfig {
  id: string; // Unique ID
  connectionId: string;
  name: string;
  type: 'local' | 'remote'; // NEW
  localPort: number;
  remoteHost: string;
  remotePort: number;
  bindToAny?: boolean; // NEW: Bind to 0.0.0.0 (Allow LAN access)
  autoStart?: boolean; // NEW
  status?: 'active' | 'error' | 'stopped';
  error?: string;
}

interface TunnelStorage {
  tunnels: TunnelConfig[];
}

import { appConfigManager } from './app-config-manager';

class TunnelManager extends EventEmitter {
  private store!: Store<TunnelStorage>;

  constructor() {
    super();
    this.initStore();
  }

  private initStore() {
    const cwd = appConfigManager.getDataPath();
    this.store = new Store<TunnelStorage>({
      name: 'tunnels',
      cwd: cwd,
      defaults: { tunnels: [] },
    });
  }

  public reload() {
    this.initStore();
  }

  // Active servers/listeners: Map<tunnelId, { server?: net.Server; listener?: Function; client?: Client; error?: string }>
  private activeTunnels: Map<string, { server?: net.Server; listener?: (...args: any[]) => void; client?: Client; error?: string }> = new Map();

  // ... Persistence Methods (getTunnelsForConnection, saveTunnel, getTunnelConfig, deleteTunnel) ...
  // (Assuming saveTunnel handles the new 'type' field automatically since it stores the whole object)

  getAllTunnels(): TunnelConfig[] {
    const allTunnels = this.store.get('tunnels');
    return allTunnels.map((cfg) => {
      const active = this.activeTunnels.get(cfg.id);
      return {
        ...cfg,
        type: cfg.type || 'local',
        status: active ? (active.error ? 'error' : 'active') : 'stopped',
        error: active?.error,
      };
    });
  }

  getTunnelsForConnection(connectionId: string): TunnelConfig[] {
    const allTunnels = this.store.get('tunnels');
    const configs = allTunnels.filter((t) => t.connectionId === connectionId);

    return configs.map((cfg) => {
      const active = this.activeTunnels.get(cfg.id);
      return {
        ...cfg,
        type: cfg.type || 'local', // Default for migration
        status: active ? (active.error ? 'error' : 'active') : 'stopped',
        error: active?.error,
      };
    });
  }

  saveTunnel(config: TunnelConfig): TunnelConfig {
    const tunnels = this.store.get('tunnels');
    const existingIndex = tunnels.findIndex((t) => t.id === config.id);

    const storageConfig = { ...config };
    delete storageConfig.status;
    delete storageConfig.error;

    if (existingIndex >= 0) {
      tunnels[existingIndex] = storageConfig;
    } else {
      tunnels.push(storageConfig);
    }

    this.store.set('tunnels', tunnels);
    return config;
  }

  // ... getTunnelConfig, deleteTunnel (same as before) ...
  getTunnelConfig(id: string): TunnelConfig | undefined {
    return this.store.get('tunnels').find((t) => t.id === id);
  }

  deleteTunnel(id: string) {
    this.stopTunnel(id);
    const tunnels = this.store.get('tunnels');
    const newTunnels = tunnels.filter((t) => t.id !== id);
    this.store.set('tunnels', newTunnels);
  }


  // --- Runtime Methods ---

  private activeSockets: Map<string, Set<net.Socket>> = new Map();

  async stopTunnel(id: string): Promise<void> {
    return new Promise((resolve) => {
      const active = this.activeTunnels.get(id);
      if (!active) {
        resolve();
        return;
      }

      // Destroy Sockets
      const sockets = this.activeSockets.get(id);
      if (sockets) {
        for (const socket of sockets) {
          socket.destroy();
        }
        this.activeSockets.delete(id);
      }

      // Stop Local Server
      if (active.server) {
        active.server.close(() => {
          this.activeTunnels.delete(id);
          resolve();
        });
      }
      // Stop Remote Listener
      else if (active.listener && active.client) {
        // Unlisten event
        active.client.removeListener('tcp connection', active.listener as any);

        // Unforward (Tell server to stop listening)
        // We need config to know remote port to unforward? Or assuming unforwardIn works?
        // ssh2 client.unforwardIn(bindAddr, port, cb)
        // We'll need to fetch config again or store it in activeTunnels if we want to be clean.
        // For now, removing the listener stops our app from handling it.
        // But the server might still hold the port open. It's better to unforward.
        // Let's look up config.
        const config = this.getTunnelConfig(id);
        if (config) {
          active.client.unforwardIn(config.remoteHost, config.remotePort, () => {
            this.activeTunnels.delete(id);
            resolve();
          });
        } else {
          this.activeTunnels.delete(id);
          resolve();
        }
      } else {
        this.activeTunnels.delete(id);
        resolve();
      }
    });
  }

  async startAutoTunnels(sshClient: Client, connectionId: string): Promise<void> {
    const tunnels = this.getTunnelsForConnection(connectionId);
    const autoStartTunnels = tunnels.filter((t) => t.autoStart && t.status !== 'active');

    if (autoStartTunnels.length > 0) {
      console.log(`[TunnelManager] Found ${autoStartTunnels.length} auto-start tunnels for ${connectionId}`);
      for (const tunnel of autoStartTunnels) {
        try {
          await this.startTunnel(sshClient, tunnel.id);
        } catch (e: any) {
          console.error(`[TunnelManager] Failed to auto-start tunnel ${tunnel.name}:`, e);
        }
      }
    }
  }

  async startTunnel(sshClient: Client, tunnelId: string): Promise<void> {
    const tunnels = this.store.get('tunnels');
    const config = tunnels.find((t) => t.id === tunnelId);

    if (!config) throw new Error('Tunnel configuration not found');
    if (this.activeTunnels.has(tunnelId)) throw new Error('Tunnel already active');

    // Default type to local if missing
    const type = config.type || 'local';

    if (type === 'local') {
      return this.startLocalTunnel(sshClient, config, tunnelId);
    } else {
      return this.startRemoteTunnel(sshClient, config, tunnelId);
    }
  }

  private startLocalTunnel(sshClient: Client, config: TunnelConfig, tunnelId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        if (!this.activeSockets.has(tunnelId)) this.activeSockets.set(tunnelId, new Set());
        this.activeSockets.get(tunnelId)?.add(socket);

        socket.on('close', () => {
          this.activeSockets.get(tunnelId)?.delete(socket);
        });

        sshClient.forwardOut(
          '127.0.0.1',
          socket.remotePort || 0,
          config.remoteHost,
          config.remotePort,
          (err, stream) => {
            if (err) {
              console.error(`[Tunnel ${config.id}] Forwarding error:`, err);
              socket.end();
              return;
            }
            socket.pipe(stream).pipe(socket);
          },
        );
      });

      server.on('error', (err) => {
        console.error(`[Tunnel ${config.id}] Server error:`, err);
        this.activeTunnels.set(tunnelId, { server, error: err.message });
        if (!server.listening) reject(err);
      });

      try {
        const bindAddress = config.bindToAny ? '0.0.0.0' : '127.0.0.1';
        server.listen(config.localPort, bindAddress, () => {
          console.log(`[Tunnel ${config.id}] Listening on ${bindAddress}:${config.localPort}`);
          this.activeTunnels.set(tunnelId, { server });
          resolve();
        });
      } catch (e: any) {
        reject(e);
      }
    });
  }

  private startRemoteTunnel(sshClient: Client, config: TunnelConfig, tunnelId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 1. Request Remote Forwarding
      sshClient.forwardIn(config.remoteHost, config.remotePort, (err, port) => {
        if (err) {
          console.error(`[Tunnel ${config.id}] Remote Forwarding Request failed:`, err);
          this.activeTunnels.set(tunnelId, { client: sshClient, error: err.message });
          reject(err);
          return;
        }

        console.log(`[Tunnel ${config.id}] Remote listening on ${config.remoteHost}:${config.remotePort}`);

        // 2. Setup Handler
        const listener = (details: any, accept: any, rejectConn: any) => {
          if (details.destPort === config.remotePort) {
            const stream = accept();

            // Connect to LOCAL target
            const socket = net.connect(config.localPort, '127.0.0.1');

            // Track Sockets
            if (!this.activeSockets.has(tunnelId)) this.activeSockets.set(tunnelId, new Set());

            // We can't easily track the 'socket' object from 'ssh2' stream wrapper fully here 
            // but we can track our local socket.
            this.activeSockets.get(tunnelId)?.add(socket);
            socket.on('close', () => this.activeSockets.get(tunnelId)?.delete(socket));

            socket.on('error', (err) => {
              console.error(`[Tunnel ${config.id}] Local connection error:`, err);
              stream.end();
            });

            stream.on('close', () => {
              socket.end();
            });

            socket.pipe(stream).pipe(socket);
          }
        };

        sshClient.on('tcp connection', listener);

        this.activeTunnels.set(tunnelId, { client: sshClient, listener });
        resolve();
      });
    });
  }
}

export const tunnelManager = new TunnelManager();
