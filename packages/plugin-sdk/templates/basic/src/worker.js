// Zync supplies this object in the isolated plugin Worker.
const zync = globalThis.zync;

zync.on('ready', async () => {
  await zync.panel.register('starter.main');
});

zync.panel.onMessage(({ paneInstanceId, message }) => {
  if (message?.type !== 'ping') return;
  void zync.panel.postMessage(paneInstanceId, { type: 'pong', text: 'Hello from the Worker' });
});
