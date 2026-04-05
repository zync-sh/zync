export type RiskLevel = 'safe' | 'moderate' | 'dangerous';

export type ConnectionScope = 'local' | 'ssh';

export type AiMode = 'ask' | 'agent';

export interface AiResult {
    command: string;
    explanation: string;
    safety: RiskLevel;
    answer?: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface AiDisplayEntry {
    id: string;
    query: string;
    result: AiResult | null;
    error: string | null;
    contextSnapshot?: string | null;
    timestamp: number;
}

export interface AiContext {
    type: 'terminal' | 'file';
    label: string;
    content: string;
}

export interface AiStreamChunkPayload {
    requestId: string;
    chunk: string;
    done: boolean;
    error: string | null;
}

export interface AiStreamDonePayload {
    requestId: string;
    result: AiResult | null;
    error: string | null;
}

export interface AgentContextShape {
    connectionType: ConnectionScope;
    connectionId?: string | null;
    cwd?: string | null;
    shell?: string | null;
    os?: string | null;
    environment?: 'production' | 'staging' | 'development' | 'unknown';
    services?: string[];
    availableTools?: string[];
}
