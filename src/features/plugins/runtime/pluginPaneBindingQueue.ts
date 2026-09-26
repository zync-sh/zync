export class PluginPaneBindingQueue {
    private readonly pending = new Map<string, Promise<void>>();

    enqueue(key: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.pending.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        this.pending.set(key, next);
        const clear = () => {
            if (this.pending.get(key) === next) this.pending.delete(key);
        };
        void next.then(clear, clear);
        return next;
    }

    clear() {
        this.pending.clear();
    }
}

export async function postAfterPaneBinding(
    ready: Promise<void>,
    isCurrent: () => boolean,
    post: () => void,
): Promise<void> {
    await ready;
    if (isCurrent()) post();
}
