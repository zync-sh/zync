import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { AlertOctagon, AlertTriangle, Check, Copy, Info, Lightbulb, Megaphone } from 'lucide-react';
import { KeyboardKey } from '../../ui/KeyboardKey';
import { matchAlertPrefix, stripAlertPrefixFromParts, type AlertKind } from '../../../lib/releaseNotes/alerts';
import { rewriteMarkdownMediaUrls } from '../../../lib/releaseNotes/mediaUrls';
import { getNodeText } from '../../../lib/releaseNotes/reactText';
import { RELEASE_NOTES_SANITIZE_SCHEMA } from '../../../lib/releaseNotes/sanitizeSchema';
import { releaseNotesUrlTransform } from '../../../lib/releaseNotes/urlTransform';
import { ReleaseNotesImage, ReleaseNotesVideo } from './ReleaseNotesMedia';

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS: NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, RELEASE_NOTES_SANITIZE_SCHEMA],
];

const ALERT_STYLES: Record<AlertKind, { label: string; className: string; icon: typeof Info }> = {
  note: {
    label: 'Note',
    icon: Info,
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  },
  tip: {
    label: 'Tip',
    icon: Lightbulb,
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  },
  important: {
    label: 'Important',
    icon: Megaphone,
    className: 'border-purple-500/30 bg-purple-500/10 text-purple-400',
  },
  warning: {
    label: 'Warning',
    icon: AlertTriangle,
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  },
  caution: {
    label: 'Caution',
    icon: AlertOctagon,
    className: 'border-red-500/30 bg-red-500/10 text-red-400',
  },
};

function AlertBox({ kind, children }: { kind: AlertKind; children: ReactNode }) {
  const meta = ALERT_STYLES[kind];
  const Icon = meta.icon;
  return (
    <aside
      className={`my-4 rounded-lg border px-3.5 py-3 ${meta.className}`}
      aria-label={meta.label}
    >
      <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold tracking-tight">
        <Icon size={14} />
        {meta.label}
      </div>
      <div className="text-sm leading-6 text-[var(--color-app-text)]/90 [&_p]:mb-2 [&_p:last-child]:mb-0">
        {children}
      </div>
    </aside>
  );
}

function CodeBlock({
  language,
  children,
  isLightTheme,
}: {
  language?: string;
  children: string;
  isLightTheme: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code to clipboard:', err);
    }
  };

  return (
    <div className="relative my-4 overflow-hidden rounded-lg border border-[var(--color-app-border)]/50">
      <div className="flex items-center justify-between border-b border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/70 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-app-muted)]">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 text-[10px] text-[var(--color-app-muted)] transition-colors hover:text-[var(--color-app-text)]"
        >
          {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={isLightTheme ? oneLight : oneDark}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          background: 'var(--color-app-panel)',
          fontSize: '13px',
          padding: '14px 16px',
        }}
        codeTagProps={{
          style: { fontFamily: 'var(--font-mono)' },
        }}
        showLineNumbers={children.split('\n').length > 4}
        lineNumberStyle={{ color: 'var(--color-app-muted)', minWidth: '2.5em', opacity: 0.6 }}
        wrapLongLines
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
}

function ReleaseNotesMarkdownImage({
  src,
  alt,
  title,
}: {
  src?: string | Blob;
  alt?: string;
  title?: string;
}) {
  return <ReleaseNotesImage src={typeof src === 'string' ? src : undefined} alt={alt} title={title} />;
}

function ReleaseNotesMarkdownVideo({
  src,
  title,
  loop,
  poster,
  children,
}: {
  src?: string | Blob;
  title?: string;
  loop?: unknown;
  poster?: string;
  children?: ReactNode;
}) {
  return (
    <ReleaseNotesVideo
      src={typeof src === 'string' ? src : undefined}
      title={title}
      loop={loop}
      poster={poster}
    >
      {children}
    </ReleaseNotesVideo>
  );
}

function isBareMediaParagraph(children: ReactNode): boolean {
  const items = Children.toArray(children).filter((child) => {
    if (typeof child === 'string') return child.trim() !== '';
    return true;
  });
  if (items.length !== 1 || !isValidElement(items[0])) return false;
  return items[0].type === ReleaseNotesMarkdownImage || items[0].type === ReleaseNotesMarkdownVideo;
}

