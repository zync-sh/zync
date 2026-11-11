/** Supply the renderer globals expected by legacy terminal suites before they import app code. */
Object.assign(globalThis, {
    window: {
        ipcRenderer: {
            invoke: async () => undefined,
            send: () => {},
            on: () => () => {},
        },
        dispatchEvent: () => true,
    },
    document: { body: { getAttribute: () => 'dark' } },
});
