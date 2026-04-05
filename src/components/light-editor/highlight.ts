import Prism from 'prismjs';
import type { LineModel } from './core/lineModel.js';
import { createLineModel, getLineSlice as getLineSliceFromModel } from './core/lineModel.js';

import 'prismjs/components/prism-c.js';
import 'prismjs/components/prism-cpp.js';
import 'prismjs/components/prism-csharp.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-scss.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-java.js';
import 'prismjs/components/prism-ruby.js';
import 'prismjs/components/prism-docker.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-ini.js';
import 'prismjs/components/prism-kotlin.js';
import 'prismjs/components/prism-swift.js';
import 'prismjs/components/prism-graphql.js';
import 'prismjs/components/prism-powershell.js';
import 'prismjs/components/prism-makefile.js';
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-css.js';

export const HIGHLIGHT_SIZE_LIMIT = 150_000;
export const LIGHT_EDITOR_LINE_HEIGHT = 24;
export const LIGHT_EDITOR_VERTICAL_PADDING = 12;
export const LIGHT_EDITOR_VIRTUAL_BUFFER_LINES = 20;
export const LIGHT_EDITOR_HIGHLIGHT_CACHE_LIMIT = 24;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getPrismLanguage(language: string): string | null {
  const map: Record<string, string | null> = {
    javascript: 'javascript',
    typescript: 'typescript',
    html: 'markup',
    css: 'css',
    scss: 'scss',
    less: 'css',
    json: 'json',
    yaml: 'yaml',
    xml: 'markup',
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
    shell: 'bash',
    powershell: 'powershell',
    markdown: 'markdown',
    sql: 'sql',
    graphql: 'graphql',
    dockerfile: 'docker',
    makefile: 'makefile',
    plaintext: null,
  };

  return map[language] ?? null;
}

export async function loadHighlightConfig(language: string): Promise<string | null> {
  return getPrismLanguage(language);
}

export function renderHighlightedHtml(content: string, prismLanguage: string | null): string {
  if (!prismLanguage || content.length > HIGHLIGHT_SIZE_LIMIT) {
    return escapeHtml(content);
  }

  const grammar = Prism.languages[prismLanguage];
  if (!grammar) return escapeHtml(content);

  try {
    return Prism.highlight(content, grammar, prismLanguage);
  } catch {
    return escapeHtml(content);
  }
}

export function createHighlightCacheKey(
  prismLanguage: string | null,
  startLine: number,
  endLine: number,
  visibleContent: string,
) {
  return `${prismLanguage ?? 'plain'}:${startLine}:${endLine}:${visibleContent.length}:${hashString(visibleContent)}`;
}

export function getHighlightViewport(scrollTop: number, viewportHeight: number, totalLines: number) {
  const visibleLines = Math.max(1, Math.ceil(viewportHeight / LIGHT_EDITOR_LINE_HEIGHT));
  const startLine = Math.max(0, Math.floor(scrollTop / LIGHT_EDITOR_LINE_HEIGHT) - LIGHT_EDITOR_VIRTUAL_BUFFER_LINES);
  const endLine = Math.min(totalLines, startLine + visibleLines + LIGHT_EDITOR_VIRTUAL_BUFFER_LINES * 2);
  return { startLine, endLine };
}

export function getLineSlice(contentOrModel: string | LineModel, startLine: number, endLine: number) {
  const lineModel = typeof contentOrModel === 'string'
    ? createLineModel(contentOrModel)
    : contentOrModel;

  return getLineSliceFromModel(lineModel, startLine, endLine);
}
