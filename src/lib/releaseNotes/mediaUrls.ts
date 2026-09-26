const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v']);
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'bmp',
  'ico',
  'apng',
]);

const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'objects.githubusercontent.com',
  'media.githubusercontent.com',
  'camo.githubusercontent.com',
  'img.shields.io',
]);

export type MediaKind = 'image' | 'video' | 'unknown';

function parseHttpUrl(raw: string | undefined | null): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.githubusercontent.com');
}

function pathExtension(pathname: string): string {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return '';
  return last.slice(dot + 1).toLowerCase();
}

function extensionOf(raw: string): string {
  const path = raw.trim().split('?')[0].split('#')[0];
  return pathExtension(path);
}

function hasMediaExtension(raw: string): boolean {
  const ext = extensionOf(raw);
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

export function hasPathTraversal(raw: string): boolean {
  if (raw.includes('\0')) return true;
  const candidates = [raw];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch {
    /* malformed percent-encoding */
  }
  if (/^file:/i.test(raw)) {
    try {
      candidates.push(decodeURIComponent(new URL(raw).pathname));
    } catch {
      /* ignore */
    }
  }
  return candidates.some((path) => {
    const normalized = path.replace(/\\/g, '/');
    return normalized.split('/').includes('..') || /%2e%2e/i.test(normalized);
  });
}

export function isAllowedMediaUrl(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const url = parseHttpUrl(raw);
  if (!url) return false;
  if (hostAllowed(url.hostname)) return true;
  // Release notes often hotlink CDNs (R2, etc.). Require a media extension.
  return hasMediaExtension(raw);
}

export function isGithubAttachmentUrl(raw: string | undefined | null): boolean {
  const url = parseHttpUrl(raw);
  if (!url || !hostAllowed(url.hostname)) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    return url.pathname.startsWith('/user-attachments/assets/');
  }
  return host === 'private-user-images.githubusercontent.com';
}

export function classifyMediaUrl(raw: string | undefined | null): MediaKind {
  if (!isAllowedMediaUrl(raw) || !raw) return 'unknown';
  const ext = extensionOf(raw);
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'unknown';
}

export function coerceHtmlBoolean(value: unknown): boolean {
  if (value === true || value === '' || value === 'true' || value === 'loop') return true;
  if (typeof value === 'string' && value.toLowerCase() === 'loop') return true;
  return false;
}

function unwrapAngle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1).trim();
  return trimmed;
}

export function shouldEmbedAsMedia(raw: string): boolean {
  const path = unwrapAngle(raw);
  if (!isAllowedMediaUrl(path) || hasPathTraversal(path)) return false;
  if (isGithubAttachmentUrl(path)) return true;
  const kind = classifyMediaUrl(path);
  return kind === 'image' || kind === 'video';
}

function mapOutsideFences(markdown: string, fn: (chunk: string) => string): string {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part) => (part.startsWith('```') || part.startsWith('~~~') ? part : fn(part)))
    .join('');
}

function toMarkdownImageDest(path: string): string {
  if (/[()\s]/.test(path)) return `<${path}>`;
  return path;
}

/**
 * GitHub release notes often contain bare attachment or CDN media URLs.
 * Rewrite those to image markdown while leaving code fences untouched.
 */
export function rewriteMarkdownMediaUrls(markdown: string): string {
  return mapOutsideFences(markdown, (chunk) => {
    return chunk.replace(/^[ \t]*\S[^\n]*$/gm, (line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('![') || /^<\/?[a-zA-Z]/.test(trimmed)) return line;
      const linked = trimmed.match(/^\[([^\]]*)\]\(\s*<?([^>\n)]+)>?\s*\)$/);
      if (linked) {
        const dest = linked[2].trim();
        const label = linked[1].trim();
        if (shouldEmbedAsMedia(dest) && (label === dest || label === '' || shouldEmbedAsMedia(label))) {
          const indent = line.match(/^[ \t]*/)?.[0] ?? '';
          return `${indent}![](${toMarkdownImageDest(dest)})`;
        }
        return line;
      }
      const candidate = unwrapAngle(trimmed);
      if (!shouldEmbedAsMedia(candidate)) return line;
      const indent = line.match(/^[ \t]*/)?.[0] ?? '';
      return `${indent}![](${toMarkdownImageDest(candidate)})`;
    });
  });
}
