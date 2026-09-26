import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import semver from 'semver';

// This preflight mirrors author-facing manifest rules. Installation still relies on
// the native validator, which also enforces package and runtime security boundaries.
export const knownPermissionIds = Object.freeze([
  'ui.pane.register', 'ui.dashboard.register', 'ui.commands.register',
  'ui.status.register', 'ui.notifications.emit', 'ui.sidebar.register',
  'ui.settings.register', 'editor.provider.register', 'theme.pack.register',
  'connection.metadata.read', 'terminal.input.send', 'terminal.tab.create',
  'terminal.command.execute', 'ssh.command.execute',
  'filesystem.pluginData.read', 'filesystem.pluginData.write',
  'filesystem.external.read', 'filesystem.external.write', 'ssh.filesystem.read',
  'network.fetch', 'network.local', 'ui.dialog.confirm', 'clipboard.read',
  'clipboard.write', 'plugins.metadata.read',
]);

const knownPermissions = new Set(knownPermissionIds);
export const pluginApiVersion = '2.1.0';
const identifierPattern = /^[A-Za-z0-9_.-]+$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const contributionPermissions = {
  commands: 'ui.commands.register',
  paneKinds: 'ui.pane.register',
  dashboardCards: 'ui.dashboard.register',
};
const contributionLimits = { commands: 128, paneKinds: 64, dashboardCards: 64 };

function record(issues, location, message, severity = 'error') {
  issues.push({ path: location, message, severity });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(issues, value, location, maxLength, required = true) {
  if (value === undefined && !required) return false;
  if (typeof value !== 'string' || !value.trim() || [...value].length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    record(issues, location, `Must be non-empty text of at most ${maxLength} characters without controls`);
    return false;
  }
  return true;
}

function identifier(issues, value, location) {
  if (!text(issues, value, location, 128)) return false;
  if (!identifierPattern.test(value) || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    record(issues, location, 'Must be an identifier using letters, digits, dot, dash, or underscore');
    return false;
  }
  return true;
}

function assetPath(issues, value, location, required = false) {
  if (value === undefined && !required) return false;
  if (!text(issues, value, location, 260)) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    record(issues, location, 'Must be a relative path inside the plugin package');
    return false;
  }
  return true;
}

function httpsUrl(issues, value, location) {
  if (value === undefined || !text(issues, value, location, 2048)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return;
  } catch { /* Report one actionable error below. */ }
  record(issues, location, 'Must be an HTTPS URL without embedded credentials');
}

