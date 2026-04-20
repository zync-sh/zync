import { Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import type { AppSettings } from '../../../store/settingsSlice';
import { Select } from '../../ui/Select';
import { Section } from '../common/Section';
import { Toggle } from '../common/Toggle';

interface AiTabProps {
    settings: AppSettings;
    apiKeyDraft: string;
    apiKeySaved: boolean;
    apiKeyError: string | null;
    setApiKeyDraft: (value: string) => void;
    setApiKeyError: (value: string | null) => void;
    updateAiSettings: (updates: Partial<AppSettings['ai']>) => Promise<void>;
    saveApiKey: (provider: string, key: string) => Promise<void>;
}

type AiProvider = AppSettings['ai']['provider'];

export function AiTab({
    settings,
    apiKeyDraft,
    apiKeySaved,
    apiKeyError,
    setApiKeyDraft,
    setApiKeyError,
    updateAiSettings,
    saveApiKey
}: AiTabProps) {
    const currentProvider = settings.ai?.provider;
    const canUseApiKey = Boolean(currentProvider && currentProvider !== 'ollama');
    const normalizedApiKeyDraft = apiKeyDraft.trim();
    const canSubmitApiKey = canUseApiKey && normalizedApiKeyDraft.length > 0;
    const handleSaveApiKey = () => {
        if (!currentProvider || !canSubmitApiKey) return;
        void saveApiKey(currentProvider, normalizedApiKeyDraft);
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            <Section title="General">
                <div className="space-y-4">
                    <Toggle
                        label="Enable AI Features"
                        description="Allow AI translation and processing"
                        checked={settings.ai?.enabled ?? true}
                        onChange={(v) => updateAiSettings({ enabled: v })}
                    />
                </div>
            </Section>

            <Section title="AI Provider">
                <div className="space-y-4">
                    <div className="flex items-center justify-between py-2">
                        <div>
                            <div className="text-sm font-medium text-[var(--color-app-text)]">Provider</div>
                            <div className="text-xs text-[var(--color-app-muted)] mt-0.5">AI engine for natural language to command translation</div>
                        </div>
                        <div className="w-52">
                            <Select
                                value={settings.ai?.provider || 'ollama'}
                                onChange={(v) => updateAiSettings({ provider: v as AiProvider, model: undefined })}
                                options={[
                                    { value: 'ollama', label: 'Ollama (Local / Free)' },
                                    { value: 'gemini', label: 'Gemini (Free BYOK)' },
                                    { value: 'openai', label: 'OpenAI (BYOK)' },
                                    { value: 'claude', label: 'Claude (BYOK)' },
                                    { value: 'groq', label: 'Groq (BYOK)' },
                                    { value: 'mistral', label: 'Mistral (BYOK)' },
                                ]}
                            />
                        </div>
                    </div>

                    {(settings.ai?.provider === 'ollama' || !settings.ai?.provider) && (
                        <div>
                            <div className="text-sm font-medium text-[var(--color-app-text)] mb-1">Ollama URL</div>
                            <input
                                type="text"
                                value={settings.ai?.ollamaUrl ?? 'http://localhost:11434'}
                                onChange={(e) => updateAiSettings({ ollamaUrl: e.target.value })}
                                className="w-full bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg px-3 py-1.5 text-sm text-[var(--color-app-text)] focus:outline-none focus:border-[var(--color-app-accent)]"
                            />
                            <p className="text-xs text-[var(--color-app-muted)] mt-1">
                                Runs fully locally - no API key needed.{' '}
                                <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="text-[var(--color-app-accent)] hover:underline">
                                    Install Ollama</a>
                            </p>
                        </div>
                    )}

                    {canUseApiKey && (
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <div className="text-sm font-medium text-[var(--color-app-text)]">API Key</div>
                                {apiKeySaved && (
                                    <span className="text-xs text-emerald-400 flex items-center gap-1 animate-in fade-in duration-150"> Saved </span>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={apiKeyDraft}
                                    onChange={(e) => {
                                        setApiKeyDraft(e.target.value);
                                        if (apiKeyError) setApiKeyError(null);
                                    }}
                                    onBlur={() => {
                                        if (canSubmitApiKey) handleSaveApiKey();
                                    }}
                                    placeholder={`Paste your ${settings.ai?.provider} API key...`}
                                    className={clsx(
                                        "flex-1 bg-[var(--color-app-bg)] border rounded-lg px-3 py-1.5 text-sm text-[var(--color-app-text)] focus:outline-none transition-colors",
                                        apiKeyError ? "border-red-500/50 focus:border-red-500" : "border-[var(--color-app-border)] focus:border-[var(--color-app-accent)]"
                                    )}
                                />
                                <button
                                    onClick={handleSaveApiKey}
                                    disabled={!canSubmitApiKey}
                                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--color-app-accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity shrink-0"
                                >
                                    Save
                                </button>
                            </div>
                            {apiKeyError && (
                                <p className="text-[10px] text-red-500 mt-1 animate-in fade-in slide-in-from-top-1">
                                    {apiKeyError}
                                </p>
                            )}
                            <p className="text-xs text-[var(--color-app-muted)] mt-1">
                                {settings.ai?.provider === 'gemini' && (
                                    <>Free tier available, no credit card needed.{' '}
                                        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-[var(--color-app-accent)] hover:underline">Get Gemini API key</a></>
                                )}
                                {settings.ai?.provider === 'openai' && (
                                    <>Pay-as-you-go, credit card required.{' '}
                                        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-[var(--color-app-accent)] hover:underline">Get OpenAI API key</a></>
                                )}
                                {settings.ai?.provider === 'claude' && (
                                    <>Pay-as-you-go, credit card required.{' '}
                                        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-[var(--color-app-accent)] hover:underline">Get Claude API key</a></>
                                )}
                                {settings.ai?.provider === 'groq' && (
                                    <>Fast OpenAI-compatible inference.{' '}
                                        <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="text-[var(--color-app-accent)] hover:underline">Get Groq API key</a></>
                                )}
                                {settings.ai?.provider === 'mistral' && (
                                    <>OpenAI-compatible hosted models.{' '}
                                        <a href="https://console.mistral.ai/api-keys/" target="_blank" rel="noopener noreferrer" className="text-[var(--color-app-accent)] hover:underline">Get Mistral API key</a></>
                                )}
                            </p>
                        </div>
                    )}

                    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-[var(--color-app-surface)]/50 border border-[var(--color-app-border)]/40">
                        <Sparkles className="w-4 h-4 text-[var(--color-app-accent)] shrink-0 mt-0.5" />
                        <div>
                            <p className="text-xs font-medium text-[var(--color-app-text)]">Model selection</p>
                            <p className="text-xs text-[var(--color-app-muted)] mt-0.5">
                                Each provider uses its default model automatically. Open the AI Command Bar (<kbd className="px-1 py-0.5 rounded bg-[var(--color-app-bg)] border border-[var(--color-app-border)] font-mono text-[10px]">Ctrl+I</kbd>) and click the model pill to pick a different model per session.
                            </p>
                        </div>
                    </div>
                </div>
            </Section>

            <Section title="How to Use">
                <div className="space-y-2 text-sm text-[var(--color-app-muted)]">
                    <p>Press <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-app-surface)] border border-[var(--color-app-border)] font-mono text-xs text-[var(--color-app-text)]">Ctrl+I</kbd> inside any terminal to open the AI Command Bar.</p>
                    <p>Type what you want to do in plain language and press Enter to translate.</p>
                    <p>Review the command and safety level, then press Enter or click Execute to run it.</p>
                    <div className="mt-3 p-3 rounded-lg bg-[var(--color-app-surface)]/50 border border-[var(--color-app-border)]/40 space-y-1.5">
                        <p className="text-xs font-medium text-[var(--color-app-text)]">Safety levels</p>
                        <p className="text-xs"><span className="text-emerald-400 font-medium">SAFE</span> - read-only (ls, cat, df) - Enter executes</p>
                        <p className="text-xs"><span className="text-yellow-400 font-medium">MODERATE</span> - modifying but reversible (mkdir, git) - Enter executes</p>
                        <p className="text-xs"><span className="text-red-400 font-medium">DANGEROUS</span> - destructive (rm -rf, dd) - must click Execute</p>
                    </div>
                </div>
            </Section>
        </div>
    );
}
