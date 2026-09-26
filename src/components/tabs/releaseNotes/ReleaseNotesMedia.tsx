import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  classifyMediaUrl,
  coerceHtmlBoolean,
  isAllowedMediaUrl,
  isGithubAttachmentUrl,
} from '../../../lib/releaseNotes/mediaUrls';

function firstSourceSrc(children: ReactNode): string | undefined {
  if (!Array.isArray(children) && !children) return undefined;
  const items = Array.isArray(children) ? children : [children];
  for (const child of items) {
    if (child && typeof child === 'object' && 'props' in child) {
      const src = (child as { props?: { src?: string } }).props?.src;
      if (src) return src;
    }
  }
  return undefined;
}

export function ReleaseNotesVideo({
  src,
  title,
  loop,
  poster,
  children,
}: {
  src?: string;
  title?: string;
  loop?: unknown;
  poster?: string;
  children?: ReactNode;
}) {
  const resolved = src || firstSourceSrc(children);
  if (!resolved || !isAllowedMediaUrl(resolved)) {
    return (
      <p className="my-4 text-sm italic text-[var(--color-app-muted)]">
        Video omitted (unsupported source).
      </p>
    );
  }

  const caption = title?.trim();
  const displaySrc = resolved;
  const displayPoster = poster && isAllowedMediaUrl(poster) ? poster : undefined;

  return (
    <figure className="my-5">
      <video
        src={displaySrc}
        title={caption || undefined}
        poster={displayPoster}
        controls
        playsInline
        preload="metadata"
        loop={coerceHtmlBoolean(loop)}
        className="max-h-[28rem] w-full overflow-hidden rounded-lg border border-[var(--color-app-border)]/60 bg-black/40"
      >
        <a href={resolved} target="_blank" rel="noreferrer" className="text-[var(--color-app-accent)]">
          Open video
        </a>
      </video>
      {caption ? (
        <figcaption className="mt-2 text-center text-xs leading-5 text-[var(--color-app-muted)]">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image preview'}
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-md p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Close image preview"
      >
        <X size={18} />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  );
}

export function ReleaseNotesImage({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const classifiedVideo =
    classifyMediaUrl(src) === 'video' || title === 'video' || Boolean(title?.startsWith('zync-video'));
  const [mediaSrc, setMediaSrc] = useState(src);
  const [failed, setFailed] = useState(false);
  const [asVideo, setAsVideo] = useState(classifiedVideo);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (src !== mediaSrc) {
    setMediaSrc(src);
    setFailed(false);
    setAsVideo(classifiedVideo);
    setOpen(false);
  }

  if (!src || !isAllowedMediaUrl(src)) {
    return alt ? <span className="italic text-[var(--color-app-muted)]">{alt}</span> : null;
  }

  if (asVideo) {
    return <ReleaseNotesVideo src={src} title={alt || title} loop={title?.includes('loop')} />;
  }

  if (failed) {
    if (isGithubAttachmentUrl(src) || classifyMediaUrl(src) === 'unknown') {
      return <ReleaseNotesVideo src={src} title={alt || title} />;
    }
    return (
      <p className="my-4 text-sm italic text-[var(--color-app-muted)]">
        Couldn’t load image{alt ? `: ${alt}` : ''}.
      </p>
    );
  }

  const caption = (alt || '').trim();
  const displaySrc = src;

  return (
    <figure className="my-5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block max-w-full cursor-zoom-in border-0 bg-transparent p-0 text-left"
      >
        <img
          src={displaySrc}
          alt={caption}
          title={title}
          loading="lazy"
          onError={() => {
            if (isGithubAttachmentUrl(src) || classifyMediaUrl(src) === 'unknown') {
              setAsVideo(true);
              return;
            }
            setFailed(true);
          }}
          className="max-h-[28rem] w-auto max-w-full rounded-lg border border-[var(--color-app-border)]/60 object-contain"
        />
      </button>
      {caption ? (
        <figcaption className="mt-2 text-center text-xs leading-5 text-[var(--color-app-muted)]">
          {caption}
        </figcaption>
      ) : null}
      {open ? <Lightbox src={displaySrc} alt={caption} onClose={close} /> : null}
    </figure>
  );
}
