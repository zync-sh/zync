import { Channel, invoke, isTauri } from '@tauri-apps/api/core';

/** The server's current challenge and the exact foreground attempt that owns it. */
export interface SshVerificationRequest {
    attemptId: string;
    requestId: string;
    host: string;
    port: number;
    username: string;
    title: string;
    instructions: string;
    prompts: { index: number; label: string; echo: boolean }[];
}

export class SshVerificationCancelledError extends Error {}

const prompts = new Map<string, SshVerificationRequest>();
const listeners = new Set<() => void>();

/** Subscribe to changes of the oldest active challenge, without storing any answers. */
export function subscribeSshVerification(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Serialize simultaneous foreground prompts in their arrival order. */
export function currentSshVerification(): SshVerificationRequest | null {
    return prompts.values().next().value ?? null;
}

/** Retire a challenge only if it still owns its request ID. */
function removePrompt(request: SshVerificationRequest): boolean {
    if (prompts.get(request.requestId) !== request) {
        return false;
    }
    prompts.delete(request.requestId);
    listeners.forEach((listener) => listener());
    return true;
}

/** Retire a challenge only once its owning native round accepts the reply. */
export async function respondSshVerification(
    request: SshVerificationRequest,
    responses: string[] | null,
): Promise<void> {
    if (prompts.get(request.requestId) === request) {
        await sendReply(request, responses);
        removePrompt(request);
    }
}

/** Send only the scoped reply; credentials never enter shared renderer state. */
function sendReply(request: SshVerificationRequest, responses: string[] | null): Promise<void> {
    return invoke('ssh_verification_reply', {
        attemptId: request.attemptId,
        requestId: request.requestId,
        responses,
    });
}

/** Own a challenge channel for one explicit command and dismiss its prompts on exit. */
export async function withSshVerification<T>(
    start: (channel?: Channel<SshVerificationRequest>) => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (signal?.aborted) {
        throw new SshVerificationCancelledError();
    }
    if (!isTauri()) {
        return start();
    }

    let open = true;
    let current: SshVerificationRequest | undefined;
    /** Closing the host editor dismisses the owned challenge and cancels its native wait. */
    const cancel = () => {
        if (current && removePrompt(current)) {
            void sendReply(current, null).catch(() => {});
        }
    };
    const channel = new Channel<SshVerificationRequest>((request) => {
        if (!open) {
            return;
        }
        if (signal?.aborted) {
            void sendReply(request, null).catch(() => {});
            return;
        }
        if (current) {
            removePrompt(current);
        }
        current = request;
        prompts.set(request.requestId, request);
        listeners.forEach((listener) => listener());
    });
    signal?.addEventListener('abort', cancel);
    try {
        return await start(channel);
    } catch (error) {
        if (String(error).includes('SSH verification cancelled')) {
            throw new SshVerificationCancelledError('SSH verification cancelled');
        }
        throw error;
    } finally {
        open = false;
        if (current) {
            removePrompt(current);
        }
        signal?.removeEventListener('abort', cancel);
    }
}
