const DEFAULT_WINDOW_MS = 1_000;
const DEFAULT_MAX_MESSAGES = 200;

/** Keeps a noisy Worker from monopolizing the host UI thread. */
export class PluginMessageRateLimiter {
    private windowStartedAt: number;
    private count = 0;

    constructor(
        private readonly now: () => number = Date.now,
        private readonly maxMessages = DEFAULT_MAX_MESSAGES,
        private readonly windowMs = DEFAULT_WINDOW_MS,
    ) {
        this.windowStartedAt = now();
    }

    consume(): boolean {
        const current = this.now();
        if (current - this.windowStartedAt >= this.windowMs) {
            this.windowStartedAt = current;
            this.count = 0;
        }
        if (this.count >= this.maxMessages) return false;
        this.count += 1;
        return true;
    }
}

const MAX_CONFIRM_TITLE_CHARS = 120;
const MAX_CONFIRM_MESSAGE_CHARS = 2_000;
const MAX_CONFIRM_BUTTON_CHARS = 40;

function boundedText(value: unknown, fallback: string, maxChars: number): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, maxChars) : fallback;
}

export interface PluginConfirmRequest {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'primary' | 'danger';
}

export function normalizePluginConfirmRequest(payload: unknown): PluginConfirmRequest {
    const record = payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : {};
    const confirmText = boundedText(record.confirmText, '', MAX_CONFIRM_BUTTON_CHARS);
    const cancelText = boundedText(record.cancelText, '', MAX_CONFIRM_BUTTON_CHARS);
    return {
        title: boundedText(record.title, 'Plugin confirmation', MAX_CONFIRM_TITLE_CHARS),
        message: boundedText(record.message, 'A plugin is asking for confirmation.', MAX_CONFIRM_MESSAGE_CHARS),
        confirmText: confirmText || undefined,
        cancelText: cancelText || undefined,
        variant: record.variant === 'danger' ? 'danger' : 'primary',
    };
}
