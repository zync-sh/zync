import assert from 'node:assert/strict';
import {
  buildConnectionSavePayload,
  buildConnectionTestPayload,
  canSaveInspectedPrivateKey,
  SELF_AGENT_FORWARDING_KEY,
} from '../.tmp-agent-tests/src/features/connections/domain/formTransforms.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('buildConnectionSavePayload keeps existing edit status', () => {
  const formData = {
    name: 'web',
    host: '10.0.0.1',
    username: 'root',
    port: 22,
    password: 'secret',
  };

  const connections = [{ id: 'c1', name: 'web', status: 'connected' }];
  const payload = buildConnectionSavePayload({
    formData,
    authMethod: 'password',
    editingConnectionId: 'c1',
    connections,
  });

  assert.equal(payload.id, 'c1');
  assert.equal(payload.status, 'connected');
  assert.equal(payload.password, 'secret');
});

runTest('buildConnectionSavePayload sets disconnected for valid new connection', () => {
  const payload = buildConnectionSavePayload({
    formData: { host: '10.0.0.2', username: 'ubuntu', port: 22 },
    authMethod: 'password',
    editingConnectionId: null,
    connections: [],
  });

  assert.equal(payload.status, 'disconnected');
  assert.equal(payload.port, 22);
  assert.equal(payload.privateKeyPath, undefined);
});

runTest('buildConnectionSavePayload throws on invalid port', () => {
  assert.throws(
    () =>
      buildConnectionSavePayload({
        formData: { host: '10.0.0.2', username: 'ubuntu', port: 70000 },
        authMethod: 'password',
        editingConnectionId: null,
        connections: [],
      }),
    /Port must be an integer between 1 and 65535/
  );
});

runTest('buildConnectionSavePayload never persists key passphrase on the host', () => {
  const payload = buildConnectionSavePayload({
    formData: {
      host: '10.0.0.2',
      username: 'ubuntu',
      port: 22,
      privateKeyPath: '/tmp/id_ed25519',
      password: '  key passphrase  ',
    },
    authMethod: 'key',
    editingConnectionId: null,
    connections: [],
  });

  assert.equal(payload.privateKeyPath, '/tmp/id_ed25519');
  assert.equal(payload.password, undefined);
  assert.equal(payload.authRef, undefined);
});

runTest('buildConnectionSavePayload persists explicit self key selection as the connection id', () => {
  const payload = buildConnectionSavePayload({
    formData: {
      host: '10.0.0.2',
      username: 'ubuntu',
      port: 22,
      privateKeyPath: '/tmp/id_ed25519',
      agentForwardingKeyConnectionId: SELF_AGENT_FORWARDING_KEY,
    },
    authMethod: 'key',
    editingConnectionId: null,
    connections: [],
  });

  assert.equal(payload.agentForwardingKeyConnectionId, payload.id);
});

runTest('encrypted keys can be saved without a passphrase for connect-time prompting', () => {
  assert.equal(canSaveInspectedPrivateKey('passphraseRequired', ''), true);
  assert.equal(canSaveInspectedPrivateKey('passphraseRequired', 'partial'), false);
  assert.equal(canSaveInspectedPrivateKey('valid', 'correct passphrase'), true);
  assert.equal(canSaveInspectedPrivateKey('invalidPassphrase', 'wrong passphrase'), false);
  assert.equal(canSaveInspectedPrivateKey('invalidKey', ''), false);
});

runTest('buildConnectionTestPayload passes key passphrase through PrivateKey auth', () => {
  const payload = buildConnectionTestPayload({
    formData: {
      id: 'main',
      name: 'main',
      host: '192.168.0.10',
      username: 'ec2-user',
      port: 22,
      privateKeyPath: '/tmp/key.pem',
      password: 'enc-pass',
    },
    authMethod: 'key',
    connections: [],
  });

  assert.equal(payload.auth_method.type, 'PrivateKey');
  assert.equal(payload.auth_method.passphrase, 'enc-pass');
});

runTest('buildConnectionTestPayload builds key auth config and jump host', () => {
  const formData = {
    id: 'main',
    name: 'main',
    host: '192.168.0.10',
    username: 'ec2-user',
    port: 22,
    privateKeyPath: '/tmp/key.pem',
    jumpServerId: 'jump1',
  };
  const connections = [
    {
      id: 'jump1',
      name: 'jump',
      host: '192.168.0.1',
      username: 'ubuntu',
      port: 22,
      password: 'jump-pass',
      jumpServerId: 'jump2',
    },
    {
      id: 'jump2',
      name: 'jump-2',
      host: '192.168.0.2',
      username: 'ec2-user',
      port: 2222,
      privateKeyPath: '/tmp/jump2.pem',
    },
  ];

  const payload = buildConnectionTestPayload({
    formData,
    authMethod: 'key',
    connections,
  });

  assert.equal(payload.auth_method.type, 'PrivateKey');
  assert.equal(payload.jump_host?.auth_method.type, 'Password');
  assert.equal(payload.jump_host?.host, '192.168.0.1');
  assert.equal(payload.jump_host?.jump_host?.host, '192.168.0.2');
});

