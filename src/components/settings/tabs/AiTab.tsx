import { Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { useEffect, useRef, useState, type FocusEvent } from 'react';
import type { AppSettings } from '../../../store/settingsSlice';
import { useAppStore } from '../../../store/useAppStore';
import { Select } from '../../ui/Select';
import { Section } from '../common/Section';
import { Toggle } from '../common/Toggle';

interface AiTabProps {
    settings: AppSettings;
    apiKeyDraft: string;
    apiKeyPersistedValue: string;
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
    apiKeyPersistedValue,
    apiKeySaved,
    apiKeyError,
    setApiKeyDraft,
    setApiKeyError,
    updateAiSettings,
    saveApiKey
}: AiTabProps) {
    const showToast = useAppStore((state) => state.showToast);
    const [isSavingApiKey, setIsSavingApiKey] = useState(false);
    const [ollamaUrlDraft, setOllamaUrlDraft] = useState(settings.ai?.ollamaUrl ?? 'http://localhost:11434');
    const lastSyncedOllamaUrlRef = useRef(settings.ai?.ollamaUrl ?? 'http://localhost:11434');
    const previousProviderRef = useRef(settings.ai?.provider ?? 'ollama');
    const saveButtonRef = useRef<HTMLButtonElement | null>(null);
    const currentProvider = settings.ai?.provider;
    const canUseApiKey = Boolean(currentProvider && currentProvider !== 'ollama');
    const normalizedApiKeyDraft = apiKeyDraft.trim();
    const canSubmitApiKey = canUseApiKey && normalizedApiKeyDraft.length > 0;
    useEffect(() => {
        const nextProvider = settings.ai?.provider ?? 'ollama';
        const persistedOllamaUrl = settings.ai?.ollamaUrl ?? 'http://localhost:11434';
        const providerChanged = previousProviderRef.current !== nextProvider;
        const draftIsDirty = ollamaUrlDraft !== lastSyncedOllamaUrlRef.current;
        if (providerChanged || !draftIsDirty) {
            setOllamaUrlDraft(persistedOllamaUrl);
            lastSyncedOllamaUrlRef.current = persistedOllamaUrl;
        }
        previousProviderRef.current = nextProvider;
    }, [settings.ai?.provider, settings.ai?.ollamaUrl, ollamaUrlDraft]);

    const safeUpdateAiSettings = (updates: Partial<AppSettings['ai']>) => {
        updateAiSettings(updates).catch((error: unknown) => {
            console.error('Failed to update AI settings', error);
            const message = error instanceof Error ? error.message : 'Failed to update AI settings';
            showToast('error', message);
        });
    };

    const handleSaveApiKey = async () => {
        if (!currentProvider || !canSubmitApiKey || isSavingApiKey || normalizedApiKeyDraft === apiKeyPersistedValue.trim()) return;
        setIsSavingApiKey(true);
        try {
            await saveApiKey(currentProvider, normalizedApiKeyDraft);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to save API key';
            setApiKeyError(message);
        } finally {
            setIsSavingApiKey(false);
        }
    };

    const handleApiKeyBlur = (event: FocusEvent<HTMLInputElement>) => {
        if (!canSubmitApiKey) return;
        if (saveButtonRef.current && event.relatedTarget === saveButtonRef.current) {
            return;
        }
        void handleSaveApiKey();
    };

    const handleOllamaUrlBlur = () => {
        const persistedValue = settings.ai?.ollamaUrl ?? 'http://localhost:11434';
        if (ollamaUrlDraft === persistedValue) return;
        safeUpdateAiSettings({ ollamaUrl: ollamaUrlDraft });
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            <Section title="General">
                <div className="space-y-4">
                    <Toggle
                        label="Enable AI Features"
                        description="Allow AI translation and processing"
                        checked={settings.ai?.enabled ?? true}
                        onChange={(v) => safeUpdateAiSettings({ enabled: v })}
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
                                onChange={(v) => safeUpdateAiSettings({ provider: v as AiProvider, model: undefined })}
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
                            <label htmlFor="ollama-url-input" className="text-sm font-medium text-[var(--color-app-text)] mb-1 block">Ollama URL</label>
                            <input
                                id="ollama-url-input"
                                type="text"
                                value={ollamaUrlDraft}
                                onChange={(e) => setOllamaUrlDraft(e.target.value)}
                                onBlur={handleOllamaUrlBlur}
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
                                <label htmlFor="provider-api-key-input" className="text-sm font-medium text-[var(--color-app-text)]">API Key</label>
                                {apiKeySaved && (
                                    <span className="text-xs text-emerald-400 flex items-center gap-1 animate-in fade-in duration-150"> Saved </span>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <input
                                    id="provider-api-key-input"
                                    type="password"
                                    value={apiKeyDraft}
                                    onChange={(e) => {
                                        setApiKeyDraft(e.target.value);
                                        if (apiKeyError) setApiKeyError(null);
                                    }}
                                    onBlur={handleApiKeyBlur}
                                    placeholder={`Paste your ${settings.ai?.provider} API key...`}
                                    className={clsx(
                                        "flex-1 bg-[var(--color-app-bg)] border rounded-lg px-3 py-1.5 text-sm text-[var(--color-app-text)] focus:outline-none transition-colors",
                                        apiKeyError ? "border-red-500/50 focus:border-red-500" : "border-[var(--color-app-border)] focus:border-[var(--color-app-accent)]"
                                    )}
                                />
                                <button
                                    ref={saveButtonRef}
                                    onClick={() => { void handleSaveApiKey(); }}
                                    disabled={!canSubmitApiKey || isSavingApiKey || normalizedApiKeyDraft === apiKeyPersistedValue.trim()}
                                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--color-app-accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity shrink-0"
                                >
                                    {isSavingApiKey ? 'Saving…' : 'Save'}
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
