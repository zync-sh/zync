/**
 * pathCompletion.ts — filesystem-aware ghost suffix (fish-style path completion).
 *
 * Priority mirrors fish shell:
 *   1. History (handled upstream by ghost_suggest Rust command)
 *   2. Filesystem entries in the directory matching the typed path prefix
 *
 * Triggers when:
 *   - the last argument includes a path separator (`/` or `\`), or
 *   - the command is directory-only (`cd`/`pushd`/`popd`) so bare `cd Doc`
 *     still gets folder suggestions from the current directory.
 *
 * Works for both local and SSH connections via the existing `fs_list` command.
 * Windows backslash paths are detected and handled separately.
 */

interface FsEntry {
  name: string;
  /** 'file' | 'directory' | 'symlink' — only name and type are used here */
  type: string;
}

const DIRECTORY_ONLY_COMMANDS = new Set(['cd', 'pushd', 'popd']);
export const FILE_AWARE_COMMANDS = new Set([
  'cat',
  'ls',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'vim',
  'nvim',
  'nano',
  'cp',
  'mv',
  'rm',
  'mkdir',
  'rmdir',
  'touch',
  'find',
  'stat',
  'chmod',
  'chown',
]);
const FS_LIST_CACHE_TTL_MS = 1200;
const FS_LIST_TIMEOUT_MS = 450;
const fsListCache = new Map<string, { at: number; entries: FsEntry[] }>();

// ─── Path parsing ─────────────────────────────────────────────────────────────

/**
 * Extract the last shell argument from a command line.
 * Handles single- and double-quoted strings so a path with spaces works.
 */
export function getLastArg(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let start = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      // Note: backslash is treated as an escape even inside single quotes,
      // which differs from POSIX semantics but is safe for path completion purposes.
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === ' ' && !inSingle && !inDouble) start = i + 1;
  }

  return line.slice(start);
}

export /**
 * Strip a leading unmatched opening quote from a shell argument so that
 * `"My D` becomes `My D` for prefix matching purposes.
 * Only strips when the quote has no matching closing counterpart.
 */
function stripLeadingUnmatchedQuote(arg: string): string {
  if (arg.length > 0 && (arg[0] === '"' || arg[0] === "'")) {
    const q = arg[0];
    if (!arg.slice(1).includes(q)) return arg.slice(1);
  }
  return arg;
}

/**
 * Split a shell command line into tokens, respecting single/double quotes and
 * backslash escapes so that `GREETING="hello world"` is one token, not two.
 */
function shellTokenize(line: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) { token += ch; escaped = false; continue; }
    if (ch === '\\' && !inSingle) { escaped = true; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (token) { tokens.push(token); token = ''; }
      continue;
    }
    token += ch;
  }
  if (token) tokens.push(token);
  return tokens;
}

const FLAGS_WITH_ARG = new Set(['-u', '--user', '-g', '--group', '-o', '-p',
  '-t', '-c', '-s', '-f', '-k', '-m', '-n', '-d']);

export function getCommandName(line: string): string {
  const trimmed = line.trimStart();
  if (!trimmed) return '';
  const wrappers = new Set(['sudo', 'env', 'time', 'nohup', 'command']);
  const parts = shellTokenize(trimmed);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase();
    if (wrappers.has(part)) {
      // Skip flags and their arguments that follow the wrapper so that e.g.
      // `sudo -u root cat` and `env -u VAR cat` correctly identify `cat`.
      // Flags in this set take a value as the next token.
      while (i + 1 < parts.length) {
        const next = parts[i + 1];
        if (FLAGS_WITH_ARG.has(next.toLowerCase())) {
          i += 2; // skip flag + its argument
          continue;
        }
        if (next.startsWith('-')) { i++; continue; }
        if (part === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) { i++; continue; }
        break;
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) continue;
    return part;
  }
  return '';
}

/** True when `arg` looks like it contains a path separator the user typed. */
function hasPathSeparator(arg: string): boolean {
  return arg.includes('/') || arg.includes('\\');
}

/** Detect the separator style of a path. */
function isWindowsPath(arg: string): boolean {
  // Drive letter (C:\) or UNC (\\) → Windows style
  return /^[A-Za-z]:[/\\]/.test(arg) || arg.startsWith('\\\\');
}