runTest('buildConnectionTestPayload forwards only the explicitly selected saved key', () => {
  const connections = [{
    id: 'key-source',
    name: 'key source',
    host: 'source.invalid',
    username: 'ubuntu',
    port: 22,
    privateKeyPath: '/tmp/forward-only.pem',
    status: 'disconnected',
  }];
  const payload = buildConnectionTestPayload({
    formData: {
      id: 'password-host',
      name: 'password host',
      host: '10.0.0.20',
      username: 'root',
      port: 22,
      password: 'login-password',
      agentForwardingKeyConnectionId: 'key-source',
    },
    authMethod: 'password',
    connections,
  });

  assert.equal(payload.auth_method.type, 'Password');
  assert.equal(payload.agent_forwarding?.source_connection_id, 'key-source');
  assert.equal(payload.agent_forwarding?.auth_method.type, 'PrivateKey');
  assert.equal(payload.agent_forwarding?.auth_method.key_path, '/tmp/forward-only.pem');
});

runTest('buildConnectionTestPayload includes stable credential id for vault auth', () => {
  const formData = {
    id: 'main',
    name: 'main',
    host: '192.168.0.10',
    username: 'ec2-user',
    port: 22,
    authRef: {
      vaultId: 'vault-1',
      credentialId: 'cred-1',
      itemId: 'item-1',
      itemKind: 'ssh-private-key',
      purpose: 'ssh-auth',
    },
  };

  const payload = buildConnectionTestPayload({
    formData,
    authMethod: 'vault',
    connections: [],
  });

  assert.equal(payload.auth_method.type, 'VaultRef');
  assert.equal(payload.auth_method.item_id, 'item-1');
  assert.equal(payload.auth_method.credential_id, 'cred-1');
});

runTest('buildConnectionTestPayload handles vault auth without credential_id', () => {
  const formData = {
    id: 'main',
    name: 'main',
    host: '192.168.0.10',
    username: 'ec2-user',
    port: 22,
    authRef: {
      vaultId: 'vault-1',
      itemId: 'item-legacy',
      itemKind: 'ssh-private-key',
      purpose: 'ssh-auth',
    },
  };

  const payload = buildConnectionTestPayload({
    formData,
    authMethod: 'vault',
    connections: [],
  });

  assert.equal(payload.auth_method.type, 'VaultRef');
  assert.equal(payload.auth_method.item_id, 'item-legacy');
  assert.equal(payload.auth_method.credential_id, undefined);
});

runTest('buildConnectionSavePayload persists SSH-agent auth with selected key', () => {
  const payload = buildConnectionSavePayload({
    formData: {
      host: '10.0.0.3',
      username: 'deploy',
      port: 22,
      agentKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq45yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ bitwarden',
    },
    authMethod: 'agent',
    editingConnectionId: null,
    connections: [],
  });

  assert.equal(payload.useSshAgent, true);
  assert.equal(payload.agentKey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq45yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ bitwarden');
  assert.equal(payload.password, undefined);
  assert.equal(payload.privateKeyPath, undefined);
});

runTest('buildConnectionSavePayload persists SSH-agent auth without a key selection', () => {
  const payload = buildConnectionSavePayload({
    formData: { host: '10.0.0.3', username: 'deploy', port: 22 },
    authMethod: 'agent',
    editingConnectionId: null,
    connections: [],
  });

  assert.equal(payload.useSshAgent, true);
  assert.equal(payload.agentKey, undefined);
});

runTest('buildConnectionTestPayload sends SshAgent auth method from the form', () => {
  const payload = buildConnectionTestPayload({
    formData: {
      id: 'main',
      name: 'main',
      host: '10.0.0.3',
      username: 'deploy',
      port: 22,
      useSshAgent: true,
      agentKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq45yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ',
    },
    authMethod: 'agent',
    connections: [],
  });

  assert.equal(payload.auth_method.type, 'SshAgent');
  assert.equal(payload.auth_method.public_key, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq45yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ');
});

runTest('buildConnectionTestPayload omits public_key when the agent picks the key', () => {
  const payload = buildConnectionTestPayload({
    formData: {
      id: 'main',
      name: 'main',
      host: '10.0.0.3',
      username: 'deploy',
      port: 22,
      useSshAgent: true,
    },
    authMethod: 'agent',
    connections: [],
  });

  assert.equal(payload.auth_method.type, 'SshAgent');
  assert.equal(payload.auth_method.public_key, undefined);
});

runTest('buildConnectionTestPayload resolves SshAgent from a saved connection', () => {
  const saved = {
    id: 'saved-1',
    name: 'agent-host',
    host: '10.0.0.4',
    username: 'deploy',
    port: 22,
    useSshAgent: true,
    agentKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq45yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ',
  };

  const payload = buildConnectionTestPayload({
    formData: saved,
    authMethod: 'agent',
    connections: [saved],
  });

  assert.equal(payload.auth_method.type, 'SshAgent');
  assert.equal(payload.auth_method.public_key, saved.agentKey);
});

console.log('Connection form transform tests passed.');
