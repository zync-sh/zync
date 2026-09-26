export function createPluginReloadQueue() {
    let tail: Promise<void> = Promise.resolve();

    return <T>(reload: () => Promise<T>): Promise<T> => {
        const result = tail.then(reload);
        // A failed reload still releases the next request, but keeps its own result.
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}

export class PluginLifecycleGeneration {
    private generation = 0;
    private active = false;

    begin(): void {
        this.generation += 1;
        this.active = true;
    }

    invalidate(): void {
        this.generation += 1;
        this.active = false;
    }

    capture(): () => boolean {
        const generation = this.generation;
        return () => this.active && generation === this.generation;
    }
}
