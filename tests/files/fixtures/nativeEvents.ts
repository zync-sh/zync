/** Browser-only replacement for native event subscriptions. Never imported by production. */
export type UnlistenFn = () => void;
export async function listen() {
    return () => {};
}
export async function once() {
    return () => {};
}
export async function emit() {
    throw new Error('Native event writes are unavailable in this fixture');
}
export async function emitTo() {
    throw new Error('Native event writes are unavailable in this fixture');
}
