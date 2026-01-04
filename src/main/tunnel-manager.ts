import { EventEmitter } from 'node:events';
import net from 'node:net';
import Store from 'electron-store';
import type { Client } from 'ssh2';

export interface TunnelConfig {
  id: string; // Unique ID
  connectionId: string;
  name: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  // Status is runtime only, but we include it in the interface for frontend
  status?: 'active' | 'error' | 'stopped';
  error?: string;
}

interface TunnelStorage {
  tunnels: TunnelConfig[];
}

class TunnelManager extends EventEmitter {
  private store = new Store<TunnelStorage>({
    name: 'tunnels',
    defaults: { tunnels: [] },
  });

  // Active servers: Map<tunnelId, ServerInstance>
  private activeTunnels: Map<string, { server: net.Server; error?: string }> = new Map();

  // --- Persistence Methods ---

  getTunnelsForConnection(connectionId: string): TunnelConfig[] {
    const allTunnels = this.store.get('tunnels');
    const configs = allTunnels.filter((t) => t.connectionId === connectionId);

    // Merge with runtime status
    return configs.map((cfg) => {
      const active = this.activeTunnels.get(cfg.id);
      return {
        ...cfg,
        status: active ? (active.error ? 'error' : 'active') : 'stopped',
        error: active?.error,
      };
    });
  }

  saveTunnel(config: TunnelConfig): TunnelConfig {
    const tunnels = this.store.get('tunnels');
    const existingIndex = tunnels.findIndex((t) => t.id === config.id);

    // Clean config for storage (remove runtime status)
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

  getTunnelConfig(id: string): TunnelConfig | undefined {
    return this.store.get('tunnels').find((t) => t.id === id);
  }

  deleteTunnel(id: string) {
    // Stop if active
    this.stopTunnel(id);

    const tunnels = this.store.get('tunnels');
    const newTunnels = tunnels.filter((t) => t.id !== id);
    this.store.set('tunnels', newTunnels);
  }

  // --- Runtime Methods ---

  // Track connections per tunnel to force close
  private activeSockets: Map<string, Set<net.Socket>> = new Map();

  stopTunnel(id: string): Promise<void> {
    return new Promise((resolve) => {
      const active = this.activeTunnels.get(id);
      if (!active || !active.server) {
        this.activeTunnels.delete(id);
        resolve();
        return;
      }

      // Forcefully destroy all open sockets for this tunnel
      const sockets = this.activeSockets.get(id);
      if (sockets) {
        for (const socket of sockets) {
          socket.destroy();
        }
        this.activeSockets.delete(id);
      }

      active.server.close(() => {
        this.activeTunnels.delete(id);
        resolve();
      });

      // Just in case callback never fires (though it should after sockets destroyed)
      // setTimeout(() => {
      //     this.activeTunnels.delete(id);
      //     resolve();
      // }, 1000);
    });
  }

  async startTunnel(sshClient: Client, tunnelId: string): Promise<void> {
    // Find config
    const tunnels = this.store.get('tunnels');
    const config = tunnels.find((t) => t.id === tunnelId);

    if (!config) throw new Error('Tunnel configuration not found');
    if (this.activeTunnels.has(tunnelId)) throw new Error('Tunnel already active');

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Track this socket
        if (!this.activeSockets.has(tunnelId)) {
          this.activeSockets.set(tunnelId, new Set());
        }
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
        // If it fails during startup, reject
        if (!this.activeTunnels.get(tunnelId)?.server.listening) {
          reject(err);
        }
      });

      try {
        server.listen(config.localPort, '127.0.0.1', () => {
          console.log(`[Tunnel ${config.id}] Listening on 127.0.0.1:${config.localPort}`);
          this.activeTunnels.set(tunnelId, { server });
          resolve();
        });
      } catch (e: any) {
        reject(e);
      }
    });
  }
}

export const tunnelManager = new TunnelManager();