/** For scp/ssh-like host:path targets we cannot reliably list remote host FS here. */
function looksLikeRemoteTarget(arg: string): boolean {
  if (isWindowsPath(arg)) return false;
  const colon = arg.indexOf(':');
  if (colon <= 0) return false;
  const slash = arg.search(/[\\/]/);
  return slash === -1 || colon < slash;
}

/**
 * Split a path at the last separator into (dir, partial).
 * e.g. "/usr/lo"        → { dir: "/usr/",        partial: "lo",  sep: "/" }
 *      "C:\\Users\\doc" → { dir: "C:\\Users\\",   partial: "doc", sep: "\\" }
 *      "~/Doc"          → { dir: "~/",            partial: "Doc", sep: "/" }
 */
function splitPath(
  arg: string,
): { dir: string; partial: string; sep: string } | null {
  // Normalise mixed slashes on Windows paths to backslash
  const sep = isWindowsPath(arg) ? '\\' : '/';
  const lastSep = Math.max(arg.lastIndexOf('/'), arg.lastIndexOf('\\'));

  if (lastSep === -1) return null;

  return {
    dir: arg.slice(0, lastSep + 1),
    partial: arg.slice(lastSep + 1),
    sep,
  };
}

/**
 * Resolve a (possibly relative) dir against cwd, returning the absolute path
 * to pass to `fs_list`.
 *
 * Absolute paths and `~` paths are returned as-is (backend handles tilde
 * expansion). Relative paths (`./`, `../`, or bare `foo/`) are joined with cwd.
 */
function resolveDir(dir: string, cwd: string, sep: string): string {
  // Already absolute or home-relative — pass through
  if (
    dir.startsWith('/') ||
    dir.startsWith('~') ||
    /^[A-Za-z]:[/\\]/.test(dir) ||
    dir.startsWith('\\\\')
  ) {
    return dir;
  }

  const base = cwd.endsWith(sep) ? cwd.slice(0, -1) : cwd;

  if (dir.startsWith('./') || dir.startsWith('.\\')) {
    return `${base}${sep}${dir.slice(2)}`;
  }

  // Starts with `../` — let the backend resolve the parent traversal
  return `${base}${sep}${dir}`;
}

/**
 * Strip the trailing separator so `fs_list` receives a bare directory path
 * (e.g. "/usr" not "/usr/"), unless the path is the root itself.
 */
