import type { SerialLineEnding, SerialSettings } from './serialSettings';

export interface SerialProfile {
    id: string;
    name: string;
    portId: string;
    settings: SerialSettings;
    lineEnding: SerialLineEnding;
}

export interface SerialProfileDraft {
    name: string;
    portId: string;
    baud: string;
    settings: SerialSettings;
    lineEnding: SerialLineEnding;
}

export const SERIAL_PROFILE_NAME_MAX_LENGTH = 120;
const SERIAL_PORT_ID_MAX_LENGTH = 1024;
const PROFILE_ID = /^[a-z\d_-]{1,128}$/i;
type SerialProfileErrors = Partial<Record<keyof SerialProfileDraft, string>>;
type SerialProfileValidation =
    | { value: Omit<SerialProfile, 'id'>; errors?: never }
    | { value?: never; errors: SerialProfileErrors };

/** Bound saved identities independently of native session and device identifiers. */
export function isSerialProfileId(value: unknown): value is string {
    return typeof value === 'string' && PROFILE_ID.test(value);
}

/** Validate framing before saving; actual baud-rate support remains the device driver's choice. */
function validFraming(settings: SerialSettings): boolean {
    return (
        settings !== null &&
        typeof settings === 'object' &&
        [5, 6, 7, 8].includes(settings.dataBits) &&
        ['none', 'odd', 'even'].includes(settings.parity) &&
        [1, 2].includes(settings.stopBits) &&
        ['none', 'hardware', 'software'].includes(settings.flowControl)
    );
}

/** Validate a device-local profile without requiring its adapter to be plugged in. */
export function validateSerialProfileDraft(draft: SerialProfileDraft): SerialProfileValidation {
    const name = draft.name.trim();
    const portId = draft.portId.trim();
    const baud = draft.baud.trim();
    const baudRate = Number(baud);
    const errors: SerialProfileErrors = {};
    if (
        !name ||
        name.length > SERIAL_PROFILE_NAME_MAX_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(name)
    ) {
        errors.name = `Enter a name using 1 to ${SERIAL_PROFILE_NAME_MAX_LENGTH} characters.`;
    }
    if (
        !portId ||
        portId.length > SERIAL_PORT_ID_MAX_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(portId)
    ) {
        errors.portId = 'Choose a serial port.';
    }
    if (!/^\d+$/.test(baud) || baudRate < 1 || baudRate > 0xffffffff) {
        errors.baud = 'Enter a positive whole baud rate up to 4294967295.';
    }
    if (!validFraming(draft.settings)) {
        errors.settings = 'Select valid serial framing and flow control.';
    }
    if (!['cr', 'lf', 'crlf'].includes(draft.lineEnding)) {
        errors.lineEnding = 'Select a valid Enter line ending.';
    }
    if (Object.keys(errors).length > 0) {
        return { errors };
    }
    const { dataBits, parity, stopBits, flowControl } = draft.settings;
    return {
        value: {
            name,
            portId,
            settings: { baudRate, dataBits, parity, stopBits, flowControl },
            lineEnding: draft.lineEnding,
        },
    };
}

/** Restore only known metadata; native document grants and runtime sessions are never persisted. */
export function normalizeSerialProfiles(input: unknown): SerialProfile[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const profiles = new Map<string, SerialProfile>();
    for (const item of input) {
        if (
            !isSerialProfileId(item?.id) ||
            typeof item.name !== 'string' ||
            typeof item.portId !== 'string' ||
            !Number.isInteger(item.settings?.baudRate)
        ) {
            continue;
        }
        const { value } = validateSerialProfileDraft({
            name: item.name,
            portId: item.portId,
            baud: String(item.settings.baudRate),
            settings: item.settings,
            lineEnding: item.lineEnding,
        });
        if (value) {
            profiles.set(item.id, { id: item.id, ...value });
        }
    }
    return [...profiles.values()];
}

/** Compare only effective connection inputs when consuming an explicit one-shot open request. */
export function sameSerialConnectionInputs(
    a: Omit<SerialProfile, 'id' | 'name'> | undefined,
    b: Omit<SerialProfile, 'id' | 'name'> | undefined,
): boolean {
    return Boolean(
        a &&
            b &&
            a.portId === b.portId &&
            a.lineEnding === b.lineEnding &&
            a.settings.baudRate === b.settings.baudRate &&
            a.settings.dataBits === b.settings.dataBits &&
            a.settings.parity === b.settings.parity &&
            a.settings.stopBits === b.settings.stopBits &&
            a.settings.flowControl === b.settings.flowControl,
    );
}
