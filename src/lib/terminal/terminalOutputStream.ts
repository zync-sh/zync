import { Channel } from '@tauri-apps/api/core';
import type { Terminal as XTerm } from '@xterm/xterm';
import { feedPromptCwdSniffer } from '../ghostSuggestions/promptCwdSniffer.js';
import { feedSecretInputSniffer } from '../ghostSuggestions/secretInputDetect.js';
import { useAppStore } from '../../store/useAppStore.js';
import { terminalCache } from './terminalCache.js';
import { touchTerminalActivity } from './terminalActivity.js';
import { silenceTerminalOutputChannel } from './terminalReloadTeardown.js';

const GENERATION_HEADER_BYTES = 4;

/** Cheap pre-filter before UTF-8 decode + prompt regex work on PTY output. */
function outputMayContainPrompt(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0x0d || byte === 0x0a || byte === 0x24 || byte === 0x3a || byte === 0x3e) {
      return true;
    }
  }
  return false;
}

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
    if (entry.connectionId) {
      const connectionId = entry.connectionId;
      // Always run the bounded secret sniffer; chunk-boundary prefilters can miss prompts.
      feedSecretInputSniffer(termId, data, () => {
        const live = terminalCache.get(termId);
        live?.ghostTracker?.enterSecretInputMode();
      });
      if (outputMayContainPrompt(data)) {
        feedPromptCwdSniffer(termId, data, (path) => {
          entry.ghostTracker?.exitSecretInputMode();
          useAppStore.getState().setTerminalCwd(connectionId, termId, path);
        });
      }
    }
    term.write(data);
  });

  cached.outputChannel = channel;
  return channel;
}