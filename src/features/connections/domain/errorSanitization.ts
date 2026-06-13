export const connectionErrorMessage = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    return raw
        .replace(/-----BEGIN(?: [A-Z0-9 ]+)?-----[\s\S]*?-----END(?: [A-Z0-9 ]+)?-----/gi, '[redacted private key]')
        .replace(/"(password|passphrase|token|secret)"\s*:\s*"(?:\\.|[^"\\])*"/gi, '"$1":"[redacted]"')
        .replace(/'(password|passphrase|token|secret)'\s*:\s*'(?:\\.|[^'\\])*'/gi, "'$1':'[redacted]'")
        .replace(/\b(password|passphrase|token|secret)\b\s*[:=]\s*"(?:\\.|[^"\\])*"/gi, '$1=[redacted]')
        .replace(/\b(password|passphrase|token|secret)\b\s*[:=]\s*'(?:\\.|[^'\\])*'/gi, '$1=[redacted]')
        .replace(/\b(password|passphrase|token|secret)\b\s*[:=]\s*([^,;]+?)(?=(,|;|$))/gi, '$1=[redacted]')
        .slice(0, 500);
};
