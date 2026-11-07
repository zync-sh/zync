import { Channel, invoke } from '@tauri-apps/api/core';

import {
    decodeTerminalOutputChannelFrame,
    terminalOutputMessageToArrayBuffer,
} from '../../../lib/terminal/terminalOutputFrame';
import type { SerialSettings } from '../domain/serialSettings';

export interface SerialPort {
    id: string;
    label: string;
    documentId: string;
}

interface SerialStatus {
    kind: 'closed' | 'error';
    message?: string;
}

const WRITE_CHUNK_BYTES = 4096;
const MAX_PENDING_INPUT = 64 * 1024;

/** List port choices authorized for the current native document. */
export function listSerialPorts(): Promise<SerialPort[]> {
    return invoke('serial_list_ports');
}

/** One native port attempt. Closing invalidates its callbacks before releasing the device. */
export function createSerialSession(
    writeOutput: (data: Uint8Array, parsed: () => void) => void,
    onEnd: (message: string) => void,
    onInputError: (message: string) => void,
) {
    const sessionId = crypto.randomUUID();
    const input: Uint8Array[] = [];
    let outputChannel: Channel<unknown> | undefined;
    let statusChannel: Channel<SerialStatus> | undefined;
    let pendingBytes = 0;
    let writing = false;
    let closed = false;
    let opened = false;
    let opening: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let received = 0;
    let parsed = 0;
    let acknowledged = 0;
    let acknowledging = false;

    /** Native close is idempotent for this attempt ID. */
    function release() {
        return invoke<void>('serial_close', { sessionId });
    }

    /** Fence callbacks now and wait for a racing open to release its device. */
    function close() {
        if (closed) {
            return closing;
        }
        closed = true;
        input.length = 0;
        if (outputChannel) {
            outputChannel.onmessage = () => {};
        }
        if (statusChannel) {
            statusChannel.onmessage = () => {};
        }
        closing = Promise.allSettled([release(), opening]).then(([cancelled]) => {
            if (cancelled.status === 'rejected') {
                throw cancelled.reason;
            }
        });
        return closing;
    }

    /** Stop malformed or failed streams without delivering bytes to a replacement pane. */
    function fail(message: string) {
        if (closed) {
            return;
        }
        void close()?.catch(() => {});
        onEnd(message);
    }

    /** Send cumulative credit only after xterm has consumed the bytes. */
    async function acknowledge() {
        if (closed || acknowledging || parsed <= acknowledged) {
            return;
        }
        acknowledging = true;
        try {
            while (!closed && parsed > acknowledged) {
                const sequence = parsed;
                await invoke('serial_ack_output', { sessionId, sequence });
                acknowledged = sequence;
            }
        } catch {
            fail('Serial output stopped unexpectedly.');
        } finally {
            acknowledging = false;
        }
    }

    /** Validate framing and preserve the order of xterm parse callbacks. */
    function receiveOutput(message: unknown) {
        if (closed) {
            return;
        }
        try {
            const payload = terminalOutputMessageToArrayBuffer(message);
            if (!payload) {
                throw new Error('Invalid serial output payload');
            }
            const { generation, sequence, data } = decodeTerminalOutputChannelFrame(payload);
            if (generation !== 1 || sequence !== received + 1 || data.length === 0) {
                throw new Error('Invalid serial output sequence');
            }
            received = sequence;
            writeOutput(data, () => {
                if (closed) {
                    return;
                }
                if (sequence !== parsed + 1) {
                    fail('Serial output was received out of order.');
                    return;
                }
                parsed = sequence;
                void acknowledge();
            });
        } catch {
            fail('Invalid serial output.');
        }
    }

    /** Native end status follows any deliverable final output. */
    function receiveStatus({ kind, message }: SerialStatus) {
        fail(
            message ??
                (kind === 'closed'
                    ? 'Serial port closed.'
                    : 'The serial device stopped responding.'),
        );
    }

    /** Limit paste buffering and preserve input order across native invokes. */
    async function flushInput() {
        if (closed || writing) {
            return;
        }
        writing = true;
        try {
            for (let chunk = input.shift(); chunk && !closed; chunk = input.shift()) {
                await invoke('serial_write', { sessionId, bytes: Array.from(chunk) });
                pendingBytes -= chunk.length;
            }
        } catch (error) {
            fail(serialError(error));
        } finally {
            writing = false;
        }
    }

    return {
        /** Cancellation fences opening, input, and output before native cleanup finishes. */
        get closed() {
            return closed;
        },
        /** Register callbacks only for an open that reaches IPC admission. */
        open(port: SerialPort, settings: SerialSettings) {
            opening = Promise.resolve().then(async () => {
                if (closed) {
                    return;
                }
                outputChannel = new Channel(receiveOutput);
                statusChannel = new Channel(receiveStatus);
                try {
                    await invoke('serial_open', {
                        sessionId,
                        portId: port.id,
                        documentId: port.documentId,
                        settings,
                        outputChannel,
                        statusChannel,
                    });
                    opened = true;
                } finally {
                    // Cancellation may reach native before the asynchronous open returns.
                    if (closed) {
                        await release();
                    }
                }
            });
            return opening;
        },
        /** Admit an entire input event or reject it before sending a partial paste. */
        write(bytes: Uint8Array) {
            if (!opened || closed || bytes.length === 0) {
                return;
            }
            if (pendingBytes + bytes.length > MAX_PENDING_INPUT) {
                onInputError(
                    'Serial input is queued. Wait for it to finish or send a smaller block.',
                );
                return;
            }
            pendingBytes += bytes.length;
            for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
                input.push(bytes.subarray(offset, offset + WRITE_CHUNK_BYTES));
            }
            void flushInput();
        },
        close,
    };
}

/** Native command errors can arrive as strings or JavaScript errors. */
export function serialError(error: unknown): string {
    return typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : 'Serial operation failed.';
}
