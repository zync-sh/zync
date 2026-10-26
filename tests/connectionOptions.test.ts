import { buildConnectConfigResult } from '../src/features/connections/domain/connectionConfig.js';
import { buildConnectionSavePayload, buildConnectionTestPayload, connectionTestDependencies } from '../src/features/connections/domain/formTransforms.js';
import { applyAuthMethodTransition } from '../src/features/connections/domain/authMethodTransition.js';
import { getCredentialHealthChecks, validateConnectionDraft } from '../src/features/connections/domain/validation.js';
import { connectionFailureReason, connectionFailureSummary, orderedInterfaceAddresses } from '../src/features/connections/domain/formPresentation.js';
import type { Connection } from '../src/features/connections/domain/types.js';
import { assignCredentialToConnections, syncCredentialAssignments } from '../src/features/connections/domain/credentialAssignments.js';
import { preserveVaultCredentialOnUpdate, mergeImportedConnectionsByName } from '../src/features/connections/domain/merge.js';

/** Fail with useful labels without adding a second test framework. */
function equal(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
}

const host: Connection = { id: 'cert', name: 'Certificate host', host: 'fixture.invalid', port: 22,
    username: 'fixture', privateKeyPath: '/keys/user', certificatePath: '/keys/user-cert.pub', status: 'disconnected' };
const jump: Connection = { ...host, id: 'jump', certificatePath: '/keys/jump-cert.pub' };
const result = buildConnectConfigResult([{ ...host, jumpServerId: jump.id }, jump], host.id);
if (result.status !== 'ok') throw new Error('Expected valid certificate connection');
equal(result.config.certificate_path, host.certificatePath, 'Connect preserves certificate');
equal(result.config.jump_host?.certificate_path, jump.certificatePath, 'Jump host has its own certificate');
const test = buildConnectionTestPayload({ formData: host, authMethod: 'key', connections: [] });
equal(test.certificate_path, host.certificatePath, 'Test and connect use same certificate');
const stalePasswordDraft = { ...host, privateKeyPath: undefined, password: 'fixture' };
equal(buildConnectionTestPayload({ formData: stalePasswordDraft, authMethod: 'password', connections: [] }).certificate_path,
    undefined, 'Password test omits a stale certificate even if it remains in the draft');
const passwordJump = { ...stalePasswordDraft, id: 'password-jump' };
equal(buildConnectionTestPayload({ formData: { ...host, jumpServerId: passwordJump.id }, authMethod: 'key', connections: [passwordJump] })
    .jump_host?.certificate_path, undefined, 'Password jump hops omit stale certificates independently');
const saved = buildConnectionSavePayload({ formData: host, authMethod: 'key', editingConnectionId: host.id, connections: [host] });
equal(saved.certificatePath, host.certificatePath, 'Save preserves certificate path');
equal(saved.password, undefined, 'Certificate save never persists passphrase');
equal(applyAuthMethodTransition(host, 'key', 'password').certificatePath, undefined, 'Password switch clears certificate');
equal(validateConnectionDraft({ ...host, certificatePath: 'bad\nCertificateFile injected' }, 'key').ok, false, 'Reject certificate path newline');
const vault = buildConnectConfigResult([{ ...host, authRef: { vaultId: 'v', itemId: 'i', itemKind: 'ssh-private-key', purpose: 'ssh-auth' } }], host.id);
if (vault.status !== 'ok') throw new Error('Expected vault certificate connection');
equal(vault.config.auth_method.type, 'VaultRef', 'Existing vault resolution remains authoritative');
equal(vault.config.certificate_path, host.certificatePath, 'Certificate also accompanies vault keys');
console.log('Connection certificate regression checks passed');

const passwordRef = { vaultId: 'v', itemId: 'p', itemKind: 'ssh-password', purpose: 'ssh-auth' } as const;
equal(assignCredentialToConnections([host], [host.id], passwordRef)[0].certificatePath, undefined, 'Password assignment clears certificate');
equal(preserveVaultCredentialOnUpdate({ ...host, authRef: passwordRef }, host).certificatePath, undefined,
    'Import cannot attach a key certificate to a preserved vault password');
const metadataOnly: Connection = { id: 'incoming', name: host.name, host: host.host, port: host.port, username: host.username, status: 'disconnected' };
const vaultKeyRef = { vaultId: 'v', itemId: 'key', itemKind: 'ssh-private-key', purpose: 'ssh-auth' } as const;
equal(mergeImportedConnectionsByName([{ ...host, authRef: vaultKeyRef }], [metadataOnly]).merged[0].certificatePath,
    host.certificatePath, 'Metadata-only import preserves an existing local certificate for a retained vault key');
equal(mergeImportedConnectionsByName([{ ...host, authRef: passwordRef }], [metadataOnly]).merged[0].certificatePath,
    undefined, 'Metadata-only import clears incompatible certificate for a retained vault password');
equal(syncCredentialAssignments([host], [host.id], passwordRef)[0].certificatePath, undefined, 'Bulk password assignment clears certificate');
equal(buildConnectionSavePayload({ formData: { ...host, authRef: passwordRef }, authMethod: 'vault', editingConnectionId: host.id, connections: [host] }).certificatePath,
    undefined, 'Vault password form does not persist certificate');

