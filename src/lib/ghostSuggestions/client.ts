import { lineForSuggestionParsing } from './activeSegment.js';
import { normalizeSuggestionSuffix } from './suggestionSuffix.js';
import {
  getPathSuggestion,
  getLastArg,
  getCommandName as getCommandNameFull,
  FILE_AWARE_COMMANDS,
  hasUnmatchedQuoteOnActiveToken,
  isBareDirectoryListingLine,
  REMOTE_FS_LIST_TIMEOUT_MS,
} from './pathCompletion.js';
import { ghostDebug } from './ghostDebug.js';
import { WSL_FS_LIST_TIMEOUT_MS } from './wslShell.js';
import { cwdForWslPathCompletion, shellIdIndicatesWsl } from './wslShell.js';
import type {
  GhostCommitRequest,
  GhostSuggestionProviders,
  GhostSuggestRequest,
  InlineSuggestionParams,
} from './types.js';

const INLINE_FS_TIMEOUT_MS = 160;

function inlineFsTimeoutMs(connectionId: string, wslShellId?: string): number {
  if (wslShellId && shellIdIndicatesWsl(wslShellId)) return WSL_FS_LIST_TIMEOUT_MS;
  if (connectionId !== 'local') return REMOTE_FS_LIST_TIMEOUT_MS;
  return INLINE_FS_TIMEOUT_MS;
}

export async function fetchHistorySuggestion(
  line: string,
  scope: string,
): Promise<string | null> {
  const request: GhostSuggestRequest = { prefix: line, scope };
  return window.ipcRenderer
    .invoke('ghost_suggest', { request })
    .catch(() => null) as Promise<string | null>;
}

export async function commitGhostCommand(command: string, scope: string): Promise<void> {
  const request: GhostCommitRequest = { command, scope };
  await window.ipcRenderer.invoke('ghost_commit', { request });
}

export async function acceptGhostCommand(command: string, scope: string): Promise<void> {
  const request: GhostCommitRequest = { command, scope };
  await window.ipcRenderer.invoke('ghost_accept', { request });
}

export async function resolveInlineSuggestion({
  line,
  cwd,
  scope,
  fsConnectionId,
  wslShellId,
  providers,
}: InlineSuggestionParams): Promise<string> {
  if (!shouldUseGhostForLine(line)) {
    ghostDebug('resolve', { phase: 'skip', reason: 'line-not-eligible', line });
    return '';
  }

  const enabledProviders: GhostSuggestionProviders = {
    history: providers?.history ?? true,
    filesystem: providers?.filesystem ?? true,
  };

  const preferPath = shouldPreferPathSuggestion(line);
  const listConnectionId = fsConnectionId ?? scope;
  const listCwd = wslShellId ? cwdForWslPathCompletion(cwd) : cwd;
  const fsTimeoutMs = inlineFsTimeoutMs(listConnectionId, wslShellId);

  ghostDebug('resolve', {
    line,
    scope,
    listConnectionId,
    cwd: listCwd ?? null,
    wslShellId: wslShellId ?? null,
    preferPath,
    fsTimeoutMs,
    providers: enabledProviders,
  });

  if (preferPath && enabledProviders.filesystem) {
    const fsSuffix = await getPathSuggestion(
      line,
      listCwd,
      listConnectionId,
      fsTimeoutMs,
      wslShellId,
    ).catch(() => null);
    if (fsSuffix) {
      const normalized = normalizeSuggestionSuffix(line, fsSuffix);
      ghostDebug('resolve', { phase: 'path-hit', suffix: normalized });
      return normalized;
    }
  }

  const skipHistoryForBareCd = preferPath
    && enabledProviders.filesystem
    && isBareDirectoryListingLine(line);
  const skipHistoryForOpenQuote = hasUnmatchedQuoteOnActiveToken(line);

  if (enabledProviders.history && !skipHistoryForBareCd && !skipHistoryForOpenQuote) {
    const historySuffix = await fetchHistorySuggestion(line, scope);
    if (historySuffix) {
      const normalized = normalizeSuggestionSuffix(line, historySuffix);
      ghostDebug('resolve', { phase: 'history-hit', suffix: normalized });
      return normalized;
    }
  }

  if (!preferPath && enabledProviders.filesystem) {
    const fsSuffix = await getPathSuggestion(
      line,
      listCwd,
      listConnectionId,
      fsTimeoutMs,
      wslShellId,
    ).catch(() => null);
    if (fsSuffix) {
      const normalized = normalizeSuggestionSuffix(line, fsSuffix);
      ghostDebug('resolve', { phase: 'path-hit-secondary', suffix: normalized });
      return normalized;
    }
  }

  ghostDebug('resolve', { phase: 'empty', skipHistoryForBareCd });
  return '';
}

export function shouldPreferPathSuggestion(line: string): boolean {
  const parseLine = lineForSuggestionParsing(line);
  if (isFilesystemCommand(parseLine)) {
    return true;
  }
  const lastArg = getLastArg(parseLine);
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
  return Boolean(getCommandNameFull(lineForSuggestionParsing(line)));
}