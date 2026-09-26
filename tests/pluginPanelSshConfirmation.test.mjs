import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src', 'components', 'plugins', 'PluginPanel.tsx'),
  'utf8',
);
const workerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'context', 'PluginContext.tsx'),
  'utf8',
);
const brokerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'plugins', 'broker', 'pluginMessageBroker.ts'),
  'utf8',
);
const notificationBrokerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'plugins', 'broker', 'pluginNotificationBroker.ts'),
  'utf8',
);
const confirmationSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'plugins', 'confirmPluginTerminalAction.ts'),
  'utf8',
);
const settingsPluginsSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'components', 'settings', 'hooks', 'useSettingsPlugins.ts'),
  'utf8',
);
const marketplaceSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'components', 'settings', 'Marketplace.tsx'),
  'utf8',
);
const installedPluginsSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'components', 'settings', 'tabs', 'plugins', 'PluginsInstalledTab.tsx'),
  'utf8',
);
const nativeRuntimeSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'plugins', 'runtime', 'nativePluginRuntime.ts'),
  'utf8',
);
const pluginStorageSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'plugins', 'runtime', 'pluginStorage.ts'),
  'utf8',
);
const pluginManagementSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'plugins', 'management', 'pluginManagement.ts'),
  'utf8',
);
const nativeRollbackSource = fs.readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'plugins', 'rollback.rs'),
  'utf8',
);
const nativeInstallReviewSource = fs.readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'plugins', 'install', 'review.rs'),
  'utf8',
);
const pluginNetworkSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'plugins', 'runtime', 'pluginNetwork.ts'),
  'utf8',
);
const nativeNetworkSource = fs.readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'plugins', 'network.rs'),
  'utf8',
);
const pluginFilesystemSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'plugins', 'runtime', 'pluginFilesystem.ts'),
  'utf8',
);
const nativeFilesystemSource = [
  'mod.rs',
  'path_policy.rs',
  'atomic_write.rs',
].map(file => fs.readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'plugins', 'filesystem', file),
  'utf8',
)).join('\n');
const nativeSshFilesystemSource = fs.readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'plugins', 'ssh_filesystem.rs'),
  'utf8',
);
const demoWorkerSource = fs.readFileSync(
  path.join(process.cwd(), 'tests', 'fixtures', 'plugins', 'manifest-v2-demo', 'worker.js'),
  'utf8',
);
const pluginDetailsSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'components', 'settings', 'tabs', 'plugins', 'PluginDetailsDialog.tsx'),
  'utf8',
);
const nativeCommandsSource = fs.readFileSync(
  path.join(process.cwd(), 'src-tauri', 'src', 'commands.rs'),
  'utf8',
);

