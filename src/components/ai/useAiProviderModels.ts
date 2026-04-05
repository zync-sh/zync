import { useEffect, useMemo, useRef, useState } from 'react';

import {
    getActiveModel,
    getModelShort,
    getProviderModels,
    getProviderOption,
    requiresProviderSetup,
    type ModelOption,
    type ProviderOption,
    type ProviderValue,
} from './providerCatalog';

interface UseAiProviderModelsParams {
    isOpen: boolean;
    provider: ProviderValue;
    configuredModel?: string;
    checkOllama: () => Promise<boolean>;
    getOllamaModels: () => Promise<string[]>;
    fetchProviderModels: () => Promise<string[]>;
}

interface UseAiProviderModelsResult {
    activeProvider: ProviderOption;
    currentModels: ModelOption[];
    activeModel: string;
    modelShort: string;
    providerNeedsSetup: boolean;
    ollamaAvailable: boolean;
}

export function useAiProviderModels({
    isOpen,
    provider,
    configuredModel,
    checkOllama,
    getOllamaModels,
    fetchProviderModels,
}: UseAiProviderModelsParams): UseAiProviderModelsResult {
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);
    const [dynamicModels, setDynamicModels] = useState<string[]>([]);
    const [ollamaAvailable, setOllamaAvailable] = useState(true);
    const modelFetchIdRef = useRef(0);

    useEffect(() => {
        if (!isOpen) return;
        const fetchId = ++modelFetchIdRef.current;

        const loadModels = async () => {
            if (provider === 'ollama') {
                try {
                    const ok = await checkOllama();
                    if (fetchId !== modelFetchIdRef.current) return;
                    setOllamaAvailable(ok);
                    if (!ok) {
                        setOllamaModels([]);
                        return;
                    }
                    const models = await getOllamaModels();
                    if (fetchId === modelFetchIdRef.current) {
                        setOllamaModels(models);
                    }
                } catch (error) {
                    if (fetchId !== modelFetchIdRef.current) return;
                    console.error('[useAiProviderModels] Failed to load Ollama models', error);
                    setOllamaAvailable(false);
                    setOllamaModels([]);
                }
                return;
            }

            setDynamicModels([]);
            try {
                const models = await fetchProviderModels();
                if (fetchId === modelFetchIdRef.current) {
                    setDynamicModels(models);
                }
            } catch (error) {
                if (fetchId !== modelFetchIdRef.current) return;
                console.error('[useAiProviderModels] Failed to load provider models', { provider, error });
            }
        };

        void loadModels();
    }, [isOpen, provider, checkOllama, getOllamaModels, fetchProviderModels]);

    const activeProvider = useMemo(() => getProviderOption(provider), [provider]);
    const currentModels = useMemo(
        () => getProviderModels(provider, ollamaModels, dynamicModels),
        [provider, ollamaModels, dynamicModels],
    );
    const activeModel = useMemo(
        () => getActiveModel(provider, configuredModel),
        [provider, configuredModel],
    );
    const modelShort = useMemo(
        () => getModelShort(currentModels, activeModel),
        [currentModels, activeModel],
    );
    const providerNeedsSetup = useMemo(
        () => requiresProviderSetup(provider, activeModel, ollamaAvailable),
        [provider, activeModel, ollamaAvailable],
    );

    return {
        activeProvider,
        currentModels,
        activeModel,
        modelShort,
        providerNeedsSetup,
        ollamaAvailable,
    };
}
