import assert from 'node:assert/strict';
import fs from 'node:fs';

const context = fs.readFileSync('src/context/PluginContext.tsx', 'utf8');
const broker = fs.readFileSync('src/features/plugins/broker/pluginMessageBroker.ts', 'utf8');
const notifications = fs.readFileSync(
  'src/features/plugins/broker/pluginNotificationBroker.ts',
  'utf8',
);
const handlerStart = context.indexOf('const handlePluginMessage');
const handlerEnd = context.indexOf('const executeCommand', handlerStart);
const contextMessageRouter = context.slice(handlerStart, handlerEnd);

assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'PluginContext message handler must be present');
assert.match(context, /createPluginMessageBroker<Worker>/);
assert.match(contextMessageRouter, /messageBroker\.handleMessage\(pluginId, type, rawPayload, requester\)/);
for (const networkGlobal of ['WebTransport', 'CacheStorage', 'caches']) {
  assert.match(context, new RegExp(`${networkGlobal}: denyAmbientNetworkConstructor`));
}

for (const route of [
  'api:panel:register',
  'api:log',
  'api:ui:notify',
  'api:ui:confirm',
  'api:commands:register',
  'api:storage:get',
  'api:network:fetch',
  'api:filesystem:read-text',
]) {
  assert.doesNotMatch(
    contextMessageRouter,
    new RegExp(`case ['\"]${route.replaceAll(':', '\\:')}['\"]`),
    `${route} must not be implemented in PluginContext`,
  );
}

assert.match(contextMessageRouter, /case 'api:fs:read'/, 'legacy filesystem compatibility stays explicit');
assert.match(contextMessageRouter, /authorizePluginCapability\(runtimeInstanceId, 'legacy\.compatibility'\)/);

assert.match(broker, /typeof rawType !== 'string'/);
assert.match(broker, /case 'api:log'/);
assert.match(broker, /handlePluginFilesystemMessage/);
assert.match(broker, /registerNativePluginPane/);
assert.match(broker, /authorizePluginCommandRegistration/);
assert.match(broker, /fetchPluginNetworkResource/);
assert.match(broker, /isCurrentRuntime/);
assert.match(notifications, /authorizePluginCapability\(runtimeInstanceId, 'ui\.notifications\.emit'\)/);
assert.match(notifications, /authorizePluginCapability\(runtimeInstanceId, 'ui\.dialog\.confirm'\)/);

console.log('Plugin frontend broker boundary tests passed.');