function stripTrailingSep(path: string): string {
  if (path === '/' || /^[A-Za-z]:[/\\]$/.test(path)) return path;
  return path.replace(/[/\\]+$/, '');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return a ghost-text suffix for a filesystem path the user is typing, or
 * `null` when no completion is available.
 *
 * @param line         Full current command line (e.g. `cd /usr/lo`)
 * @param cwd          Current working directory of the terminal session
 * @param connectionId Connection ID passed to `fs_list` (`'local'` for local)
 */
export async function getPathSuggestion(
  line: string,
  cwd: string | undefined,
  connectionId: string,
  timeoutMs = FS_LIST_TIMEOUT_MS,
): Promise<string | null> {
  const matches = await getPathSuggestions(line, cwd, connectionId, 1, timeoutMs);
  return matches[0] ?? null;
}

function inferSeparator(cwd: string | undefined): string {
  if (cwd?.includes('\\')) return '\\';
  return '/';
}

export async function getPathSuggestions(
  line: string,
  cwd: string | undefined,
  connectionId: string,
  limit = 32,
  timeoutMs = FS_LIST_TIMEOUT_MS,
): Promise<string[]> {
  const lastArg = stripLeadingUnmatchedQuote(getLastArg(line));
  if (looksLikeRemoteTarget(lastArg)) return [];
  const commandName = getCommandName(line);
  const isDirectoryOnlyCommand = DIRECTORY_ONLY_COMMANDS.has(commandName);
  const isFileAwareCommand = FILE_AWARE_COMMANDS.has(commandName);

  let dir = '';
  let partial = '';
  let sep = inferSeparator(cwd);

  if (hasPathSeparator(lastArg)) {
    const split = splitPath(lastArg);
    if (!split) return [];
    dir = split.dir;
    partial = split.partial;
    sep = split.sep;
  } else {
    // Bare-word CWD completion.
    if (!commandName) return [];
    if (!isDirectoryOnlyCommand && !isFileAwareCommand) return [];
    if (lastArg.startsWith('-')) return [];
    // For non-directory-only commands skip when there is no partial or we
    // don't have cwd context to list from.
    if (!isDirectoryOnlyCommand) {
      if (!cwd || !lastArg || lastArg.toLowerCase() === commandName) return [];
    }
    dir = '';
    partial = lastArg;
  }

  // Resolve against CWD when we have one; otherwise use the dir as typed.
  // For directory-only commands with no CWD fall back to '~' so that
  // `cd ` on an SSH session still lists the remote home directory.
  const resolvedDir = cwd ? resolveDir(dir, cwd, sep) : dir;
  const apiPath = stripTrailingSep(resolvedDir) || (isDirectoryOnlyCommand ? '~' : sep);
  const cacheKey = `${connectionId}::${apiPath}`;

  let entries: FsEntry[];
  try {
    const now = Date.now();
    const cached = fsListCache.get(cacheKey);
    if (cached && now - cached.at <= FS_LIST_CACHE_TTL_MS) {
      entries = cached.entries;
    } else {
      entries = await invokeFsList(connectionId, apiPath, timeoutMs);
      fsListCache.set(cacheKey, { at: now, entries });
      if (fsListCache.size > 128) {
        // First pass: evict entries that have already expired past their TTL.
        for (const [key, cached2] of fsListCache.entries()) {
          if (now - cached2.at > FS_LIST_CACHE_TTL_MS) {
            fsListCache.delete(key);
          }
        }
        // Second pass: if still over limit, remove oldest insertion-order keys.
        if (fsListCache.size > 128) {
          let removeCount = fsListCache.size - 112;
          for (const key of fsListCache.keys()) {
            fsListCache.delete(key);
            if (--removeCount <= 0) break;
          }
        }
      }
    }
  } catch {
    const fallback = fsListCache.get(cacheKey);
    if (fallback?.entries?.length) {
      entries = fallback.entries;
    } else {
      return [];
    }
  }

  if (!entries?.length) return [];

  // Filter: name must start with the partial the user already typed.
  // Case-insensitive fallback mirrors fish tier-2 behaviour.
  const partialLower = partial.toLowerCase();

  let matches = entries.filter(
    (e) =>
      e.name !== '.' &&
      e.name !== '..' &&
      e.name !== partial && // skip exact match (nothing left to complete)
      (partial === '' || e.name.toLowerCase().startsWith(partialLower)),
  );

  if (!matches.length) return [];

  if (isDirectoryOnlyCommand) {
    // Note: symlink target type is not available from fs_list, so symlinks are
    // treated as potentially navigable entries for directory-only commands.
    matches = matches.filter((e) => e.type === 'directory' || e.type === 'symlink');
    if (!matches.length) return [];
  }

  // Sort: directories first (most useful for `cd`), then alphabetically.
  // Mirrors fish's tilde-penalty: skip names ending with `~` (editor autosaves).
  matches = matches
    .filter((e) => !e.name.endsWith('~'))
    .sort((a, b) => {
      const aExactCase = partial !== '' && a.name.startsWith(partial);
      const bExactCase = partial !== '' && b.name.startsWith(partial);
      if (aExactCase && !bExactCase) return -1;
      if (bExactCase && !aExactCase) return 1;

      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (b.type === 'directory' && a.type !== 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

  const suggestions: string[] = [];
  for (const m of matches.slice(0, Math.max(1, limit))) {
    const nameSuffix = m.name.slice(partial.length);
    const trailingSep = (m.type === 'directory' || m.type === 'symlink') ? sep : '';
    suggestions.push(nameSuffix + trailingSep);
  }
  return suggestions;
}

/** Normalize the backend's short type codes to the values expected by this module. */
function normalizeEntryType(t: string): string {
  if (t === 'd' || t === 'directory') return 'directory';
  if (t === 'l' || t === 'symlink') return 'symlink';
  return 'file';
}

async function invokeFsList(connectionId: string, path: string, timeoutMs: number): Promise<FsEntry[]> {
  const request = window.ipcRenderer.invoke('fs_list', { connectionId, path }) as Promise<Array<{ name: string; type: string }>>;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('fs_list timeout'));
    }, Math.max(50, timeoutMs));
  });
  try {
    const raw = await Promise.race([request, timeout]);
    return raw.map((e) => ({ name: e.name, type: normalizeEntryType(e.type) }));
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }
}