export const ReleaseNotesMarkdown = memo(function ReleaseNotesMarkdown({
  markdown,
  isLightTheme,
  renderHeading,
}: {
  markdown: string;
  isLightTheme: boolean;
  renderHeading: (level: 1 | 2 | 3, children: ReactNode) => ReactNode;
}) {
  const prepared = useMemo(() => rewriteMarkdownMediaUrls(markdown), [markdown]);

  const components = useMemo((): Components => ({
    h1: ({ children }) => renderHeading(1, children),
    h2: ({ children }) => renderHeading(2, children),
    h3: ({ children }) => renderHeading(3, children),
    h4: ({ children }) => (
      <h4 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="mb-2 mt-3 text-sm font-medium text-[var(--color-app-muted)] first:mt-0">
        {children}
      </h6>
    ),
    img: ReleaseNotesMarkdownImage,
    video: ReleaseNotesMarkdownVideo,
    code({ className, children }) {
      const language = /language-([\w-]+)/.exec(className || '')?.[1];
      const codeContent = String(children).replace(/\n$/, '');
      const isBlock = Boolean(language) || codeContent.includes('\n');

      return isBlock ? (
        <CodeBlock language={language} isLightTheme={isLightTheme}>
          {codeContent}
        </CodeBlock>
      ) : (
        <code className="rounded border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--color-app-accent)]">
          {children}
        </code>
      );
    },
    pre: ({ children }) => <>{children}</>,
    p: ({ children }) =>
      isBareMediaParagraph(children) ? (
        <>{children}</>
      ) : (
        <p className="mb-3 leading-7">{children}</p>
      ),
    ul: ({ children, className }) => (
      <ul
        className={`mb-3 list-disc space-y-0.5 pl-5 ${className?.includes('contains-task-list') ? 'list-none pl-0' : ''}`}
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-3 list-decimal space-y-0.5 pl-5">{children}</ol>
    ),
    li: ({ children, className }) => (
      <li
        className={`leading-7 text-[var(--color-app-text)]/90 ${className?.includes('task-list-item') ? 'flex list-none items-start gap-2' : ''}`}
      >
        {children}
      </li>
    ),
    input: (props) =>
      props.type === 'checkbox' ? (
        <input
          type="checkbox"
          checked={Boolean(props.checked)}
          disabled
          readOnly
          className="mt-1.5 shrink-0 accent-[var(--color-app-accent)]"
        />
      ) : null,
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      const internal = href.startsWith('#');
      return (
        <a
          href={href}
          target={internal ? undefined : '_blank'}
          rel={internal ? undefined : 'noreferrer'}
          className="text-[var(--color-app-accent)] hover:underline"
        >
          {children}
        </a>
      );
    },
    blockquote: ({ children }) => {
      const items = Children.toArray(children);
      const first = items[0];
      const alert = matchAlertPrefix(getNodeText(first));
      if (alert) {
        const rest = [...items];
        if (isValidElement<{ children?: ReactNode }>(first)) {
          const kept = stripAlertPrefixFromParts(Children.toArray(first.props.children));
          if (kept.length === 0) {
            rest.shift();
          } else {
            rest[0] = cloneElement(first, undefined, ...(kept as ReactNode[]));
          }
        } else {
          rest.shift();
        }
        return <AlertBox kind={alert.kind}>{rest}</AlertBox>;
      }
      return (
        <blockquote className="my-3 border-l-2 border-[var(--color-app-accent)]/50 pl-4 italic text-[var(--color-app-muted)]">
          {children}
        </blockquote>
      );
    },
    hr: () => <hr className="my-5 border-[var(--color-app-border)]/40" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-lg border border-[var(--color-app-border)]/50">
        <table className="w-full text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)] px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-app-muted)]">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-[var(--color-app-border)]/30 px-4 py-2.5 text-[var(--color-app-text)]/90">
        {children}
      </td>
    ),
    del: ({ children }) => (
      <del className="text-[var(--color-app-muted)] line-through">{children}</del>
    ),
    kbd: ({ children }) => {
      const label = getNodeText(children).trim();
      return label ? <KeyboardKey>{label}</KeyboardKey> : null;
    },
    mark: ({ children }) => (
      <mark className="rounded-sm bg-[var(--color-app-accent)]/20 px-0.5 text-[var(--color-app-text)]">
        {children}
      </mark>
    ),
    details: ({ children, open }) => (
      <details
        open={Boolean(open)}
        className="my-3 overflow-hidden rounded-lg border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]/40 [&>:not(summary)]:px-3 [&>:not(summary)]:pb-3"
      >
        {children}
      </details>
    ),
    summary: ({ children }) => (
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-[var(--color-app-text)]">
        {children}
      </summary>
    ),
    section: ({ children, className }) => (
      <section
        className={`mt-8 border-t border-[var(--color-app-border)]/40 pt-4 text-sm ${className ?? ''}`}
      >
        {children}
      </section>
    ),
  }), [isLightTheme, renderHeading]);

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={releaseNotesUrlTransform}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
    >
      {prepared}
    </ReactMarkdown>
  );
});
