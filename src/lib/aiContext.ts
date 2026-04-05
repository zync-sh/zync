import { invoke } from '@tauri-apps/api/core';
import { getTerminalRecentLines } from '../components/Terminal';
import type { AiContext } from '../ai/types/common';
import { attachAiContext } from '../ai/lib/requestContext';
import { redactSensitiveOutput } from '../ai/lib/redactContext';

export interface TerminalContext {
    os: string | null;
    shell: string | null;
    cwd: string | null;
    recentOutput: string | null;
    connectionType: string;
}

export async function collectAiRequestContext(
    connectionId: string | undefined,
    termId: string | null,
    attachedContext?: AiContext | null,
    options?: { includeRecentOutput?: boolean; redact?: boolean }
): Promise<Record<string, unknown>> {
    try {
        const terminalContext = await collectTerminalContext(connectionId, termId, options);
        return attachAiContext({ ...terminalContext }, attachedContext);
    } catch {
        return attachAiContext({}, attachedContext);
    }
}

/**
 * Collect context from the active terminal for the AI prompt.
 * Provides OS, shell, cwd, recent output, and connection type so the AI can tailor commands.
 */
export async function collectTerminalContext(
    connectionId: string | undefined,
    termId: string | null,
    options?: { includeRecentOutput?: boolean; redact?: boolean }
): Promise<TerminalContext> {
    // Redaction is default-on. Callers must explicitly pass redact:false to disable it,
    // which should only happen in local-only / non-cloud scenarios.
    const shouldRedact = options?.redact !== false;
    const isLocal = !connectionId || connectionId === 'local';
    const connectionType = isLocal ? 'local' : 'ssh';

    // For remote (SSH) connections, the backend detects the real OS and shell at
    // connect time and overrides whatever we send here. Send null so the backend
    // fallback ("unknown") is used only if detection failed rather than a wrong guess.
    let os: string | null;
    let shell: string | null;
    if (!isLocal) {
        os = null;
        shell = null;
    } else {
        const ua = navigator.userAgent.toLowerCase();
        os = ua.includes('mac') ? 'macOS'
            : ua.includes('win') ? 'Windows'
                : 'Linux';
        // Match the actual shell the backend uses: cmd /C on Windows, sh -c elsewhere.
        shell = os === 'Windows' ? 'cmd'
            : os === 'macOS' ? 'zsh'
                : 'sh';
    }

    let cwd: string | null = null;
    try {
        const result = await invoke<string>('fs_cwd', { connectionId: connectionId || 'local' });
        cwd = result || null;
    } catch {
        // cwd is optional context
    }

    let recentOutput: string | null = null;
    if (options?.includeRecentOutput && termId) {
        const raw = getTerminalRecentLines(termId, 20);
        recentOutput = shouldRedact ? redactSensitiveOutput(raw) : raw;
    }

    return { os, shell, cwd, recentOutput, connectionType };
}