assert.match(source, /handlePanelPluginCommand/, 'panel privileged messages must use the tested bridge');
assert.match(source, /confirmUi: options => useAppStore\.getState\(\)\.showConfirmDialog\(options\)/, 'panel confirmations must use the lifecycle-aware bridge');
assert.match(source, /frameGenerationRef\.current === generation/, 'approval must be tied to one loaded iframe document');
assert.match(source, /active\s*&&\s*iframeRef\.current\?\.contentWindow === requester/, 'unmounted or replaced frames must be rejected');
assert.match(source, /frameGenerationRef\.current \+= 1/, 'iframe loads must advance the lifecycle generation');
assert.match(source, /loadSshInvoker:[\s\S]*ipcRenderer\.invoke\([\s\S]*'ssh_exec'/, 'SSH IPC must be injected into the tested bridge');
assert.match(source, /sandbox=\{legacyAccess \? 'allow-scripts allow-modals' : 'allow-scripts'\}/, 'Manifest v2 frames must receive only script execution, without same-origin or modal access');
assert.match(source, /Content-Security-Policy/, 'Manifest v2 panes must receive a restrictive CSP');
assert.doesNotMatch(source, /legacyAccess \? '' : `\s*<meta http-equiv="Content-Security-Policy"/, 'legacy panes must not skip the frame CSP');
assert.match(source, /connect-src 'none'/, 'all plugin panes must be unable to use the app network allowlist');
assert.match(source, /if \(!legacyAccess\) \{[\s\S]{0,240}parsePluginPaneMessage[\s\S]{0,240}return;/, 'Manifest v2 panes must use only the bounded pane message channel');
assert.match(brokerSource, /case 'api:panel:post-message'/, 'Workers must use the pane-scoped return channel');
assert.match(workerSource, /getPaneMessageTarget:[\s\S]{0,160}paneMessageTargets\.current\.get\(`\$\{pluginId\}\\0\$\{paneInstanceId\}`\)/, 'pane replies must be scoped by host-owned plugin and pane instance');
assert.match(workerSource, /handlePluginMessage\(plugin\.manifest\.id, type, payload, worker\)/, 'worker identity must travel with its message');
assert.match(workerSource, /handleWorkerTerminalCommand/, 'worker terminal input must use the tested bridge');
assert.match(notificationBrokerSource, /runtime\.isCurrentWorker\(pluginId, requester\)/, 'stale workers must be rejected after confirmation');
assert.match(workerSource, /if \(!runtimeSupervisor\.current\.isCurrentWorker\(pluginId, requester\)\) return;/, 'all messages from a terminated Worker must be rejected');
assert.match(workerSource, /runtimeSupervisor\.current\.stopAll/, 'plugin reloads must stop the previous Worker generation');
assert.match(workerSource, /runtimeSupervisor\.current\.markCrash/, 'Worker crashes must be recorded by the runtime supervisor');
assert.match(workerSource, /runtimeSupervisor\.current\.pollHeartbeats/, 'unresponsive Workers must be detected by the runtime supervisor');
assert.match(workerSource, /type === 'host:heartbeat:ping'/, 'the Worker bootstrap must answer host heartbeat probes');
assert.match(workerSource, /setCommands\(\[\]\)/, 'plugin reloads must discard registrations from the previous Worker generation');
assert.match(workerSource, /reloadPlugins:\s*\(healthCheckPluginId\?: string\)\s*=>\s*Promise<boolean>/, 'the plugin runtime must expose a health-checkable live reload contract');
assert.match(workerSource, /startNativePluginRuntime/, 'each Worker generation must receive a native runtime identity before startup');
assert.match(notificationBrokerSource, /authorizePluginCapability\(runtimeInstanceId, 'ui\.notifications\.emit'\)/, 'plugin notifications must pass through native capability authorization');
assert.match(brokerSource, /authorizePluginCommandRegistration/, 'plugin command registration must pass through native contribution and permission authorization');
assert.match(brokerSource, /registerNativePluginPane/, 'Manifest v2 panes must resolve through the native contribution broker');
assert.match(workerSource, /authorizePluginCapability\(runtimeInstanceId, 'legacy\.compatibility'\)/, 'legacy Worker APIs must be denied by the native broker for Manifest v2');
assert.doesNotMatch(workerSource, /api:window:create/, 'plugins must not receive the removed arbitrary window API');
assert.doesNotMatch(nativeCommandsSource, /plugin_window_create/, 'native IPC must not expose arbitrary plugin-created webviews');
assert.match(notificationBrokerSource, /authorizePluginCapability\(runtimeInstanceId, 'ui\.dialog\.confirm'\)/, 'plugin confirmation dialogs must require a reviewed native capability');
assert.match(workerSource, /confirm: \(opts\) => zync\.request\('api:ui:confirm', opts\)/, 'Manifest v2 SDK must expose the brokered confirmation API');
assert.match(notificationBrokerSource, /respond\(\{ requestId, result: confirmed \}\)/, 'confirmation result must use the shared Worker response envelope');
assert.match(notificationBrokerSource, /normalizePluginConfirmRequest\(payload\)/, 'plugin confirmation text must be bounded before rendering');
assert.match(workerSource, /messageRateLimiter\.consume\(\)/, 'every Worker generation must have a frontend message budget');
assert.match(brokerSource, /runtime\.isCurrentRuntime\(pluginId, runtimeInstanceId\)/, 'authorization results must be rejected after runtime replacement');
assert.match(workerSource, /resetNativePluginRuntimes/, 'reload and shutdown must revoke native plugin runtimes');
assert.match(nativeRuntimeSource, /plugins:runtime_start/, 'runtime creation must use the native plugin broker');
assert.match(nativeRuntimeSource, /plugins:runtime_authorize/, 'capability checks must use the native plugin broker');
assert.match(nativeRuntimeSource, /plugins:runtime_register_command/, 'command registration must use the native plugin broker');
assert.match(nativeRuntimeSource, /plugins:runtime_register_pane/, 'pane registration must use the native plugin broker');
assert.match(nativeRuntimeSource, /plugins:recovery_status/, 'startup safe mode must come from native recovery state');
assert.match(nativeRuntimeSource, /plugins:recovery_record_failure/, 'runtime failures must be persisted natively');
assert.match(brokerSource, /api:storage:get/, 'plugin storage reads must use the host bridge');
assert.match(brokerSource, /api:storage:set/, 'plugin storage writes must use the host bridge');
assert.match(pluginStorageSource, /plugins:storage_get/, 'private storage reads must use native IPC');
assert.match(pluginStorageSource, /plugins:storage_set/, 'private storage writes must use native IPC');
assert.match(workerSource, /blockedNetworkGlobals[\s\S]{0,500}WebSocket[\s\S]{0,500}importScripts/, 'ambient Worker networking primitives must be blocked before plugin code runs');
assert.match(brokerSource, /case 'api:network:fetch'/, 'approved Worker network requests must use the host bridge');
assert.match(pluginNetworkSource, /plugins:network_fetch/, 'plugin network requests must use native IPC');
assert.match(nativeNetworkSource, /Policy::none/, 'the native broker must handle and revalidate redirects itself');
assert.match(nativeNetworkSource, /resolve\(&host, address\)/, 'validated DNS results must be pinned for the outgoing request');
assert.match(nativeNetworkSource, /private or reserved address/, 'the native broker must reject SSRF destinations');
assert.match(nativeNetworkSource, /MAX_RESPONSE_BYTES/, 'network responses must have a native byte limit');
assert.match(demoWorkerSource, /accept: 'application\/vnd\.github\+json'/, 'the demo network request must use a GitHub-supported media type');
assert.match(brokerSource, /handlePluginFilesystemMessage/, 'external filesystem messages must use the isolated host bridge');
assert.match(pluginFilesystemSource, /'api:filesystem:pick'/, 'external filesystem selection must use the host bridge');
assert.match(pluginFilesystemSource, /'api:filesystem:read-text'/, 'external file reads must use opaque handles');
assert.match(pluginFilesystemSource, /plugins:filesystem_pick/, 'external selection must use native IPC');
assert.match(pluginFilesystemSource, /plugins:filesystem_read_text/, 'external reads must use native IPC');
assert.match(pluginFilesystemSource, /plugins:filesystem_pick_write_file/, 'external writes must start with a native save picker');
assert.match(pluginFilesystemSource, /plugins:filesystem_write_text/, 'external writes must use native IPC');
assert.match(nativeFilesystemSource, /PluginFilesystemHandle/, 'native filesystem selection must return an opaque handle');
assert.doesNotMatch(nativeFilesystemSource, /pub path:/, 'external filesystem responses must not expose native paths');
assert.match(nativeFilesystemSource, /runtime_instance_id/, 'filesystem handles must be bound to one runtime');
assert.match(nativeFilesystemSource, /Symbolic links are unavailable/, 'folder traversal must reject symbolic links');
assert.match(nativeFilesystemSource, /protected location cannot be shared/, 'sensitive locations must be denied natively');
assert.match(nativeFilesystemSource, /MAX_TEXT_FILE_BYTES/, 'external file reads must be bounded');
assert.match(nativeFilesystemSource, /PluginFilesystemHandleAccess/, 'opaque handles must retain their read or write authority');
assert.match(nativeFilesystemSource, /atomic_replace_external/, 'external writes must replace the selected file atomically');
assert.match(source, /connectionId \?\? 'local'/, 'plugin pane registration must bind the actual pane connection');
assert.match(nativeRuntimeSource, /plugins:runtime_bind_pane/, 'plugin pane connections must be bound in the native broker');
assert.match(pluginFilesystemSource, /'api:ssh-filesystem:list'/, 'server filesystem reads must use a distinct host bridge');
assert.match(pluginFilesystemSource, /plugins:ssh_filesystem_list/, 'server filesystem listing must use native IPC');
assert.match(nativeCommandsSource, /authorize_pane_connection[\s\S]{0,180}"ssh\.filesystem\.read"/, 'server filesystem access must resolve a permissioned pane binding');
assert.match(nativeCommandsSource, /resolve_plugin_ssh_path/, 'server filesystem paths must be resolved below the bound home folder');
assert.match(nativeCommandsSource, /paths cannot leave the server home folder/, 'server filesystem traversal must be rejected');
assert.doesNotMatch(nativeSshFilesystemSource, /pub path:/, 'server listings must not expose remote paths');
assert.match(demoWorkerSource, /zync\.sshFilesystem\.list\(paneInstanceId\)/, 'the demo must exercise its pane-bound server rather than a local picker');
assert.match(pluginManagementSource, /plugins:management_details/, 'plugin details must come from the native installed-package view');
assert.match(pluginManagementSource, /plugins:management_set_optional_permissions/, 'permission changes must use native grant enforcement');
assert.match(pluginManagementSource, /plugins:management_clear_storage/, 'data clearing must use the native plugin namespace');
assert.match(pluginManagementSource, /plugins:uninstall[\s\S]{0,180}deleteData/, 'uninstall must explicitly choose whether private data is retained');
assert.match(pluginDetailsSource, /Optional access can be revoked at any time/, 'installed plugin details must explain revocable optional access');
assert.match(settingsPluginsSource, /setPluginOptionalPermissions[\s\S]{0,500}reloadPluginRuntime\(\)/, 'grant changes must reload frontend contributions immediately');
assert.match(settingsPluginsSource, /clearPluginStorage[\s\S]{0,500}reloadPluginRuntime\(\)/, 'clearing plugin data must reload the Worker generation');
assert.match(nativeCommandsSource, /plugins_management_clear_storage[\s\S]{0,500}broker\.stop_plugin\(&plugin_id\)[\s\S]{0,300}management::clear_storage/, 'data clearing must revoke the native runtime before deleting its store');
assert.match(nativeCommandsSource, /plugins_uninstall[\s\S]{0,500}broker\.stop_plugin\(&id\)[\s\S]{0,300}management::uninstall/, 'uninstall must revoke the live native runtime before removing the package');
assert.match(settingsPluginsSource, /uninstallPlugin\(id, deleteData\)/, 'the uninstall choice must reach the native lifecycle command');
assert.match(workerSource, /hostCompatiblePlugins\.filter\(plugin => plugin\.enabled\)/, 'disabled plugins must not register host modes');
assert.match(workerSource, /postCurrentWorkerResponse/, 'asynchronous Worker replies must target the captured requester');
assert.doesNotMatch(workerSource, /const worker = workers\.current\.get\(pluginId\);[\s\S]{0,120}worker\.postMessage\(\{ type: `\$\{type\}:response`/, 'responses must never look up a replacement Worker after await');
const workerBridge = workerSource.slice(
  workerSource.indexOf('const handlePluginMessage'),
  workerSource.indexOf('const executeCommand'),
);
for (const responseCall of workerBridge.matchAll(/\brespond\(([^,\n]+)/g)) {
  assert.equal(responseCall[1].trim(), 'requester', 'every Worker response must retain its requester');
}
assert.match(workerSource, /requester,[\s\S]{0,160}'api:window:showQuickPick'/, 'delayed quick-pick replies must retain Worker identity');
assert.match(workerSource, /if \(!isTrustedBuiltinTheme\(plugin\) \|\| !plugin\.style\) return;[\s\S]{0,240}document\.head\.appendChild\(style\)/, 'only app-owned built-in theme CSS may enter the host document');
assert.match(workerSource, /Third-party manifest\.style is never injected/, 'the third-party CSS compatibility boundary must remain documented');
assert.match(workerSource, /filterTrustedBuiltinThemeChoices/, 'theme-manager choices must be backed by trusted built-in packages');
assert.match(settingsPluginsSource, /activeTab === 'appearance'[\s\S]{0,100}filterUnsupportedHostThemes\(plugins\)\.filter\(plugin => plugin\.enabled\)/, 'Appearance must advertise only enabled trusted themes');
assert.match(settingsPluginsSource, /plugins:inspect_local/, 'local packages must be inspected before installation');
assert.match(settingsPluginsSource, /plugins:install_inspected[\s\S]{0,700}reloadPluginRuntime\(activation\.pluginId\)/, 'approved installs must health-check the new Worker generation');
assert.match(settingsPluginsSource, /!runtimeReloaded[\s\S]{0,300}plugins:rollback_activation/, 'failed plugin activation must restore the previous package');
assert.match(settingsPluginsSource, /plugins:commit_activation/, 'healthy plugin activation must discard its rollback copy');
assert.match(workerSource, /host:runtime:ready/, 'the isolated Worker must explicitly acknowledge successful activation');
assert.match(
  workerSource,
  /if \(value !== undefined\) requestPayload\[key\] = value/,
  'the Worker bridge must omit optional undefined fields before strict envelope validation',
);
assert.match(pluginManagementSource, /plugins:rollback_version/, 'plugin management must expose retained-version rollback');
assert.match(pluginDetailsSource, /Previous version[\s\S]{0,900}Restore/, 'plugin details must show a user-facing retained-version rollback action');
assert.match(settingsPluginsSource, /rollbackPluginVersion\(pluginId\)[\s\S]{0,500}reloadPluginRuntime\(pluginId\)/, 'manual rollback must health-check the restored runtime');
assert.match(settingsPluginsSource, /!runtimeHealthy[\s\S]{0,220}rollbackPluginVersion\(pluginId\)/, 'a failed manual rollback must restore the replaced version');
assert.match(workerSource, /status === 'quarantined'[\s\S]{0,160}attemptAutomaticRollback\(pluginId\)/, 'runtime quarantine must trigger automatic retained-version recovery');
assert.match(workerSource, /details\.version[\s\S]{0,250}autoRollbackAttemptedVersions/, 'automatic rollback must be bounded to one attempt per active version');
assert.match(workerSource, /healthCheckPluginId[\s\S]{0,220}clearNativePluginRuntimeFailures\(healthCheckPluginId\)/, 'an explicit activation check must clear stale persisted failures');
assert.match(pluginDetailsSource, /Verified publisher[\s\S]{0,120}Bound by signed marketplace/, 'plugin details must distinguish verified and registry-bound publishers');
assert.match(nativeInstallReviewSource, /download_plugin_archive[\s\S]{0,400}spawn_blocking/, 'marketplace extraction and inspection must leave the async runtime thread');
assert.match(nativeRollbackSource, /digest_directory\(&path\.join\("package"\)\)/, 'retained rollback packages must be verified before display or activation');
assert.match(nativeRollbackSource, /join\("plugin-rollback-swap"\)/, 'manual rollback swaps must live outside the scanned plugins directory');
assert.match(nativeCommandsSource, /plugins_rollback_version[\s\S]{0,300}broker\.stop_plugin\(&plugin_id\)/, 'manual rollback must revoke the previous native runtime before swapping packages');
assert.match(settingsPluginsSource, /plugins:registry_load/, 'marketplace must ask the native verifier for trusted registry metadata');
assert.match(marketplaceSource, /Legacy catalog · publisher not verified/, 'unsigned fallback catalog must be visibly unverified');
assert.match(settingsPluginsSource, /plugins:inspect_marketplace/, 'marketplace packages must enter native inspection by registry identity');
assert.doesNotMatch(marketplaceSource, /plugins_install/, 'marketplace UI must not install an arbitrary presentation URL');
assert.match(marketplaceSource, /disabled=\{processing \|\| !plugin\.registryVerified \|\| revoked\}/, 'legacy and revoked catalog entries must not be installable');
assert.match(installedPluginsSource, /const hasUpdate = Boolean\([\s\S]{0,120}registryItem\.registryVerified[\s\S]{0,120}!registryItem\.revokedReason/, 'installed plugins must not offer unsigned catalog updates');
assert.match(marketplaceSource, /Revoked · \$\{plugin\.revokedReason\}/, 'signed registry revocations must be visible in marketplace UI');
assert.match(settingsPluginsSource, /plugins:discard_inspection/, 'cancelled permission reviews must discard staged plugin code');
assert.match(confirmationSource, /showConfirmDialog/, 'all plugin command bridges must share the confirmation policy');

console.log('Plugin panel SSH confirmation tests passed.');