equal(getCredentialHealthChecks(host, 'key', { keyInspected: true }), [],
    'Successful content inspection suppresses contradictory filename hints');
equal(getCredentialHealthChecks({ ...host, privateKeyPath: '/keys/client.pub' }, 'key', { keyInspected: true }), [],
    'Content inspection supersedes even a misleading extension');
equal(getCredentialHealthChecks(host, 'key').some(item => item.message.includes('uncommon')), true,
    'Pre-inspection callers retain existing hints');
equal(buildConnectionSavePayload({ formData: { ...host, name: '' }, authMethod: 'key', editingConnectionId: null, connections: [] }).name,
    host.host, 'Optional display name reuses existing host fallback');
equal(buildConnectionTestPayload({ formData: { ...host, name: '' }, authMethod: 'key', connections: [] }).name,
    host.host, 'Test uses the same display-name fallback');
equal(orderedInterfaceAddresses(['::1', '127.0.0.1', '::1', 'fe80::123']), ['127.0.0.1', '::1', 'fe80::123'],
    'IPv4 is first, duplicates removed and remaining addresses retained');
equal(connectionFailureSummary('Connection failed: actively refused (os error 10061)').startsWith('Connection refused.'), true,
    'Connection refusal provides actionable guidance');
equal(connectionFailureSummary('Authentication failed').includes('remote username'), true,
    'Authentication rejection does not claim a specific account exists or is invalid');
equal(connectionFailureSummary('certificate identity rejected'), 'Could not verify this connection. Review the details below.',
    'Unknown failures are not misclassified');
for (const [message, reason, summary] of [
    ['SSH user certificate has expired', 'SSH certificate has expired.', 'Certificate expired. Renew it and select the updated certificate.'],
    ['SSH user certificate does not match its private key', 'Certificate and private key do not match.', 'Certificate and private key do not match. Select a matching pair.'],
    ['Connection failed: actively refused (os error 10061)', 'Connection refused.', 'Connection refused. Check the host, port and whether the SSH server is running.'],
    ['Socket error (os error 111)', 'Connection refused.', 'Connection refused. Check the host, port and whether the SSH server is running.'],
    ['Socket error (os error 61)', 'Connection refused.', 'Connection refused. Check the host, port and whether the SSH server is running.'],
    ['Connection timed out while connecting to fixture.invalid:22', 'Connection timed out.', 'Connection timed out. Check the network, firewall and selected adapter.'],
    ['Socket error (os error 10060)', 'Connection timed out.', 'Connection timed out. Check the network, firewall and selected adapter.'],
    ['Authentication rejected', 'Authentication failed.', 'Authentication failed. Check the remote username and selected credential.'],
]) {
    equal(connectionFailureReason(message), reason, 'Recovery card uses the shared recognized failure cause');
    equal(connectionFailureSummary(message), summary, 'Host form keeps its existing actionable summary');
}
for (const message of [undefined, '', 'certificate identity rejected', 'fixture-only unknown failure <img src=x onerror=alert(1)>']) {
    equal(connectionFailureReason(message), 'Could not connect to this host.', 'Unknown diagnostics remain generic without echoing raw server text');
}
console.log('Host form presentation regression checks passed');

const forwarded = { ...host, id: 'forwarded' };
const dependencyJump = { ...jump, agentForwardingKeyConnectionId: forwarded.id };
const dependencyDraft = { ...host, jumpServerId: jump.id, agentForwardingKeyConnectionId: forwarded.id };
const dependencies = connectionTestDependencies([host, dependencyJump, forwarded], dependencyDraft);
equal(dependencies.map(item => item.id), [jump.id, forwarded.id], 'Snapshot includes jump chain and offered keys once');
const volatileUpdates = [host, dependencyJump, forwarded].map(item => ({ ...item, status: 'connected' as const,
    lastError: 'fixture transient', homePath: '/new-home', lastConnected: 123, authRef: item.authRef && { ...item.authRef } }));
equal(connectionTestDependencies([...volatileUpdates, { ...host, id: 'unrelated' }], dependencyDraft, dependencies) === dependencies,
    true, 'Status, unrelated additions and cloned auth metadata retain snapshot identity');
for (const changed of [
    { ...dependencyJump, host: 'changed.invalid' },
    { ...dependencyJump, certificatePath: '/renewed-cert.pub' },
    { ...dependencyJump, jumpServerId: host.id },
    { ...dependencyJump, authRef: vaultKeyRef },
]) {
    equal(connectionTestDependencies([host, changed, forwarded], dependencyDraft, dependencies) === dependencies,
        false, 'Relevant jump endpoint, certificate, route or auth change invalidates the snapshot');
}
equal(connectionTestDependencies([host, dependencyJump, { ...forwarded, privateKeyPath: '/replacement-key' }], dependencyDraft, dependencies) === dependencies,
    false, 'Offered-key changes invalidate an active test');
equal(connectionTestDependencies([host, dependencyJump], dependencyDraft, dependencies) === dependencies,
    false, 'Removing a referenced key invalidates the snapshot');
equal(connectionTestDependencies([{ ...jump, jumpServerId: jump.id }], { jumpServerId: jump.id }).length, 1,
    'Dependency traversal terminates on a cyclic jump chain');
console.log('Connection test dependency regressions passed');
