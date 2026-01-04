import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ParsedSSHConnection {
  id: string;
  name: string;
  host: string;
  username: string;
  port: number;
  privateKeyPath?: string;
  jumpServerAlias?: string; // Temporary holder for ProxyJump alias
  jumpServerId?: string; // Resolved ID
}

export class SSHConfigParser {
  private configPath: string;

  constructor(customPath?: string) {
    this.configPath = customPath || path.join(os.homedir(), '.ssh', 'config');
  }

  public async parse(): Promise<ParsedSSHConnection[]> {
    if (!fs.existsSync(this.configPath)) {
      console.warn(`SSH config file not found at ${this.configPath}`);
      return [];
    }

    const content = await fs.promises.readFile(this.configPath, 'utf8');
    const lines = content.split('\n');

    const connections: ParsedSSHConnection[] = [];
    let currentHost: Partial<ParsedSSHConnection> | null = null;
    const _globalOptions: { [key: string]: string } = {}; // To handle options outside of Host blocks if any

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;

      // Strip inline comments first
      const lineWithoutComment = line.split('#')[0].trim();
      if (!lineWithoutComment) continue;

      // Robust Key-Value parsing
      // Regex matches: Keyword, optional equals, then value
      // We strip comments so value captures the rest of the string
      const match = lineWithoutComment.match(/^([a-zA-Z0-9]+)(?:\s*[=]?\s*)(.+)$/);
      if (!match) continue;

      const key = match[1];
      let value = match[2].trim(); // Ensure trimmed

      console.log(`[Parser] Found key: ${key}, value: ${value}`);

      // Strip surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
        console.log(`[Parser] Stripped quotes: ${value}`);
      } else {
        console.log(`[Parser] No quotes detected or mismatched.`);
      }

      if (key.toLowerCase() === 'host') {
        // Save previous host if exists and is valid
        if (currentHost?.name && currentHost.host) {
          // Add defaults if missing
          if (!currentHost.port) currentHost.port = 22;
          // Generate ID
          currentHost.id = Math.random().toString(36).substr(2, 9);

          // Only add if it's not a wildcard host (e.g. Host *)
          if (!currentHost.name.includes('*') && !currentHost.name.includes('?')) {
            connections.push(currentHost as ParsedSSHConnection);
          }
        }

        // Start new host
        const aliases = value.split(/\s+/); // Host can have multiple aliases
        currentHost = {
          name: aliases[0], // Use first alias as name
          // Default values
          username: os.userInfo().username,
        };
      } else if (currentHost) {
        switch (key.toLowerCase()) {
          case 'hostname':
            currentHost.host = value;
            break;
          case 'user':
            currentHost.username = value;
            break;
          case 'port':
            currentHost.port = parseInt(value, 10);
            break;
          case 'identityfile':
            // Resolve ~ to home dir
            if (value.startsWith('~')) {
              value = path.join(os.homedir(), value.slice(1));
            }
            currentHost.privateKeyPath = value;
            break;
          case 'proxyjump':
            currentHost.jumpServerAlias = value;
            break;
        }
      }
    }

    // Add last host
    if (currentHost?.name && currentHost.host) {
      if (!currentHost.port) currentHost.port = 22;
      currentHost.id = Math.random().toString(36).substr(2, 9);
      if (!currentHost.name.includes('*') && !currentHost.name.includes('?')) {
        connections.push(currentHost as ParsedSSHConnection);
      }
    }

    // Second Pass: Resolve ProxyJump
    // We need to map jumpServerAlias to the actual ID of the imported connection
    const aliasToIdMap = new Map<string, string>();
    connections.forEach((c) => aliasToIdMap.set(c.name, c.id));

    connections.forEach((c) => {
      if (c.jumpServerAlias) {
        const targetId = aliasToIdMap.get(c.jumpServerAlias);
        if (targetId) {
          c.jumpServerId = targetId;
        }
      }
      delete c.jumpServerAlias; // Cleanup
    });

    return connections;
  }
}
