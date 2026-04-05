import type { AiContext } from '../types/common';
import { redactSensitiveOutput } from './redactContext.js';

export function attachAiContext(
    baseContext: Record<string, unknown>,
    attachedContext?: AiContext | null,
): Record<string, unknown> {
    if (!attachedContext) {
        return baseContext;
    }

    return {
        ...baseContext,
        attachedContent: redactSensitiveOutput(attachedContext.content) ?? attachedContext.content,
        attachedLabel: attachedContext.label,
    };
}
