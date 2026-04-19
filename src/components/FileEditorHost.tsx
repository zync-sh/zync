import { useEffect, useMemo, useRef, useState } from 'react';

import { CodeMirrorFileEditor } from './CodeMirrorFileEditor';
import { EditorPluginFrame } from './EditorPluginFrame';
import { BUILTIN_PLAIN_EDITOR_ID, CODEMIRROR_EDITOR_ID } from './editor/providers';
import { PlainFileEditor } from './PlainFileEditor';
import { usePlugins } from '../context/PluginContext';
import { useAppStore } from '../store/useAppStore';

interface FileEditorHostProps {
  filename: string;
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
  preferredProviderId?: string;
  /**
   * When true, hides provider toolbar/header chrome.
   * Used by embedded/editor-with-parent-toolbar surfaces.
   */
  hideToolbar?: boolean;
}

/**
 * Stage-1 editor host boundary.
 *
 * Today this still falls back to the built-in lightweight editor, but it
 * centralizes provider selection so the FileManager no longer points directly
 * at one concrete editor implementation.
 */
export function FileEditorHost(props: FileEditorHostProps) {
  const { editorProviders, plugins } = usePlugins();
  const defaultProvider = useAppStore((state) => state.settings.editor.defaultProvider);
  const showToast = useAppStore((state) => state.showToast);
  const [degradedProviderId, setDegradedProviderId] = useState<string | null>(null);
  const warnedFallbacksRef = useRef<Set<string>>(new Set());

  const providerId = props.preferredProviderId || defaultProvider || CODEMIRROR_EDITOR_ID;
  const selectedProvider = useMemo(
    () => editorProviders.find((plugin) => plugin.manifest.id === providerId) ?? null,
    [editorProviders, providerId]
  );
  const selectedProviderAnyState = useMemo(
    () => plugins.find((plugin) => plugin.manifest.id === providerId && plugin.manifest.type === 'editor-provider') ?? null,
    [plugins, providerId]
  );

  useEffect(() => {
    setDegradedProviderId(null);
  }, [providerId, props.filename]);

  const fallbackReason = useMemo(() => {
    if (providerId === BUILTIN_PLAIN_EDITOR_ID) return null;
    if (degradedProviderId && degradedProviderId === providerId) return 'runtime-failure';
    if (!selectedProviderAnyState) return 'missing-provider';
    if (!selectedProviderAnyState.enabled) return 'provider-disabled';
    if (!selectedProviderAnyState.editorHtml && selectedProviderAnyState.manifest.id !== CODEMIRROR_EDITOR_ID) {
      return 'missing-entry';
    }
    return null;
  }, [degradedProviderId, providerId, selectedProviderAnyState]);

  useEffect(() => {
    if (!fallbackReason || providerId === BUILTIN_PLAIN_EDITOR_ID) return;
    const warningKey = `${providerId}:${fallbackReason}`;
    if (warnedFallbacksRef.current.has(warningKey)) return;
    warnedFallbacksRef.current.add(warningKey);
    const providerName = selectedProviderAnyState?.manifest.name || providerId;
    const reasonText = fallbackReason === 'runtime-failure'
      ? 'it reported a runtime error'
      : fallbackReason === 'provider-disabled'
        ? 'it is currently disabled'
        : fallbackReason === 'missing-entry'
          ? 'it does not expose an editor entry'
          : 'it is not available';
    showToast('info', `Falling back to Built-in Fallback for ${providerName} (${reasonText}).`);
  }, [fallbackReason, providerId, selectedProviderAnyState?.manifest.name, showToast]);

  if (providerId === BUILTIN_PLAIN_EDITOR_ID) {
    return <PlainFileEditor {...props} />;
  }

  if (fallbackReason) {
    return <PlainFileEditor {...props} />;
  }

  if (selectedProvider?.manifest.id === CODEMIRROR_EDITOR_ID) {
    return <CodeMirrorFileEditor {...props} />;
  }

  if (selectedProvider?.editorHtml) {
    return (
      <EditorPluginFrame
        plugin={selectedProvider}
        onFatalError={() => setDegradedProviderId(selectedProvider.manifest.id)}
        {...props}
      />
    );
  }

  return <PlainFileEditor {...props} />;
}
