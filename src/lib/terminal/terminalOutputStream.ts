import { Channel } from '@tauri-apps/api/core';
import type { Terminal as XTerm } from '@xterm/xterm';
import { terminalCache } from './terminalCache.js';
import { touchTerminalActivity } from './terminalActivity.js';
import { silenceTerminalOutputChannel } from './terminalReloadTeardown.js';

const GENERATION_HEADER_BYTES = 4;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: { transformCallback?: unknown } }).__TAURI_INTERNALS__?.transformCallback);
}

function createStubOutputChannel(): Channel {
  return {
    id: 0,
    onmessage: () => {},
    toJSON: () => '__CHANNEL__:0',
  } as unknown as Channel;
}

export interface TerminalOutputChannelFrame {
  generation: number;
  data: Uint8Array;
}

/** Decodes a raw IPC channel frame: u32 LE generation + PTY bytes. */
export function decodeTerminalOutputChannelFrame(buffer: ArrayBuffer): TerminalOutputChannelFrame {
  if (buffer.byteLength < GENERATION_HEADER_BYTES) {
    throw new RangeError('PTY output channel frame too short');
  }
  const view = new DataView(buffer);
  const generation = view.getUint32(0, true);
  const data = new Uint8Array(buffer, GENERATION_HEADER_BYTES);
  return { generation, data };
}

function toArrayBuffer(message: unknown): ArrayBuffer | null {
  if (message instanceof ArrayBuffer) {
    return message;
  }
  if (message instanceof Uint8Array) {
    return message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
  }
  return null;
}

/**
 * Registers a Tauri output channel for the next terminal:create invoke.
 * Replaces any prior channel handler for this session.
 */
export function attachTerminalOutputChannel(termId: string, term: XTerm): Channel {
  const cached = terminalCache.get(termId);
  if (!cached) {
    throw new Error(`No terminal cache entry for ${termId}`);
  }

  if (cached.outputChannel) {
    silenceTerminalOutputChannel(cached.outputChannel);
  }

  if (!isTauriRuntime()) {
    const stub = createStubOutputChannel();
    cached.outputChannel = stub;
    return stub;
  }

  const channel = new Channel((message) => {
    const entry = terminalCache.get(termId);
    if (!entry) {
      return;
    }

    const payload = toArrayBuffer(message);
    if (!payload || payload.byteLength < GENERATION_HEADER_BYTES) {
      return;
    }

    const { generation, data } = decodeTerminalOutputChannelFrame(payload);
    if (generation !== entry.generation) {
      return;
    }

    touchTerminalActivity(termId);
    term.write(data);
  });

  cached.outputChannel = channel;
  return channel;
}