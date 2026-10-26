export type FilePathSeparator = '/' | '\\';

/** Fully rooted POSIX, drive or UNC paths; home tokens and drive-relative paths are unresolved. */
export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

export function filePathSeparator(path: string): FilePathSeparator {
  if (path.startsWith('/')) return '/';
  if (/^[A-Za-z]:/.test(path) || path.startsWith('\\\\')) return '\\';
  if (path.includes('\\')) return '\\';
  return '/';
}

export function filePathRoot(path: string): string {
  if (path.startsWith('\\\\')) {
    const parts = path.replace(/^[\\/]+/, '').split(/[\\/]/).filter(Boolean);
    if (parts.length >= 2) return `\\\\${parts[0]}\\${parts[1]}\\`;
    if (parts.length === 1) return `\\\\${parts[0]}\\`;
    return '\\\\';
  }
  if (filePathSeparator(path) === '\\') {
    const drive = path.trim().slice(0, 2);
    if (/^[A-Za-z]:/.test(path.trim())) return `${drive}\\`;
    return path.split(/[\\/]/).filter(Boolean)[0] ?? '';
  }
  return '/';
}

export function parentFilePath(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '') || path;
  if (!trimmed || trimmed === '/') return null;
  const sep = filePathSeparator(path);
  if (sep === '\\') {
    const root = filePathRoot(path);
    const rootTrim = root.replace(/[\\/]+$/, '');
    if (trimmed === root || trimmed === rootTrim) return null;
    const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (idx <= 0) return root || null;
    const parent = trimmed.slice(0, idx);
    if (parent === rootTrim) return root;
    return parent;
  }
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

export function normalizeFilePath(path: string): string {
  if (!path) return path;
  const sep = filePathSeparator(path);
  if (sep === '/') {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
  }
  const trimmed = path.replace(/[\\/]+$/, '');
  const root = filePathRoot(path);
  if (trimmed === root.replace(/[\\/]+$/, '')) return root;
  return trimmed;
}

export function isFilePathEqual(a: string, b: string): boolean {
  return normalizeFilePath(a) === normalizeFilePath(b);
}

export function isFilePathUnder(path: string, ancestor: string): boolean {
  if (!ancestor) return false;
  const p = normalizeFilePath(path);
  const a = normalizeFilePath(ancestor);
  if (isFilePathEqual(p, a)) return true;
  if (a === '/') return p.startsWith('/');
  const sep = filePathSeparator(a);
  const prefix = a.endsWith('\\') ? a : `${a}${sep}`;
  return p.startsWith(prefix);
}

export type FilePathCrumbKind = 'os' | 'home' | 'drive' | 'folder';

export function filePathDisplayCrumbs(
  path: string,
  options: { homePath?: string; osName?: string } = {},
): Array<{ label: string; path: string; kind: FilePathCrumbKind }> {
  const home = options.homePath ? normalizeFilePath(options.homePath) : '';
  if (home && isFilePathUnder(path, home)) {
    const crumbs: Array<{ label: string; path: string; kind: FilePathCrumbKind }> = [
      { label: 'Home', path: home, kind: 'home' },
    ];
    const rest = filePathCrumbs(path);
    const skip = filePathCrumbs(home).length;
    for (let i = skip; i < rest.length; i++) {
      crumbs.push({ label: rest[i].label, path: rest[i].path, kind: 'folder' });
    }
    return crumbs;
  }
  const raw = filePathCrumbs(path);
  if (raw.length === 0) return [];
  if (filePathSeparator(path) === '/') {
    return raw.map((crumb, index) => (
      index === 0
        ? { label: options.osName || 'Operating System', path: '/', kind: 'os' as const }
        : { label: crumb.label, path: crumb.path, kind: 'folder' as const }
    ));
  }
  return raw.map((crumb, index) => (
    index === 0
      ? { label: crumb.label, path: crumb.path, kind: 'drive' as const }
      : { label: crumb.label, path: crumb.path, kind: 'folder' as const }
  ));
}

/** Drive / share roots (`C:\`, `/`, `\\server\share\`, `\\wsl.localhost\Ubuntu\`) are not Home. */
export function isFilePathDriveRoot(path: string): boolean {
  const value = normalizeFilePath(path);
  if (!value || value === '~') return true;
  return isFilePathEqual(value, filePathRoot(path));
}

export function inferHomePath(explicit: string | undefined, currentPath: string): string {
  const given = (explicit || '').trim();
  if (given && given !== '/' && given !== '~' && !isFilePathDriveRoot(given)) {
    return normalizeFilePath(given);
  }
  const win = currentPath.match(/^([A-Za-z]:\\Users\\[^\\/]+)/);
  if (win) return win[1];
  const mac = currentPath.match(/^(\/Users\/[^/]+)/);
  if (mac) return mac[1];
  const posix = currentPath.match(/^(\/home\/[^/]+)/);
  if (posix) return posix[1];
  return '';
}

export function filePathLeafLabel(path: string, options?: { homePath?: string; osName?: string }): string {
  const crumbs = filePathDisplayCrumbs(path, options);
  return crumbs[crumbs.length - 1]?.label || path;
}

export function filePathCrumbs(path: string): Array<{ label: string; path: string }> {
  if (path.startsWith('\\\\')) {
    const rest = path.replace(/^[\\/]+/, '').split(/[\\/]/).filter(Boolean);
    if (rest.length === 0) return [{ label: '\\\\', path: '\\\\' }];
    const crumbs: Array<{ label: string; path: string }> = [];
    let acc = `\\\\${rest[0]}`;
    crumbs.push({ label: rest[0], path: acc });
    for (let i = 1; i < rest.length; i++) {
      acc += `\\${rest[i]}`;
      crumbs.push({ label: rest[i], path: acc });
    }
    return crumbs;
  }
  const sep = filePathSeparator(path);
  const parts = (sep === '/' ? path.split('/') : path.split(/[/\\]/)).filter((part) => part !== '');
  if (sep === '/') {
    const crumbs = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  if (parts.length === 0) return [];
  const crumbs: Array<{ label: string; path: string }> = [];
  parts.forEach((part, index) => {
    if (index === 0) {
      const drive = part.endsWith(':') ? `${part}\\` : part;
      crumbs.push({ label: part, path: drive });
      return;
    }
    const prev = crumbs[crumbs.length - 1].path;
    const next = prev.endsWith('\\') ? `${prev}${part}` : `${prev}\\${part}`;
    crumbs.push({ label: part, path: next });
  });
  return crumbs;
}