function permissionHost(issues, host, location) {
  if (typeof host !== 'string' || !host || /[/:@?#\\\s]/.test(host)) {
    record(issues, location, 'Must be a domain name without a scheme, path, port, or credentials');
    return;
  }
  if (host.includes('*') && !host.startsWith('*.')) {
    record(issues, location, 'A wildcard may appear only as a leading *.');
    return;
  }
  const domain = host.startsWith('*.') ? host.slice(2) : host;
  if (!domain || domain.includes('*') || isIP(domain) || domain.split('.').some(part => !part)) {
    record(issues, location, 'Must be a domain name, not an IP address');
    return;
  }
  try {
    if (new URL(`https://${domain}`).hostname) return;
  } catch { /* Report one actionable error below. */ }
  record(issues, location, 'Must be a valid domain name');
}

function validatePermissions(issues, value) {
  if (value === undefined) return new Set();
  if (!object(value)) {
    record(issues, 'permissions', 'Must be an object');
    return new Set();
  }
  const declared = new Set();
  let count = 0;
  for (const group of ['required', 'optional']) {
    const entries = value[group] ?? [];
    if (!Array.isArray(entries)) {
      record(issues, `permissions.${group}`, 'Must be an array');
      continue;
    }
    count += entries.length;
    entries.forEach((entry, index) => {
      const location = `permissions.${group}[${index}]`;
      if (!object(entry)) {
        record(issues, location, 'Must be an object');
        return;
      }
      if (identifier(issues, entry.id, `${location}.id`)) {
        if (declared.has(entry.id)) record(issues, `${location}.id`, 'Permission is declared more than once');
        declared.add(entry.id);
        if (!knownPermissions.has(entry.id)) {
          record(issues, `${location}.id`, group === 'required'
            ? 'Unknown required permission'
            : 'Unknown optional permission; Zync will deny it until supported', group === 'required' ? 'error' : 'warning');
        }
      }
      text(issues, entry.reason, `${location}.reason`, 240);
      text(issues, entry.scope, `${location}.scope`, 80, false);
      const hosts = entry.hosts ?? [];
      if (!Array.isArray(hosts)) {
        record(issues, `${location}.hosts`, 'Must be an array');
        return;
      }
      if (hosts.length > 32) record(issues, `${location}.hosts`, 'May contain at most 32 hosts');
      if (hosts.length && !['network.fetch', 'network.local'].includes(entry.id)) {
        record(issues, `${location}.hosts`, 'Only network permissions may declare hosts');
      }
      if (entry.id === 'network.fetch' && !hosts.length) {
        record(issues, `${location}.hosts`, 'network.fetch requires at least one host');
      }
      const seen = new Set();
      hosts.forEach((host, hostIndex) => {
        permissionHost(issues, host, `${location}.hosts[${hostIndex}]`);
        if (typeof host === 'string') {
          const key = host.toLowerCase();
          if (seen.has(key)) record(issues, `${location}.hosts[${hostIndex}]`, 'Host is declared more than once');
          seen.add(key);
        }
      });
    });
  }
  if (count > 64) record(issues, 'permissions', 'May declare at most 64 permissions');
  return declared;
}

function validateContributions(issues, value, declared, assets) {
  if (value === undefined) return;
  if (!object(value)) {
    record(issues, 'contributes', 'Must be an object');
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(key in contributionLimits)) record(issues, `contributes.${key}`, 'Unknown contribution kind');
  }
  for (const [kind, limit] of Object.entries(contributionLimits)) {
    const entries = value[kind] ?? [];
    if (!Array.isArray(entries)) {
      record(issues, `contributes.${kind}`, 'Must be an array');
      continue;
    }
    if (entries.length > limit) record(issues, `contributes.${kind}`, `May contain at most ${limit} entries`);
    if (entries.length && !declared.has(contributionPermissions[kind])) {
      record(issues, `contributes.${kind}`, `Requires ${contributionPermissions[kind]} permission`);
    }
    const seen = new Set();
    entries.forEach((entry, index) => {
      const location = `contributes.${kind}[${index}]`;
      if (!object(entry)) {
        record(issues, location, 'Must be an object');
        return;
      }
      if (identifier(issues, entry.id, `${location}.id`)) {
        if (seen.has(entry.id)) record(issues, `${location}.id`, 'Contribution id is declared more than once');
        seen.add(entry.id);
      }
      text(issues, entry.title, `${location}.title`, 120);
      if (kind !== 'commands') {
        if (assetPath(issues, entry.entry, `${location}.entry`, true)) assets.push({ path: entry.entry, location: `${location}.entry` });
        if (entry.allowMultiple !== undefined && typeof entry.allowMultiple !== 'boolean') {
          record(issues, `${location}.allowMultiple`, 'Must be a boolean');
        }
      }
    });
  }
}

function engineRange(issues, range, location, installedVersion) {
  if (!text(issues, range, location, 80)) return;
  // Rust's host-side VersionReq does not support npm's union and hyphen syntax.
  if (range.includes('||') || /\s-\s/.test(range) || !semver.validRange(range)) {
    record(issues, location, 'Must be a supported semantic version range');
    return;
  }
  if (installedVersion !== undefined) {
    if (!semver.valid(installedVersion)) {
      record(issues, location, `Target version is invalid: ${installedVersion}`);
    } else if (!semver.satisfies(installedVersion, range)) {
      record(issues, location, `Requires ${range}, but the target provides ${installedVersion}`);
    }
  }
}

