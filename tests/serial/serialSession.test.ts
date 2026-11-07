import assert from 'node:assert/strict';
import test from 'node:test';

import type { Channel } from '@tauri-apps/api/core';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import {
    DEFAULT_SERIAL_SETTINGS,
    encodeSerialInput,
} from '../../src/features/serial/domain/serialSettings';
import { createSerialSession } from '../../src/features/serial/infrastructure/serialSession';

const port = { id: 'COM4', label: 'Loopback', documentId: 'mock-renderer' };

test('serial input keeps control bytes and normalizes pasted line breaks', () => {
    const input = 'é\r\nnext\nlast\r\x03';
    const decoder = new TextDecoder();
    assert.equal(decoder.decode(encodeSerialInput(input, 'crlf')), 'é\r\nnext\r\nlast\r\n\x03');
    assert.equal(decoder.decode(encodeSerialInput(input, 'cr')), 'é\rnext\rlast\r\x03');
    assert.equal(decoder.decode(encodeSerialInput(input, 'lf')), 'é\nnext\nlast\n\x03');
});

test('serial writes wait for native completion and output credit waits for xterm', async (context) => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { crypto } });
    context.after(() => {
        clearMocks();
        Reflect.deleteProperty(globalThis, 'window');
    });
    const writes: number[][] = [];
    const acknowledgements: number[] = [];
    const inputErrors: string[] = [];
    let outputChannel: Channel<unknown> | undefined;
    let parsed: (() => void) | undefined;
    let releaseFirstWrite: () => void = () => assert.fail('First write did not reach IPC.');
    mockIPC((command, args) => {
        const payload = args as Record<string, unknown>;
        if (command === 'serial_open') {
            assert.equal(payload.documentId, port.documentId);
            outputChannel = payload.outputChannel as Channel<unknown>;
        }
        if (command === 'serial_write') {
            writes.push(payload.bytes as number[]);
            if (writes.length === 1) {
                return new Promise<void>((resolve) => {
                    releaseFirstWrite = resolve;
                });
            }
        }
        if (command === 'serial_ack_output') {
            acknowledgements.push(payload.sequence as number);
        }
    });
    const serial = createSerialSession(
        (bytes, callback) => {
            assert.deepEqual([...bytes], [0xfe]);
            parsed = callback;
        },
        (message) => assert.fail(message),
        (message) => inputErrors.push(message),
    );
    await serial.open(port, DEFAULT_SERIAL_SETTINGS);
    serial.write(new Uint8Array(70 * 1024));
    assert.equal(inputErrors.length, 1);
    serial.write(Uint8Array.of(13));
    serial.write(Uint8Array.of(3));
    assert.deepEqual(writes, [[13]]);
    releaseFirstWrite();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, [[13], [3]]);
    const frame = new ArrayBuffer(9);
    const view = new DataView(frame);
    view.setUint32(0, 1, true);
    view.setUint32(4, 1, true);
    view.setUint8(8, 0xfe);
    assert.ok(outputChannel);
    outputChannel.onmessage(frame);
    assert.deepEqual(acknowledgements, []);
    assert.ok(parsed);
    parsed();
    assert.deepEqual(acknowledgements, [1]);
    await serial.close();
    outputChannel.onmessage(frame);
    assert.deepEqual(acknowledgements, [1]);
});

test('serial cancellation fences a late open and waits for the second release', async (context) => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { crypto } });
    context.after(() => {
        clearMocks();
        Reflect.deleteProperty(globalThis, 'window');
    });
    const commands: string[] = [];
    let completeOpen: () => void = () => assert.fail('Serial open did not reach IPC.');
    mockIPC((command) => {
        commands.push(command);
        if (command === 'serial_open') {
            return new Promise<void>((resolve) => {
                completeOpen = resolve;
            });
        }
    });
    const serial = createSerialSession(
        () => assert.fail('A cancelled session delivered output.'),
        () => assert.fail('A cancelled session published a late error.'),
        () => assert.fail('A cancelled session admitted input.'),
    );
    const opening = serial.open(port, DEFAULT_SERIAL_SETTINGS);
    await Promise.resolve();
    const closing = serial.close();
    assert.equal(serial.closed, true);
    assert.deepEqual(commands, ['serial_open', 'serial_close']);
    completeOpen();
    await Promise.all([opening, closing]);
    serial.write(Uint8Array.of(13));
    assert.deepEqual(commands, ['serial_open', 'serial_close', 'serial_close']);
});
