/** Tracks lazy discovery requests across connection and reconnect generations. */
export class ShellDiscoveryGate {
    private generation = 0;
    private requested = false;

    constructor(public scope: string, private ready: boolean) {}

    update(scope: string, ready: boolean): boolean {
        if (scope === this.scope && ready === this.ready) return false;
        if (scope !== this.scope) this.requested = false;
        this.scope = scope;
        this.ready = ready;
        this.generation++;
        return true;
    }

    request(): number | null {
        this.requested = true;
        return this.ready ? this.generation : null;
    }

    shouldRetry(): boolean { return this.ready && this.requested; }

    isCurrent(generation: number): boolean {
        return this.ready && generation === this.generation;
    }
}
