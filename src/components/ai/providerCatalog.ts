export type ProviderValue = 'ollama' | 'openai' | 'gemini' | 'claude' | 'groq' | 'mistral';

export interface ModelOption {
    value: string;
    label: string;
    short: string;
}

export interface ProviderOption {
    value: ProviderValue;
    label: string;
    short: string;
}

export const PROVIDERS: ProviderOption[] = [
    { value: 'ollama', label: 'Ollama', short: 'Ollama' },
    { value: 'openai', label: 'OpenAI', short: 'OpenAI' },
    { value: 'claude', label: 'Anthropic', short: 'Claude' },
    { value: 'gemini', label: 'Google Gemini', short: 'Gemini' },
    { value: 'groq', label: 'Groq', short: 'Groq' },
    { value: 'mistral', label: 'Mistral', short: 'Mistral' },
];

export const FALLBACK_MODELS: Partial<Record<ProviderValue, ModelOption[]>> = {
    openai: [
        { value: 'gpt-4o', label: 'GPT-4o', short: 'GPT-4o' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini', short: '4o mini' },
        { value: 'gpt-4-turbo', label: 'GPT-4 Turbo', short: '4 Turbo' },
        { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', short: '3.5T' },
    ],
    claude: [
        { value: 'claude-sonnet-4-5-20251101', label: 'Claude Sonnet 4.5', short: 'Sonnet 4.5' },
        { value: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet', short: 'Sonnet 3.7' },
        { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', short: 'Haiku 3.5' },
    ],
    gemini: [
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', short: '2.0 Flash' },
        { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', short: '1.5 Pro' },
        { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', short: '1.5 Flash' },
    ],
    groq: [
        { value: 'llama-3.3-70b-versatile', label: 'LLaMA 3.3 70B', short: 'LLaMA 70B' },
        { value: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B', short: 'Mixtral' },
    ],
    mistral: [
        { value: 'mistral-large-latest', label: 'Mistral Large', short: 'Large' },
        { value: 'mistral-small-latest', label: 'Mistral Small', short: 'Small' },
    ],
};

export const DEFAULT_MODEL: Partial<Record<ProviderValue, string>> = {
    openai: 'gpt-4o',
    claude: 'claude-sonnet-4-5-20251101',
    gemini: 'gemini-2.0-flash',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-large-latest',
};

export function getProviderOption(value: ProviderValue): ProviderOption {
    return PROVIDERS.find((provider) => provider.value === value) ?? PROVIDERS[0];
}

export function toModelOption(id: string): ModelOption {
    return {
        value: id,
        label: id.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
        short: id.split('-').slice(-2).join(' '),
    };
}

export function getProviderModels(
    provider: ProviderValue,
    ollamaModels: string[],
    dynamicModels: string[],
): ModelOption[] {
    if (provider === 'ollama') {
        return ollamaModels.map((model) => ({ value: model, label: model, short: model }));
    }

    if (dynamicModels.length > 0) {
        return dynamicModels.map(toModelOption);
    }

    return FALLBACK_MODELS[provider] ?? [];
}

export function getActiveModel(
    provider: ProviderValue,
    configuredModel?: string,
): string {
    return configuredModel || DEFAULT_MODEL[provider] || '';
}

export function getModelShort(
    models: ModelOption[],
    activeModel: string,
): string {
    return models.find((model) => model.value === activeModel)?.short ?? (activeModel || '—');
}

export function requiresProviderSetup(
    provider: ProviderValue,
    activeModel: string,
    ollamaAvailable: boolean,
): boolean {
    return provider === 'ollama'
        ? (!ollamaAvailable || !activeModel)
        : !activeModel;
}
