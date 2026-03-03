import { invoke } from '@tauri-apps/api/core';
import { getTerminalRecentLines } from '../components/Terminal';

export interface TerminalContext {
    os: string | null;
    shell: string | null;
    cwd: string | null;
    recentOutput: string | null;
    connectionType: string;
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
    const isLocal = !connectionId || connectionId === 'local';
    const connectionType = isLocal ? 'local' : 'ssh';

    // OS detection: for SSH assume Linux (vast majority of servers);
    // for local, detect from navigator
    let os: string;
    if (!isLocal) {
        os = 'Linux';
    } else {
        const ua = navigator.userAgent.toLowerCase();
        os = ua.includes('mac') ? 'macOS'
            : ua.includes('win') ? 'Windows'
                : 'Linux';
    }

    // Shell detection: for local, infer from OS; for SSH, default to bash
    let shell: string;
    if (!isLocal) {
        shell = 'bash';
    } else if (os === 'Windows') {
        shell = 'powershell';
    } else if (os === 'macOS') {
        shell = 'zsh';
    } else {
        shell = 'bash';
    }

    let cwd: string | null = null;
    try {
        const result = await invoke<string>('fs_cwd', { connectionId: connectionId || 'local' });
        cwd = result || null;
    } catch {
        // cwd is optional context
    }

    // Read recent terminal output from xterm buffer
    let recentOutput: string | null = null;
    if (options?.includeRecentOutput && termId) {
        const raw = getTerminalRecentLines(termId, 20);
        recentOutput = options?.redact ? redactSensitiveOutput(raw) : raw;
    }

    return { os, shell, cwd, recentOutput, connectionType };
}

function redactSensitiveOutput(text: string | null): string | null {
    if (!text) return null;
    return text
        .replace(/(password|token|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
        .replace(/\b(ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/g, '[REDACTED_KEY]');
}
