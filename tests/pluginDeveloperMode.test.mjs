import assert from 'node:assert/strict';
import fs from 'node:fs';

const scanner = fs.readFileSync('src-tauri/src/plugins.rs', 'utf8');
const grants = fs.readFileSync('src-tauri/src/plugins/grants.rs', 'utf8');
const review = fs.readFileSync('src-tauri/src/plugins/install/review.rs', 'utf8');
const broker = fs.readFileSync('src-tauri/src/plugins/broker.rs', 'utf8');
const commands = fs.readFileSync('src-tauri/src/commands.rs', 'utf8');
const developerTab = fs.readFileSync('src/components/settings/tabs/plugins/PluginsDeveloperTab.tsx', 'utf8');
const settingsHook = fs.readFileSync('src/components/settings/hooks/useSettingsPlugins.ts', 'utf8');

assert.match(scanner, /struct PluginState[\s\S]*developer_mode: bool/);
assert.match(scanner, /user_plugin_enabled_by_policy\([\s\S]*manifest_version < 2[\s\S]*developer_mode/);
assert.match(scanner, /pub\(crate\) fn require_developer_mode/);
assert.match(scanner, /durable_replace\(&state_path/);

assert.match(grants, /approval_source_allowed\(grant\.registry_version, developer_mode\)/);
assert.match(grants, /registry_version\.is_some\(\) \|\| developer_mode/);
assert.match(review, /inspect_local_plugin[\s\S]{0,180}require_developer_mode\(app\)/);
assert.match(review, /inspection\.registry_version\.is_none\(\)[\s\S]{0,120}require_developer_mode\(app\)/);
assert.match(review, /Marketplace plugins must use Manifest v2/);

assert.match(broker, /manifest\.manifest_version\(\) < 2[\s\S]{0,160}require_developer_mode\(app\)/);
assert.match(commands, /plugins_developer_mode_set[\s\S]{0,600}broker\.reset\(\)/);

assert.match(developerTab, /label="Developer Mode"/);
assert.match(developerTab, /const disabled = !developerMode \|\| isAnyInstallRunning \|\| isUpdatingDeveloperMode/);
assert.match(settingsHook, /plugins:developer_mode_set/);
assert.match(settingsHook, /reloadPluginRuntime\(\)/);

console.log('Plugin Developer Mode production boundary tests passed.');
