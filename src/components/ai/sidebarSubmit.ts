import { nanoid } from 'nanoid';

import type { AgentPlanStep } from '../../ai/types/agent';

export interface AgentHistoryEntry {
    role: 'user' | 'assistant';
    text: string;
}

export interface AgentRunActions {
    getHistory: (scope: string) => AgentHistoryEntry[];
    getLastApprovedPlan: (scope: string) => AgentPlanStep[] | null;
    startRun: (scope: string, runId: string, goal: string) => void;
    addError: (scope: string, message: string) => void;
    endRun: (scope: string) => void;
}

export function shouldTreatAgentInputAsAsk(query: string): boolean {
    return /^(hi|hello|hey|sup|yo|greetings|howdy|good morning|good afternoon|good evening|thanks|thank you)\b/i.test(query)
        && query.length < 35;
}

export async function submitAskQuery(params: {
    trimmed: string;
    connectionId: string | null;
    resetInput: () => void;
    collectContext: () => Promise<Record<string, unknown>>;
    submitAiQuery: (query: string, context: Record<string, unknown>, connectionId: string | null) => Promise<void>;
}): Promise<void> {
    const { trimmed, connectionId, resetInput, collectContext, submitAiQuery } = params;
    const context = await collectContext();
    await submitAiQuery(trimmed, context, connectionId);
    resetInput();
}

export async function submitAgentGoal(params: {
    goal: string;
    agentRunning: boolean;
    agentScope: string;
    connectionId: string | null;
    connectionLabel?: string | null;
    resetInput: () => void;
    collectContext: () => Promise<Record<string, unknown>>;
    agentActions: AgentRunActions;
    startAgentRun: (payload: {
        runId: string;
        goal: string;
        context: Record<string, unknown>;
        connectionId: string | null;
        connectionLabel?: string | null;
        history?: { role: string; text: string }[];
        approvedPlan?: AgentPlanStep[] | null;
    }) => Promise<void>;
}): Promise<void> {
    const {
        goal,
        agentRunning,
        agentScope,
        connectionId,
        connectionLabel,
        resetInput,
        collectContext,
        agentActions,
        startAgentRun,
    } = params;

    if (!goal.trim() || agentRunning) return;

    const runId = nanoid();

    try {
        const context = await collectContext();
        const history = agentActions.getHistory(agentScope);
        const approvedPlan = agentActions.getLastApprovedPlan(agentScope);

        agentActions.startRun(agentScope, runId, goal);

        await startAgentRun({
            runId,
            goal,
            context,
            connectionId,
            connectionLabel,
            history,
            approvedPlan,
        });
        resetInput();
    } catch (error) {
        agentActions.addError(agentScope, String(error));
        agentActions.endRun(agentScope);
    }
}
