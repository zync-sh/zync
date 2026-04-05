/**
 * CheckpointBlock — rendered when the agent emits an `ask_user` tool call
 * or a safety-net approval prompt.
 */

import { HelpCircle, Play, Square, CheckCircle2, XCircle, ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { CheckpointMessage } from '../../ai/types/agent';

interface CheckpointBlockProps {
  message: CheckpointMessage;
  onContinue: () => void;
  onStop: () => void;
  /** Only provided when message.command is set — adds this command to the session whitelist. */
  onAlwaysAllow?: () => void;
}

export function CheckpointBlock({ message, onContinue, onStop, onAlwaysAllow }: CheckpointBlockProps) {
  const { question, response } = message;
  const answered = response !== null;

  return (
    <div
      className={cn(
        'rounded-xl border p-3 space-y-2.5',
        answered
          ? 'border-app-border/20 bg-app-surface/10 opacity-60'
          : 'border-yellow-500/20 bg-yellow-500/4',
      )}
    >
      {/* Question — renders backtick-wrapped segments as inline code */}
      <div className="flex items-start gap-2">
        <HelpCircle
          size={12}
          className={cn('shrink-0 mt-px', answered ? 'text-app-muted/50' : 'text-yellow-400/70')}
        />
        <div className="text-[12px] text-app-text/80 leading-relaxed space-y-1.5">
          {question.split('\n').filter(line => line.trim() !== '').map((line, i) => {
            const parts = line.split(/(`[^`]+`)/g);
            return (
              <p key={i}>
                {parts.map((part, j) =>
                  part.startsWith('`') && part.endsWith('`') ? (
                    <code
                      key={j}
                      className="px-1.5 py-0.5 rounded bg-app-surface/60 border border-app-border/40 font-mono text-[11px] text-app-accent/90 break-all"
                    >
                      {part.slice(1, -1)}
                    </code>
                  ) : (
                    part
                  )
                )}
              </p>
            );
          })}
        </div>
      </div>

      {/* Buttons or answered badge */}
      {answered ? (
        <div className="flex items-center gap-1.5 text-[10px] font-medium pl-5 text-app-muted/50">
          {response === 'continue' ? (
            <>
              <CheckCircle2 size={10} className="text-emerald-500/60" />
              <span>Allowed</span>
            </>
          ) : (
            <>
              <XCircle size={10} className="text-red-500/60" />
              <span>Stopped</span>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 pl-5 flex-wrap">
          <button
            type="button"
            onClick={onContinue}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium text-emerald-400 bg-emerald-500/8 border border-emerald-500/20 hover:bg-emerald-500/15 transition-colors"
          >
            <Play size={8} fill="currentColor" />
            Allow
          </button>
          {message.command && onAlwaysAllow && (
            <button
              type="button"
              onClick={onAlwaysAllow}
              title="Allow this exact command for the rest of this session without asking again"
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium text-app-accent/80 bg-app-accent/8 border border-app-accent/20 hover:bg-app-accent/15 transition-colors"
            >
              <ShieldCheck size={8} />
              Always Allow
            </button>
          )}
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium text-red-400/80 bg-red-500/8 border border-red-500/20 hover:bg-red-500/15 transition-colors"
          >
            <Square size={8} fill="currentColor" />
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
