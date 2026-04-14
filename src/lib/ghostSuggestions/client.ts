import { getPathSuggestion, getPathSuggestions, getLastArg, getCommandName as getCommandNameFull, FILE_AWARE_COMMANDS } from './pathCompletion';
import type {
  GhostCandidatesRequest,
  GhostCommitRequest,
  GhostSuggestionProviders,
  GhostTabOutcome,
  GhostTabState,
  GhostSuggestRequest,
  InlineSuggestionParams,
  PopupCandidatesParams,
} from './types';
import { resolveTabAction } from './behavior';

const INLINE_FS_TIMEOUT_MS = 160;
const POPUP_FS_TIMEOUT_MS = 420;

export async function fetchHistorySuggestion(
  line: string,
  scope: string,
): Promise<string | null> {
  const request: GhostSuggestRequest = { prefix: line, scope };
  return window.ipcRenderer
    .invoke('ghost_suggest', { request })
    .catch(() => null) as Promise<string | null>;
}

export async function fetchHistoryCandidates(
  line: string,
  scope: string,
  limit = 24,
): Promise<string[]> {
  const request: GhostCandidatesRequest = { prefix: line, scope, limit };
  return window.ipcRenderer
    .invoke('ghost_candidates', { request })
    .catch(() => []) as Promise<string[]>;
}

export async function commitGhostCommand(command: string, scope: string): Promise<void> {
  const request: GhostCommitRequest = { command, scope };
  // Intentionally propagate IPC errors so callers can decide retry/fallback behavior.
  await window.ipcRenderer.invoke('ghost_commit', { request });
}

export async function acceptGhostCommand(command: string, scope: string): Promise<void> {
  const request: GhostCommitRequest = { command, scope };
  // Intentionally propagate IPC errors so callers can decide retry/fallback behavior.
  await window.ipcRenderer.invoke('ghost_accept', { request });
}

export async function resolveInlineSuggestion({
  line,
  cwd,
  scope,
  providers,
}: InlineSuggestionParams): Promise<string> {
  if (!shouldUseGhostForLine(line)) {
    return '';
  }

  const enabledProviders: GhostSuggestionProviders = {
    history: providers?.history ?? true,
    filesystem: providers?.filesystem ?? true,
  };

  const directoryCommand = isDirectoryCommand(line);
  const filesystemCommand = isFilesystemCommand(line);
  const preferPath = shouldPreferPathSuggestion(line);

  if (preferPath && enabledProviders.filesystem) {
    const fsSuffix = await getPathSuggestion(line, cwd, scope, INLINE_FS_TIMEOUT_MS).catch(() => null);
    if (fsSuffix) return fsSuffix;
  }

  // For filesystem-oriented commands, keep inline ghost text suppressed to
  // avoid overlay collisions and rely on popup/file-list candidates instead.
  if (directoryCommand || filesystemCommand) {
    return '';
  }

  if (enabledProviders.history) {
    const historySuffix = await fetchHistorySuggestion(line, scope);
    if (historySuffix) return historySuffix;
  }

  if (!preferPath && enabledProviders.filesystem) {
    const fsSuffix = await getPathSuggestion(line, cwd, scope, INLINE_FS_TIMEOUT_MS).catch(() => null);
    if (fsSuffix) return fsSuffix;
  }

  return '';
}

export async function resolvePopupCandidates({
  line,
  cwd,
  scope,
  preferPath,
  limit = 24,
  providers,
}: PopupCandidatesParams): Promise<string[]> {
  if (!shouldUseGhostForLine(line)) {
    return [];
  }

  const enabledProviders: GhostSuggestionProviders = {
    history: providers?.history ?? true,
    filesystem: providers?.filesystem ?? true,
  };
  const directoryCommand = isDirectoryCommand(line);
  const filesystemCommand = isFilesystemCommand(line);

  const filesystemPromise = enabledProviders.filesystem
    ? getPathSuggestions(line, cwd, scope, limit, POPUP_FS_TIMEOUT_MS).catch(() => [])
    : Promise.resolve<string[]>([]);
  const filesystemItems = await filesystemPromise;
  if (directoryCommand || filesystemCommand) {
    return filesystemItems;
  }
  // Only fetch history when needed — not for filesystem-only commands.
  const historyItems = enabledProviders.history
    ? await fetchHistoryCandidates(line, scope, limit)
    : [];

  if (preferPath && filesystemItems.length >= 2) {
    return filesystemItems.slice(0, Math.max(1, limit));
  }

  return preferPath
    ? mergeCandidateLists(filesystemItems, historyItems, limit)
    : mergeCandidateLists(historyItems, filesystemItems, limit);
}

interface ResolveTabCompletionParams {
  line: string;
  cwd?: string;
  scope: string;
  previousTabState: GhostTabState;
  now: number;
  limit?: number;
  providers?: GhostSuggestionProviders;
}

export async function resolveTabCompletionOutcome({
  line,
  cwd,
  scope,
  previousTabState,
  now,
  limit = 24,
  providers,
}: ResolveTabCompletionParams): Promise<GhostTabOutcome> {
  if (line.trim().length < 1) {
    return { kind: 'fallback' };
  }

  const preferPath = shouldPreferPathSuggestion(line);
  const items = await resolvePopupCandidates({ line, cwd, scope, preferPath, limit, providers });
  if (!items.length) {
    return { kind: 'fallback' };
  }

  const action = resolveTabAction(line, items, previousTabState, now);
  if (action.kind === 'accept') {
    return { kind: 'accept', suffix: action.suffix, nextState: action.nextState };
  }
  if (action.kind === 'show_list') {
    return { kind: 'show_list', items, nextState: action.nextState };
  }
  return { kind: 'fallback' };
}

function mergeCandidateLists(primary: string[], secondary: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const suffix of [...primary, ...secondary]) {
    const key = suffix.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suffix);
    if (out.length >= Math.max(1, limit)) break;
  }

  return out;
}

export function shouldPreferPathSuggestion(line: string): boolean {
  if (isFilesystemCommand(line)) {
    return true;
  }
  const lastArg = getLastArg(line);
  return lastArg.includes('/') || lastArg.includes('\\');
}

function isDirectoryCommand(line: string): boolean {
  const command = getCommandNameFull(line);
  return command === 'cd' || command === 'pushd' || command === 'popd';
}

function isFilesystemCommand(line: string): boolean {
  return isDirectoryCommand(line) || FILE_AWARE_COMMANDS.has(getCommandNameFull(line));
}

function shouldUseGhostForLine(line: string): boolean {
  return Boolean(getCommandNameFull(line));
}
