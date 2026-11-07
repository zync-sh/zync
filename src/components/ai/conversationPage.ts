export const CONVERSATION_PAGE_SIZE = 100;

export interface ConversationPageAnchor {
    id: string;
    index: number;
}

/** Bound rendered rows while retaining access to every message and stable historical page anchors. */
export function resolveConversationPage(
    messages: readonly { id: string }[],
    anchor: ConversationPageAnchor | null,
    pageSize = CONVERSATION_PAGE_SIZE,
): { start: number; end: number } {
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : CONVERSATION_PAGE_SIZE;
    const tail = Math.max(0, messages.length - size);
    if (!anchor) {
        return { start: tail, end: messages.length };
    }
    const anchored =
        messages[anchor.index]?.id === anchor.id
            ? anchor.index
            : messages.findIndex((message) => message.id === anchor.id);
    const start = Math.max(0, Math.min(tail, anchored >= 0 ? anchored : anchor.index));
    return { start, end: Math.min(messages.length, start + size) };
}
