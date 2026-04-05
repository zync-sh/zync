import { invoke } from '@tauri-apps/api/core';

import type { ChatMessage } from '../types/common';

export async function translateAiStream(payload: {
    query: string;
    context: Record<string, unknown>;
    requestId: string;
    history: ChatMessage[];
}): Promise<void> {
    await invoke('ai_translate_stream', payload);
}

export async function checkOllamaAvailability(): Promise<boolean> {
    return invoke<boolean>('ai_check_ollama');
}

export async function fetchOllamaModels(): Promise<string[]> {
    return invoke<string[]>('ai_get_ollama_models');
}

export async function fetchProviderModels(): Promise<string[]> {
    return invoke<string[]>('ai_get_provider_models');
}

export async function getSavedProviderKey(provider: string): Promise<string | null> {
    if (provider === 'ollama') return null;
    return invoke<string | null>('get_secret', { key: provider });
}

// ── Agent V2 IPC ────────────────────────────────────────────────────────────

export async function startAgentRun(payload: {
    runId: string;
    goal: string;
    context: Record<string, unknown>;
    connectionId: string | null;
    connectionLabel?: string | null;
    history?: { role: string; text: string }[];
    approvedPlan?: import('../types/agent').AgentPlanStep[] | null;
}): Promise<void> {
    // AgentRunRequest has #[serde(rename_all = "camelCase")] so fields must be camelCase.
    await invoke('ai_agent_run', {
        request: {
            runId: payload.runId,
            goal: payload.goal,
            context: payload.context,
            connectionId: payload.connectionId ?? null,
            connectionLabel: payload.connectionLabel ?? null,
            history: payload.history ?? [],
            approvedPlan: payload.approvedPlan ?? null,
        },
    });
}

export async function whitelistCommand(scope: string, command: string): Promise<void> {
    await invoke('ai_agent_whitelist_command', { scope, command });
}

export async function clearBrainSessions(paths: string[]): Promise<void> {
    await invoke('ai_clear_brain_sessions', { paths });
}

export async function stopAgentRun(runId: string): Promise<void> {
    await invoke('ai_agent_stop', { runId });
}

export async function respondToCheckpoint(checkpointId: string, proceed: boolean): Promise<void> {
    await invoke('ai_agent_checkpoint_respond', { checkpointId, proceed });
}
