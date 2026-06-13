export interface ParsedSyncError {
  code?: string;
  message: string;
  raw: string;
}

const SYNC_ERROR_PATTERN = /^\[(?<code>[^\]]+)\]\s*(?<body>[\s\S]*)$/;

export function parseSyncErrorString(raw: string): ParsedSyncError {
  const trimmed = raw.trim();
  const parsed = trimmed.match(SYNC_ERROR_PATTERN);
  const code = parsed?.groups?.code;
  const message = parsed?.groups?.body ?? trimmed;
  return { code, message, raw: trimmed };
}

export function parseSyncInvokeError(error: unknown): ParsedSyncError {
  if (error == null) {
    return { code: undefined, message: '', raw: '' };
  }
  if (typeof error === 'string') {
    return parseSyncErrorString(error);
  }
  if (typeof error === 'object' && 'message' in error) {
    return parseSyncErrorString(String((error as { message: unknown }).message));
  }
  const raw = String(error);
  return { code: undefined, message: raw, raw };
}
