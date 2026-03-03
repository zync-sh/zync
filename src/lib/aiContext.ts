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
        // key=value / key: value style (password, token, secret, api_key, access_key — supports quoted values)
        .replace(/\b(password|token|secret|api[_-]?key|access[_-]?key)\b\s*[:=]\s*("([^"\n]*)"|'([^'\n]*)'|\S+)/gi, '$1=[REDACTED]')
        // Authorization: Bearer <token>
        .replace(/\b(authorization\s*:\s*bearer)\s+[^\s"']+/gi, '$1 [REDACTED]')
        // Common vendor token formats: GitHub (ghp_, ghu_, ghs_, gho_, ghr_), OpenAI (sk-), AWS (AKIA/ASIA), Slack (xox*)
        .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED_KEY]')
        // PEM private key blocks
        .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}
