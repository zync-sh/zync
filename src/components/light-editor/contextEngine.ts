export interface LightEditorCompletionItem {
  label: string;
  insertText?: string;
  detail?: string;
  documentation?: { value?: string } | string;
}

export interface LightEditorHoverEntry {
  contents?: Array<{ value: string }>;
}

export interface LightEditorDefinitionEntry {
  signature?: string;
  description?: string;
  type?: string;
  module?: string;
}

export interface LightEditorIntelligence {
  completions: LightEditorCompletionItem[];
  hovers: Record<string, LightEditorHoverEntry>;
  definitions: Record<string, LightEditorDefinitionEntry>;
}

const intelligenceCache = new Map<string, Promise<LightEditorIntelligence>>();

export function detectLightEditorLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const fullName = filename.toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', jsonc: 'json',
    yaml: 'yaml', yml: 'yaml',
    xml: 'xml',
    rs: 'rust',
    go: 'go',
    py: 'python',
    rb: 'ruby',
    c: 'c', h: 'c',
    cpp: 'cpp', hpp: 'cpp',
    cs: 'csharp',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    ps1: 'powershell',
    md: 'markdown', markdown: 'markdown',
    sql: 'sql',
    graphql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    lua: 'lua',
    r: 'r',
  };

  return map[ext] ?? map[fullName] ?? 'plaintext';
}

export function getContextEngineKey(language: string): string | null {
  const map: Record<string, string> = {
    javascript: 'javascript',
    typescript: 'typescript',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    yaml: 'yaml',
    xml: 'xml',
    rust: 'rust',
    go: 'go',
    python: 'python',
    ruby: 'ruby',
    c: 'c',
    cpp: 'cpp',
    csharp: 'csharp',
    java: 'java',
    kotlin: 'kotlin',
    swift: 'swift',
    shell: 'shell',
    powershell: 'powershell',
    markdown: 'markdown',
    sql: 'sql',
    graphql: 'graphql',
    dockerfile: 'dockerfile',
    lua: 'lua',
    r: 'r',
  };

  return map[language] ?? null;
}

export async function loadContextEngineIntelligence(language: string): Promise<LightEditorIntelligence | null> {
  const key = getContextEngineKey(language);
  if (!key) return null;

  if (!intelligenceCache.has(key)) {
    intelligenceCache.set(
      key,
      (async () => {
        const [completionMod, hoverMod, definitionMod] = await Promise.allSettled([
          import(/* @vite-ignore */ `@enjoys/context-engine/completion/${key}.json`),
          import(/* @vite-ignore */ `@enjoys/context-engine/hover/${key}.json`),
          import(/* @vite-ignore */ `@enjoys/context-engine/definition/${key}.json`),
        ]);

        return {
          completions: completionMod.status === 'fulfilled'
            ? (completionMod.value.completions as LightEditorCompletionItem[] ?? [])
            : [],
          hovers: hoverMod.status === 'fulfilled'
            ? (hoverMod.value.hovers as Record<string, LightEditorHoverEntry> ?? {})
            : {},
          definitions: definitionMod.status === 'fulfilled'
            ? (definitionMod.value.definitions as Record<string, LightEditorDefinitionEntry> ?? {})
            : {},
        };
      })(),
    );
  }

  return intelligenceCache.get(key)!;
}
