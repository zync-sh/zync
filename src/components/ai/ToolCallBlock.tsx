/**
 * ToolCallBlock — renders one tool call inside the conversation thread.
 *
 * Shows:
 *   • Header: tool icon + name + key input params + status badge
 *   • Collapsible stdout/stderr output (pre block)
 *   • Diff view for write_file calls (before/after side-by-side)
 */

import { useState } from 'react';
import {
  Terminal,
  FileText,
  FolderOpen,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  FileDiff,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ToolCallMessage } from '../../ai/types/agent';

// ── Tool icon map ──────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  run_command: Terminal,
  read_file: FileText,
  write_file: FileDiff,
  list_files: FolderOpen,
  ask_user: HelpCircle,
};

function ToolIcon({ name, size = 12 }: { name: string; size?: number }) {
  const Icon = TOOL_ICONS[name] ?? Terminal;
  return <Icon size={size} />;
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ToolCallMessage['status'] }) {
  if (status === 'running') {
    return <Loader2 size={12} className="text-app-accent animate-spin" />;
  }
  if (status === 'done') {
    return <CheckCircle2 size={12} className="text-emerald-400" />;
  }
  return <XCircle size={12} className="text-red-400" />;
}

// ── Input summary ──────────────────────────────────────────────────────────────

function inputSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'run_command':
      return String(input.command ?? '');
    case 'read_file':
    case 'write_file':
      return String(input.path ?? '');
    case 'list_files':
      return String(input.path ?? '.');
    default:
      return Object.values(input)
        .slice(0, 2)
        .map((v) =>
          v === null || v === undefined ? ''
          : typeof v === 'object' ? JSON.stringify(v).slice(0, 60)
          : String(v),
        )
        .filter(Boolean)
        .join(', ');
  }
}

// ── Diff view ──────────────────────────────────────────────────────────────────

function DiffView({ before, after, path }: { before: string; after: string; path: string }) {
  return (
    <div className="mt-2 rounded-lg border border-app-border/30 overflow-hidden text-[11px] font-mono">
      <div className="px-3 py-1.5 bg-app-surface/60 border-b border-app-border/20 text-app-muted flex items-center gap-1.5">
        <FileDiff size={10} />
        <span className="truncate">{path}</span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-app-border/20 max-h-48 overflow-y-auto">
        <div className="bg-red-500/5 p-2 overflow-x-auto">
          <pre className="text-red-300/80 whitespace-pre-wrap break-words leading-relaxed">{before || '(empty)'}</pre>
        </div>
        <div className="bg-emerald-500/5 p-2 overflow-x-auto">
          <pre className="text-emerald-300/80 whitespace-pre-wrap break-words leading-relaxed">{after || '(empty)'}</pre>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface ToolCallBlockProps {
  message: ToolCallMessage;
}

export function ToolCallBlock({ message }: ToolCallBlockProps) {
  const { toolName, input, output, diff, status } = message;
  const [expanded, setExpanded] = useState(status === 'running');
  const summary = inputSummary(toolName, input);
  const hasOutput = (output ?? '').length > 0;
  const hasDiff = diff != null;

  return (
    <div
      className={cn(
        'rounded-xl border overflow-hidden transition-colors',
        status === 'error'
          ? 'border-red-500/20 bg-red-500/5'
          : status === 'running'
            ? 'border-app-accent/20 bg-app-accent/5'
            : 'border-app-border/30 bg-app-surface/20',
      )}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03] transition-colors"
      >
        {/* Collapse chevron */}
        <span className="text-app-muted/50 shrink-0">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>

        {/* Tool icon + name */}
        <span
          className={cn(
            'shrink-0',
            status === 'error'
              ? 'text-red-400'
              : status === 'running'
                ? 'text-app-accent'
                : 'text-app-muted',
          )}
        >
          <ToolIcon name={toolName} size={12} />
        </span>
        <span className="text-[11px] font-mono font-medium text-app-text/80 shrink-0">
          {toolName}
        </span>

        {/* Input summary */}
        {summary && (
          <span className="text-[11px] font-mono text-app-muted/60 truncate flex-1 min-w-0">
            {summary}
          </span>
        )}

        {/* Status */}
        <span className="shrink-0 ml-auto">
          <StatusBadge status={status} />
        </span>
      </button>

      {/* Body */}
      {expanded && (hasOutput || hasDiff) && (
        <div className="px-3 pb-3 space-y-2">
          {hasOutput && (
            <pre
              className={cn(
                'text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words',
                'max-h-52 overflow-y-auto',
                'p-2 rounded-lg bg-black/20',
                status === 'error' ? 'text-red-300/80' : 'text-app-text/70',
              )}
            >
              {output}
            </pre>
          )}
          {hasDiff && (
            <DiffView before={diff.before} after={diff.after} path={diff.path} />
          )}
        </div>
      )}
    </div>
  );
}
