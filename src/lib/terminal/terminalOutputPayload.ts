/** Legacy JSON-serialized PTY bytes (pre–base64 IPC). */
export type LegacyTerminalOutputData = number[];

/** Compact base64 PTY payload from the Rust backend. */
export type TerminalOutputData = string | LegacyTerminalOutputData;

/**
 * Decodes a terminal output event payload into raw PTY bytes for xterm.write().
 * Accepts base64 strings (current) and legacy number[] arrays (dev safety).
 */
export function decodeTerminalOutputData(data: TerminalOutputData): Uint8Array {
  if (typeof data === 'string') {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  return new Uint8Array(data);
}