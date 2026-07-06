import assert from 'node:assert/strict';
import {
  extractActiveSegment,
  lineForSuggestionParsing,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/activeSegment.js';
import {
  shouldPreferPathSuggestion,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/client.js';
import {
  normalizeSuggestionSuffix,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/suggestionSuffix.js';
import {
  handleGhostInputEvent,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/runtime.js';
import {
  expandTildePathForRemote,
  getPathSuggestions,
  hasUnmatchedQuoteOnActiveToken,
  isBareDirectoryListingLine,
  WSL_FS_LIST_TIMEOUT_MS,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/pathCompletion.js';
import {
  InputTracker,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/inputTracker.js';
import {
  extractCwdFromPromptOutput,
  extractPowerShellCwd,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/promptCwdSniffer.js';
import {
  resolveCdTargetPath,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/cwdTracking.js';
import {
  classifyInputEscape,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/escapeInput.js';
import {
  shouldSuppressGhostForNativeShell,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/shellSuppression.js';
import {
  shouldProbeZshAutosuggest,
  zshInitEnablesAutosuggestions,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/zshAutosuggestDetect.js';
import {
  cwdForWslPathCompletion,
  linuxPathLooksLikeWsl,
  resolveWslShellIdForPathCompletion,
  shellIdIndicatesWsl,
} from '../.tmp-agent-tests/src/lib/ghostSuggestions/wslShell.js';
async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL ${name}: ${message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    } else {
      console.error(error);
    }
    throw error;
  }
}

async function withMockWindow(mockWindow, fn) {
  const originalWindow = globalThis.window;
  globalThis.window = mockWindow;
  try {
    await fn();
  } finally {
    globalThis.window = originalWindow;
  }
}

await runTest('extractPowerShellCwd reads PS path prompts with angle bracket', () => {
  const cwd = extractPowerShellCwd('Directory: E:\\work\r\nPS E:\\work\u203A cd ');
  assert.equal(cwd, 'E:\\work');
});

await runTest('extractPowerShellCwd reads classic PS greater-than prompt', () => {
  const cwd = extractPowerShellCwd('PS C:\\Users\\me\\projects> ');
  assert.equal(cwd, 'C:\\Users\\me\\projects');
});

await runTest('extractCwdFromPromptOutput prefers PowerShell match in mixed output', () => {
  const cwd = extractCwdFromPromptOutput('\x1b[32mPS E:\\work\u203A\x1b[0m ');
  assert.equal(cwd, 'E:\\work');
});

await runTest('handleGhostInputEvent accepts inline ghost with right arrow', () => {
  let accepted = '';
  const tracker = new InputTracker({
    onLineChange: () => {},
    onAccept: (suffix) => { accepted = suffix; },
    onDismiss: () => {},
    onHistoryCommit: () => {},
  });

  tracker.feed('git ');
  tracker.setSuggestion('status');

  const handled = handleGhostInputEvent('\x1b[C', tracker);
  assert.equal(handled, true);
  assert.equal(accepted, 'status');
  assert.equal(tracker.getLineBuffer(), 'git status');
});

await runTest('handleGhostInputEvent passes Tab to shell when no active suggestion', () => {
  const tracker = new InputTracker({
    onLineChange: () => {},
    onAccept: () => {},
    onDismiss: () => {},
    onHistoryCommit: () => {},
  });

  tracker.feed('git ');
  const handled = handleGhostInputEvent('\t', tracker);
  assert.equal(handled, false);
  assert.equal(tracker.isDesynced(), true);
});

await runTest('handleGhostInputEvent passes Tab to shell and dismisses ghost when suffix is active', () => {
  let accepted = '';
  let dismissed = 0;
  const tracker = new InputTracker({
    onLineChange: () => {},
    onAccept: (suffix) => { accepted = suffix; },
    onDismiss: () => { dismissed += 1; },
    onHistoryCommit: () => {},
  });

  for (const ch of 'git ') tracker.feed(ch);
  tracker.setSuggestion('status');

  const handled = handleGhostInputEvent('\t', tracker);
  assert.equal(handled, false);
  assert.equal(accepted, '');
  assert.equal(dismissed, 1);
  assert.equal(tracker.isDesynced(), true);
  assert.equal(tracker.getLineBuffer(), 'git ');
});

await runTest('InputTracker suppresses ghost fetches while desynced after Tab', () => {
  const changed = [];
  const tracker = new InputTracker({
    onLineChange: (line) => changed.push(line),
    onAccept: () => {},
    onDismiss: () => {},
    onHistoryCommit: () => {},
  });

  for (const ch of 'git ') tracker.feed(ch);
  tracker.feed('\t');
  tracker.feed('s');

  assert.equal(tracker.isDesynced(), true);
  assert.deepEqual(changed, ['g', 'gi', 'git', 'git ']);
});

await runTest('InputTracker skips history commit while desynced then resets on Enter', () => {
  let committed = null;
  const tracker = new InputTracker({
    onLineChange: () => {},
    onAccept: () => {},
    onDismiss: () => {},
    onHistoryCommit: (cmd) => { committed = cmd; },
  });

  for (const ch of 'git ') tracker.feed(ch);
  tracker.feed('\t');
  assert.equal(tracker.isDesynced(), true);

  tracker.feed('\r');
  assert.equal(committed, null);
  assert.equal(tracker.isDesynced(), false);
  assert.equal(tracker.getLineBuffer(), '');
});

await runTest('InputTracker resumes ghost tracking after Ctrl+C clears desync', () => {
  const changed = [];
  const tracker = new InputTracker({
    onLineChange: (line) => changed.push(line),
    onAccept: () => {},
    onDismiss: () => {},
    onHistoryCommit: () => {},
  });

  for (const ch of 'git ') tracker.feed(ch);
  tracker.feed('\t');
  tracker.feed('\x03');
  tracker.feed('l');

  assert.equal(tracker.isDesynced(), false);
  assert.deepEqual(changed, ['g', 'gi', 'git', 'git ', 'l']);
});

await runTest('resolveCdTargetPath resolves relative multi-segment cd targets', () => {
  assert.equal(resolveCdTargetPath('cd foo/bar', 'E:\\work'), 'E:\\work\\foo\\bar');
  assert.equal(resolveCdTargetPath('cd ./src/lib', '/home/me'), '/home/me/src/lib');
});

await runTest('resolveCdTargetPath parentDirectory handles tilde cwd', () => {
  assert.equal(resolveCdTargetPath('cd ..', '~/foo/bar'), '~/foo');
  assert.equal(resolveCdTargetPath('cd ..', '~/only'), '~');
  assert.equal(resolveCdTargetPath('cd ..', '~'), null);
});

await runTest('resolveCdTargetPath parentDirectory preserves Windows drive root', () => {
  assert.equal(resolveCdTargetPath('cd ..', 'C:\\'), 'C:\\');
  assert.equal(resolveCdTargetPath('cd ..', 'C:'), 'C:\\');
  assert.equal(resolveCdTargetPath('cd ..', 'E:\\work'), 'E:\\');
});

await runTest('isBareDirectoryListingLine matches bare cd token', () => {
  assert.equal(isBareDirectoryListingLine('cd'), true);
  assert.equal(isBareDirectoryListingLine('cd '), true);
  assert.equal(isBareDirectoryListingLine('cd data'), false);
});

await runTest('normalizeSuggestionSuffix adds space when line lacks trailing whitespace', () => {
  assert.equal(normalizeSuggestionSuffix('echo hi && git', 'checkout staging'), ' checkout staging');
  assert.equal(normalizeSuggestionSuffix('echo hi && git ', 'checkout staging'), 'checkout staging');
  assert.equal(normalizeSuggestionSuffix('echo hi && git', ' checkout staging'), ' checkout staging');
  assert.equal(normalizeSuggestionSuffix('cd Doc', 'uments/'), 'uments/');
});

await runTest('extractActiveSegment parses pipeline and separator tails', () => {
  assert.equal(extractActiveSegment('echo hi && git che'), 'git che');
  assert.equal(extractActiveSegment('ls -la | grep x; cd /va'), 'cd /va');
  assert.equal(extractActiveSegment('sudo env FOO=1 git sta'), 'git sta');
  assert.equal(lineForSuggestionParsing('echo hi | cat '), 'cat ');
});

await runTest('shouldPreferPathSuggestion uses active segment command', () => {
  assert.equal(shouldPreferPathSuggestion('echo hi && cd Doc'), true);
  assert.equal(shouldPreferPathSuggestion('echo hi && git status'), false);
});

await runTest('resolveCdTargetPath uses active segment for pipelines', () => {
  assert.equal(resolveCdTargetPath('echo hi && cd foo/bar', '/home/me'), '/home/me/foo/bar');
  assert.equal(resolveCdTargetPath('ls | cd ..', '/home/me/projects'), '/home/me');
});

await runTest('getPathSuggestions uses active segment for pipeline cd', async () => {
  await withMockWindow({
    ipcRenderer: {
      invoke: async (_cmd, payload) => {
        assert.equal(payload.path, '/home/me');
        return [
          { name: 'Documents', type: 'directory' },
          { name: 'Downloads', type: 'directory' },
        ];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('echo hi && cd Doc', '/home/me', 'local', 10);
    assert.deepEqual(out, ['uments/']);
  });
});

await runTest('getPathSuggestions maps home prefix for file-aware commands', async () => {
  await withMockWindow({
    ipcRenderer: {
      invoke: async (_cmd, payload) => {
        assert.equal(payload.path, '');
        return [
          { name: 'notes.txt', type: 'file' },
          { name: 'Documents', type: 'directory' },
        ];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('cat ~/no', '/home/me', 'local', 10);
    assert.deepEqual(out, ['tes.txt']);
  });
});

await runTest('getPathSuggestions expands tilde cwd for WSL fs_list_wsl', async () => {
  await withMockWindow({
    ipcRenderer: {
      invoke: async (cmd, payload) => {
        if (cmd === 'wsl_get_cwd') {
          return '/home/wsluser';
        }
        assert.equal(cmd, 'fs_list_wsl');
        assert.equal(payload.path, '/home/wsluser');
        return [{ name: 'data', type: 'directory' }];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('cd', '~', 'local', 10, WSL_FS_LIST_TIMEOUT_MS, 'wsl');
    assert.deepEqual(out, ['data/']);
  });
});

await runTest('getPathSuggestions expands tilde path segments for WSL listing', async () => {
  await withMockWindow({
    ipcRenderer: {
      invoke: async (cmd, payload) => {
        if (cmd === 'wsl_get_cwd') {
          return '/home/wsluser';
        }
        assert.equal(cmd, 'fs_list_wsl');
        assert.equal(payload.path, '/home/wsluser');
        return [
          { name: 'projects', type: 'directory' },
          { name: 'data', type: 'directory' },
        ];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('cd ~/p', '~', 'local', 10, WSL_FS_LIST_TIMEOUT_MS, 'wsl:tilde-test');
    assert.deepEqual(out, ['rojects/']);
  });
});

await runTest('handleGhostInputEvent feeds tracker for printable input', () => {
  let feedCalls = 0;
  const tracker = {
    feed: () => {
      feedCalls += 1;
      return { consumed: false };
    },
  };

  const handled = handleGhostInputEvent('a', tracker);
  assert.equal(handled, false);
  assert.equal(feedCalls, 1);
});

await runTest('getPathSuggestions lists cwd entries for bare cd command token', async () => {
  await withMockWindow({
    ipcRenderer: {
      invoke: async (_cmd, payload) => {
        assert.equal(payload.connectionId, 'local');
        assert.equal(payload.path, '/home/me');
        return [
          { name: 'Documents', type: 'directory' },
          { name: 'Downloads', type: 'directory' },
        ];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('cd', '/home/me', 'local', 10);
    assert.deepEqual(out, ['Documents/', 'Downloads/']);
  });
});

await runTest('getPathSuggestions supports bare cd folder prefixes without slash', async () => {
  await withMockWindow({
    ipcRenderer: {
      invoke: async (_cmd, payload) => {
        assert.equal(payload.path, '/home/me');
        return [
          { name: 'Documents', type: 'directory' },
          { name: 'Downloads', type: 'directory' },
          { name: 'notes.txt', type: 'file' },
        ];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('cd Do', '/home/me', 'local-cd', 10);
    assert.deepEqual(out, ['cuments/', 'wnloads/']);
  });
});

await runTest('getPathSuggestions keeps non-path commands quiet for bare words', async () => {
  let called = false;
  await withMockWindow({
    ipcRenderer: {
      invoke: async () => {
        called = true;
        return [];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('echo Do', '/home/me', 'local-echo', 10);
    assert.deepEqual(out, []);
    assert.equal(called, false);
  });
});

await runTest('getPathSuggestions supports bare file prefixes for cat', async () => {
  await withMockWindow({
    ipcRenderer: {
      invoke: async (_cmd, payload) => {
        assert.equal(payload.path, '/home/me');
        return [
          { name: 'README.md', type: 'file' },
          { name: 'README.txt', type: 'file' },
          { name: 'reports', type: 'directory' },
        ];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('cat REA', '/home/me', 'local-cat', 10);
    assert.deepEqual(out, ['DME.md', 'DME.txt']);
  });
});

await runTest('getPathSuggestions does not use bare-word FS for non-core commands', async () => {
  let called = false;
  await withMockWindow({
    ipcRenderer: {
      invoke: async () => {
        called = true;
        return [];
      },
    },
  }, async () => {
    const out = await getPathSuggestions('pwd Do', '/home/me', 'local-pwd', 10);
    assert.deepEqual(out, []);
    assert.equal(called, false);
  });
});

await runTest('getPathSuggestions falls back to stale cache on slow fs_list', async () => {
  let callCount = 0;
  await withMockWindow({
    ipcRenderer: {
      invoke: async () => {
        callCount += 1;
        if (callCount === 1) {
          return [{ name: 'Documents', type: 'directory' }];
        }
        return new Promise(() => {});
      },
    },
  }, async () => {
    const first = await getPathSuggestions('cd Do', '/home/me', 'local-cache', 10, 50);
    assert.deepEqual(first, ['cuments/']);

    const second = await getPathSuggestions('cd Do', '/home/me', 'local-cache', 10, 10);
    assert.deepEqual(second, ['cuments/']);
  });
});

await runTest('InputTracker desyncs on left arrow without clearing line buffer', () => {
  const changed = [];
  const tracker = new InputTracker({
    onLineChange: (line) => changed.push(line),
    onAccept: () => {},
    onDismiss: () => {},
    onHistoryCommit: () => {},
  });

  tracker.feed('g');
  tracker.feed('i');
  tracker.feed('\x1b[D');
  tracker.feed('t');

  assert.deepEqual(changed, ['g', 'gi']);
  assert.equal(tracker.isDesynced(), true);
  assert.equal(tracker.getLineBuffer(), 'gi');

  tracker.feed('\r');
  assert.equal(tracker.isDesynced(), false);
  assert.equal(tracker.getLineBuffer(), '');
});

await runTest('InputTracker desyncs on history keys without clearing line buffer', () => {
  const tracker = new InputTracker({
    onLineChange: () => {},
    onAccept: () => {},
    onDismiss: () => {},
    onHistoryCommit: () => {},
  });

  tracker.feed('git status');
  tracker.feed('\x12');
  assert.equal(tracker.isDesynced(), true);
  assert.equal(tracker.getLineBuffer(), 'git status');

  tracker.feed('\x03');
  assert.equal(tracker.isDesynced(), false);
  assert.equal(tracker.getLineBuffer(), '');
});

await runTest('classifyInputEscape categorizes cursor and history edits', () => {
  assert.equal(classifyInputEscape('\x1b[D'), 'cursor_edit');
  assert.equal(classifyInputEscape('\x1b[A'), 'history_edit');
  assert.equal(classifyInputEscape('\x12'), 'history_edit');
  assert.equal(classifyInputEscape('\x1b[200~'), 'unknown');
  assert.equal(classifyInputEscape('a'), null);
});

await runTest('shouldSuppressGhostForNativeShell respects policy', () => {
  assert.equal(shouldSuppressGhostForNativeShell('auto', '/usr/bin/fish'), true);
  assert.equal(shouldSuppressGhostForNativeShell('auto', '/bin/zsh'), false);
  assert.equal(shouldSuppressGhostForNativeShell('auto', '/bin/zsh', false), false);
  assert.equal(shouldSuppressGhostForNativeShell('auto', '/bin/zsh', true), true);
  assert.equal(shouldSuppressGhostForNativeShell('auto', 'powershell'), false);
  assert.equal(shouldSuppressGhostForNativeShell('always', '/usr/bin/fish'), false);
  assert.equal(shouldSuppressGhostForNativeShell('off', '/bin/zsh'), true);
  assert.equal(shouldSuppressGhostForNativeShell('off', '/bin/bash'), true);
});

await runTest('cwdForWslPathCompletion ignores Windows drive paths', () => {
  assert.equal(cwdForWslPathCompletion('E:\\\\work'), undefined);
  assert.equal(cwdForWslPathCompletion('/home/gajendra'), '/home/gajendra');
});

await runTest('shouldProbeZshAutosuggest includes zsh and WSL shell ids', () => {
  assert.equal(shouldProbeZshAutosuggest('/bin/zsh'), true);
  assert.equal(shouldProbeZshAutosuggest('wsl'), true);
  assert.equal(shouldProbeZshAutosuggest('wsl:Ubuntu'), true);
  assert.equal(shouldProbeZshAutosuggest('powershell'), false);
  assert.equal(shellIdIndicatesWsl('wsl:Ubuntu-22.04'), true);
});

await runTest('zshInitEnablesAutosuggestions detects common plugin hooks', () => {
  assert.equal(
    zshInitEnablesAutosuggestions('plugins=(git autosuggestions)\n'),
    true,
  );
  assert.equal(
    zshInitEnablesAutosuggestions('source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh\n'),
    true,
  );
  assert.equal(
    zshInitEnablesAutosuggestions('# zsh-autosuggestions disabled\nplugins=(git)\n'),
    false,
  );
});

await runTest('hasUnmatchedQuoteOnActiveToken blocks open quotes on active token', () => {
  assert.equal(hasUnmatchedQuoteOnActiveToken('cat "My '), true);
  assert.equal(hasUnmatchedQuoteOnActiveToken('cat "My file"'), false);
});

await runTest('extractCwdFromPromptOutput reads host:tilde prompts without @', () => {
  const cwd = extractCwdFromPromptOutput('data\r\nkgajendra:~ $ ');
  assert.equal(cwd, '~');
});

await runTest('expandTildePathForRemote maps tilde paths for SFTP', () => {
  assert.equal(expandTildePathForRemote('~', '/home/gajen'), '/home/gajen');
  assert.equal(expandTildePathForRemote('~/data', '/home/gajen'), '/home/gajen/data');
  assert.equal(expandTildePathForRemote('/var/log', '/home/gajen'), '/var/log');
});

await runTest('resolveWslShellIdForPathCompletion infers WSL from Linux cwd', () => {
  assert.equal(resolveWslShellIdForPathCompletion('default', '~'), 'wsl');
  assert.equal(resolveWslShellIdForPathCompletion('powershell', '/home/gajendra'), 'wsl');
  assert.equal(resolveWslShellIdForPathCompletion('wsl:Ubuntu', '~'), 'wsl:Ubuntu');
  assert.equal(resolveWslShellIdForPathCompletion('powershell', 'E:\\\\work'), undefined);
  assert.equal(linuxPathLooksLikeWsl('~/data'), true);
});