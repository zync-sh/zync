import { ghostDebug, isGhostDebugEnabled } from './ghostDebug.js';
import { ghostInputByteLength, MAX_GHOST_COMMAND_BYTES } from './inputBudget.js';
import type {
    GhostCommitRequest,
    GhostSeedRemoteHistoryRequest,
    GhostSeedRemoteHistoryResponse,
    GhostSuggestV2Request,
    GhostSuggestV2Response,
    InlineSuggestionParams,
} from './types.js';

/** Avoid IPC for oversized inference; reject responses that would exceed the same command budget. */
export async function fetchGhostSuggestionV2(
    request: GhostSuggestV2Request,
): Promise<GhostSuggestV2Response> {
    const empty: GhostSuggestV2Response = { suffix: '', confidence: 0 };
    const prefixBytes = ghostInputByteLength(request.prefix);
    if (prefixBytes === null) {
        return empty;
    }
    const response: GhostSuggestV2Response = await window.ipcRenderer
        .invoke('ghost_suggest_v2', { request })
        .catch(() => empty);
    return ghostInputByteLength(response.suffix, MAX_GHOST_COMMAND_BYTES - prefixBytes) === null
        ? empty
        : response;
}

/** Persist only bounded Ghost history; this never limits terminal delivery. */
export async function commitGhostCommand(command: string, scope: string): Promise<void> {
    if (ghostInputByteLength(command) === null) {
        return;
    }
    const request: GhostCommitRequest = { command, scope };
    await window.ipcRenderer.invoke('ghost_commit', { request });
}

/** Bound explicit-accept history before allocating its IPC request. */
export async function acceptGhostCommand(command: string, scope: string): Promise<void> {
    if (ghostInputByteLength(command) === null) {
        return;
    }
    const request: GhostCommitRequest = { command, scope };
    await window.ipcRenderer.invoke('ghost_accept', { request });
}

/** Request the native one-time, scoped history import and fail soft when unavailable. */
export async function seedRemoteGhostHistory(
    request: GhostSeedRemoteHistoryRequest,
): Promise<GhostSeedRemoteHistoryResponse> {
    const empty: GhostSeedRemoteHistoryResponse = { imported: 0 };
    return window.ipcRenderer
        .invoke('ghost_seed_remote_history', { request })
        .catch(() => empty) as Promise<GhostSeedRemoteHistoryResponse>;
}

/** Delegate bounded input to native ranking without altering its spacing decisions. */
export async function resolveInlineSuggestion({
    line,
    cwd,
    scope,
    fsConnectionId,
    wslShellId,
    recentCommands,
    providers,
}: InlineSuggestionParams): Promise<string> {
    if (ghostInputByteLength(line) === null) {
        return '';
    }
    const request: GhostSuggestV2Request = {
        prefix: line,
        scope,
        cwd,
        shellId: wslShellId,
        fsConnectionId: fsConnectionId ?? scope,
        recentCommands,
        providers,
        debug: isGhostDebugEnabled(),
    };

    ghostDebug('resolve', {
        phase: 'v2-request',
        line,
        scope,
        cwd: cwd ?? null,
        wslShellId: wslShellId ?? null,
        providers: providers ?? null,
    });

    const response = await fetchGhostSuggestionV2(request);

    ghostDebug('resolve', {
        phase: response.suffix ? 'v2-hit' : 'v2-empty',
        line,
        suffix: response.suffix || null,
        rawSuffix: response.rawSuffix ?? null,
        spacingReason: response.spacingReason ?? null,
        confidence: response.confidence,
        suppressReason: response.suppressReason ?? null,
    });

    // Backend owns spacing/ranking (mid-token vs new-word). Do not rewrite suffixes here.
    return response.suffix;
}

export { shouldPreferPathSuggestion } from './commandTokens.js';
