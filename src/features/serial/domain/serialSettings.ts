export type SerialLineEnding = 'cr' | 'lf' | 'crlf';

export interface SerialSettings {
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    parity: 'none' | 'odd' | 'even';
    stopBits: 1 | 2;
    flowControl: 'none' | 'hardware' | 'software';
}

export const DEFAULT_SERIAL_SETTINGS: Readonly<SerialSettings> = {
    baudRate: 115200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
};

const LINE_ENDINGS: Record<SerialLineEnding, string> = { cr: '\r', lf: '\n', crlf: '\r\n' };
const encoder = new TextEncoder();

/** Encode xterm text input with the selected serial newline convention. */
export function encodeSerialInput(text: string, ending: SerialLineEnding): Uint8Array {
    return encoder.encode(text.replace(/\r\n|\r|\n/g, LINE_ENDINGS[ending]));
}
