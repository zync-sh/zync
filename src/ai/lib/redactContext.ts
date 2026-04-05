export function redactSensitiveOutput(text: string | null): string | null {
    if (text == null) return null;

    return text
        // key=value / key: value style secrets
        .replace(/\b(password|token|secret|api[_-]?key|access[_-]?key)\b\s*[:=]\s*("([^"\n]*)"|'([^'\n]*)'|\S+)/gi, '$1=[REDACTED]')
        // Authorization: Bearer <token>
        .replace(/\b(authorization\s*:\s*bearer)\s+[^\s"']+/gi, '$1 [REDACTED]')
        // Common token formats
        .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED_KEY]')
        // PEM private key blocks
        .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
        // Internal IPv4 addresses
        .replace(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g, '[REDACTED_IP]')
        // Host-like internal domains
        .replace(/\b[a-zA-Z0-9.-]+\.(?:internal|corp|cluster\.local|localdomain)\b/g, '[REDACTED_HOST]');
}
