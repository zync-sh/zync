zync.on('ready', async () => {
  await zync.panel.register('demo.counter');
  await zync.commands.register(
    'manifest-v2-demo.hello',
    'Manifest v2 Demo: Say hello',
    async () => {
      const previous = Number(await zync.storage.get('hello-count') || '0');
      const count = Number.isSafeInteger(previous) ? previous + 1 : 1;
      await zync.storage.set('hello-count', String(count));
      try {
        await zync.ui.notify({
          type: 'success',
          title: 'Manifest v2 plugin is running',
          message: `This command has run ${count} time${count === 1 ? '' : 's'}.`,
        });
      } catch {
        // Notifications are optional; the command and private counter still work without them.
      }
    },
  );
});

const paneQueues = new Map();

function runForPane(paneInstanceId, task) {
  const previous = paneQueues.get(paneInstanceId) || Promise.resolve();
  const next = previous.then(task, task);
  paneQueues.set(paneInstanceId, next);
  next.then(
    () => { if (paneQueues.get(paneInstanceId) === next) paneQueues.delete(paneInstanceId); },
    () => { if (paneQueues.get(paneInstanceId) === next) paneQueues.delete(paneInstanceId); },
  );
}

zync.panel.onMessage(({ paneInstanceId, message }) => {
  if (!paneInstanceId || !message || ![
    'counter:read',
    'counter:increment',
    'dialog:confirm',
    'network:test',
    'filesystem:file',
    'filesystem:directory',
    'filesystem:write',
    'ssh-filesystem:home',
  ].includes(message.type)) return;
  runForPane(paneInstanceId, async () => {
    if (message.type === 'dialog:confirm') {
      try {
        const confirmed = await zync.ui.confirm({
          title: 'Manifest v2 confirmation',
          message: 'Allow this demo action?',
          confirmLabel: 'Allow',
          cancelLabel: 'Cancel',
        });
        await zync.panel.postMessage(paneInstanceId, {
          type: 'dialog:update',
          ok: true,
          message: confirmed ? 'Demo action allowed.' : 'Demo action canceled.',
        });
      } catch (error) {
        await zync.panel.postMessage(paneInstanceId, {
          type: 'dialog:update',
          ok: false,
          message: error && error.message ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === 'network:test') {
      try {
        const response = await zync.network.fetch('https://api.github.com/zen', {
          accept: 'application/vnd.github+json',
        });
        await zync.panel.postMessage(paneInstanceId, {
          type: 'network:update',
          ok: response.status >= 200 && response.status < 300,
          message: `HTTP ${response.status}: ${response.body}`,
        });
      } catch (error) {
        await zync.panel.postMessage(paneInstanceId, {
          type: 'network:update',
          ok: false,
          message: error && error.message ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === 'filesystem:file') {
      try {
        const selected = await zync.filesystem.pickFile();
        if (!selected) {
          await zync.panel.postMessage(paneInstanceId, {
            type: 'filesystem:update',
            ok: true,
            message: 'File selection canceled.',
          });
          return;
        }
        const text = await zync.filesystem.readText(selected.handle);
        const preview = text.replace(/\s+/g, ' ').trim().slice(0, 160);
        await zync.panel.postMessage(paneInstanceId, {
          type: 'filesystem:update',
          ok: true,
          message: `${selected.name}: ${preview || '(empty text file)'}`,
        });
      } catch (error) {
        await zync.panel.postMessage(paneInstanceId, {
          type: 'filesystem:update',
          ok: false,
          message: error && error.message ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === 'filesystem:directory') {
      try {
        const selected = await zync.filesystem.pickDirectory();
        if (!selected) {
          await zync.panel.postMessage(paneInstanceId, {
            type: 'filesystem:update',
            ok: true,
            message: 'Folder selection canceled.',
          });
          return;
        }
        const entries = await zync.filesystem.list(selected.handle);
        await zync.panel.postMessage(paneInstanceId, {
          type: 'filesystem:update',
          ok: true,
          message: `${selected.name}: ${entries.length} visible item${entries.length === 1 ? '' : 's'}`,
        });
      } catch (error) {
        await zync.panel.postMessage(paneInstanceId, {
          type: 'filesystem:update',
          ok: false,
          message: error && error.message ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === 'filesystem:write') {
      try {
        const selected = await zync.filesystem.pickWriteFile();
        if (!selected) {
          await zync.panel.postMessage(paneInstanceId, {
            type: 'filesystem:update',
            ok: true,
            message: 'Save destination selection canceled.',
          });
          return;
        }
        const content = `Created by the Zync Manifest v2 demo plugin.\n${new Date().toISOString()}\n`;
        await zync.filesystem.writeText(selected.handle, content);
        await zync.panel.postMessage(paneInstanceId, {
          type: 'filesystem:update',
          ok: true,
          message: `Wrote ${content.length} characters to ${selected.name}.`,
        });
      } catch (error) {
        await zync.panel.postMessage(paneInstanceId, {
          type: 'filesystem:update',
          ok: false,
          message: error && error.message ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === 'ssh-filesystem:home') {
      try {
        const entries = await zync.sshFilesystem.list(paneInstanceId);
        await zync.panel.postMessage(paneInstanceId, {
          type: 'filesystem:update',
          ok: true,
          message: `Server home: ${entries.length} visible item${entries.length === 1 ? '' : 's'}.`,
        });
      } catch (error) {
        await zync.panel.postMessage(paneInstanceId, {
          type: 'filesystem:update',
          ok: false,
          message: error && error.message ? error.message : String(error),
        });
      }
      return;
    }
    const key = `pane:${paneInstanceId}:count`;
    const stored = Number(await zync.storage.get(key) || '0');
    const current = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
    const count = message.type === 'counter:increment' ? current + 1 : current;
    if (count !== current) await zync.storage.set(key, String(count));
    await zync.panel.postMessage(paneInstanceId, { type: 'counter:update', count });
  });
});