export function validateManifest(manifest, options = {}) {
  const issues = [];
  const assets = [];
  if (!object(manifest)) {
    record(issues, 'manifest', 'Must be a JSON object');
    return { valid: false, issues, assets };
  }
  if (manifest.manifestVersion !== 2) record(issues, 'manifestVersion', 'Must be 2');
  const validId = identifier(issues, manifest.id, 'id');
  text(issues, manifest.name, 'name', 80);
  const versionMatch = text(issues, manifest.version, 'version', 64) && semverPattern.exec(manifest.version);
  if (versionMatch && versionMatch[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    record(issues, 'version', 'Numeric prerelease identifiers must not have leading zeroes');
  } else if (typeof manifest.version === 'string' && !versionMatch) {
    record(issues, 'version', 'Must be a semantic version such as 1.0.0 or 1.0.0-beta.1');
  }
  const validPublisher = identifier(issues, manifest.publisher, 'publisher');
  if (validId && validPublisher && !manifest.id.startsWith(`${manifest.publisher}.`)) {
    record(issues, 'id', 'Must be namespaced to the publisher');
  }
  if (!object(manifest.engines)) {
    record(issues, 'engines', 'Must declare zync and pluginApi version ranges');
  } else {
    engineRange(issues, manifest.engines.zync, 'engines.zync', options.zyncVersion);
    engineRange(issues, manifest.engines.pluginApi, 'engines.pluginApi', options.pluginApiVersion ?? pluginApiVersion);
  }
  text(issues, manifest.description, 'description', 500, false);
  text(issues, manifest.license, 'license', 80, false);
  for (const field of ['homepage', 'support', 'privacyPolicy']) httpsUrl(issues, manifest[field], field);
  if (manifest.runtime !== undefined && !object(manifest.runtime)) {
    record(issues, 'runtime', 'Must be an object');
  } else if (manifest.runtime && assetPath(issues, manifest.runtime.entry, 'runtime.entry')) {
    assets.push({ path: manifest.runtime.entry, location: 'runtime.entry' });
  }
  for (const field of ['main', 'style', 'icon']) {
    if (assetPath(issues, manifest[field], field)) assets.push({ path: manifest[field], location: field });
  }
  const declared = validatePermissions(issues, manifest.permissions);
  validateContributions(issues, manifest.contributes, declared, assets);
  return { valid: !issues.some(issue => issue.severity === 'error'), issues, assets };
}

export function validatePackageDirectory(directory, options = {}) {
  const root = path.resolve(directory);
  const issues = [];
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { /* Report below. */ }
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    record(issues, 'package', 'Must be an existing directory, not a link');
    return { valid: false, issues };
  }
  const manifestPath = path.join(root, 'manifest.json');
  let manifestStat;
  try { manifestStat = fs.lstatSync(manifestPath); } catch { /* Report below. */ }
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    record(issues, 'manifest.json', 'Must be a regular file');
    return { valid: false, issues };
  }
  if (manifestStat.size > 256 * 1024) {
    record(issues, 'manifest.json', 'Exceeds the native 256 KiB manifest limit');
    return { valid: false, issues };
  }
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(manifestPath))); }
  catch (error) {
    record(issues, 'manifest.json', `Invalid JSON: ${error.message}`);
    return { valid: false, issues };
  }
  const result = validateManifest(manifest, options);
  issues.push(...result.issues);
  for (const asset of result.assets) {
    let current = root;
    let valid = true;
    for (const segment of asset.path.split('/')) {
      current = path.join(current, segment);
      let stat;
      try { stat = fs.lstatSync(current); } catch { /* Report below. */ }
      if (!stat || stat.isSymbolicLink()) {
        record(issues, asset.location, `Referenced file is missing or linked: ${asset.path}`);
        valid = false;
        break;
      }
    }
    if (valid && !fs.lstatSync(current).isFile()) record(issues, asset.location, `Referenced path is not a file: ${asset.path}`);
  }
  const pending = [root];
  let entries = 0;
  let totalBytes = 0;
  while (pending.length) {
    const parent = pending.pop();
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const absolute = path.join(parent, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      entries += 1;
      if (entries > 2_048) {
        record(issues, 'package', 'Contains more than 2,048 entries');
        pending.length = 0;
        break;
      }
      if (Buffer.byteLength(relative) > 512 || relative.split('/').some(part => part.includes(':') || /[\u0000-\u001f\u007f]/.test(part))) {
        record(issues, relative, 'Invalid package path');
      }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        record(issues, relative, 'Package entries must be regular files or directories, not links');
      } else if (stat.isDirectory()) {
        pending.push(absolute);
      } else {
        if (stat.size > 20 * 1024 * 1024) record(issues, relative, 'File exceeds the native 20 MiB limit');
        totalBytes += stat.size;
      }
    }
  }
  if (totalBytes > 100 * 1024 * 1024) record(issues, 'package', 'Exceeds the native 100 MiB expanded-size limit');
  return { valid: !issues.some(issue => issue.severity === 'error'), issues };
}
