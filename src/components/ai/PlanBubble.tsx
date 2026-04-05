import { ClipboardList, CheckCircle2, XCircle, ShieldAlert, Terminal } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { PlanMessage } from '../../ai/types/agent';

interface PlanBubbleProps {
  message: PlanMessage;
  onApprove: () => void;
  onReject: () => void;
}

const RISK_STYLES: Record<string, string> = {
  low:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  medium: 'bg-amber-500/10   text-amber-400   border-amber-500/20',
  high:   'bg-red-500/10     text-red-400     border-red-500/20',
};

export function PlanBubble({ message, onApprove, onReject }: PlanBubbleProps) {
  const { summary, steps, response } = message;
  const isPending = response === null;

  return (
    <div className={cn(
      'rounded-xl border overflow-hidden transition-opacity',
      isPending ? 'border-app-accent/30 bg-app-accent/5' : 'border-app-border/20 bg-app-surface/10',
      !isPending && 'opacity-70',
    )}>
      {/* Header */}
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <ClipboardList size={14} className={cn('shrink-0 mt-0.5', isPending ? 'text-app-accent' : 'text-app-muted')} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <p className="text-[11px] font-bold tracking-widest uppercase text-app-muted/60">
              Proposed Plan
            </p>
            <span className="text-[10px] text-app-muted/40">
              {steps.length} step{steps.length !== 1 ? 's' : ''}
              {steps.some(s => s.requiresApproval) && ' · requires confirmation'}
            </span>
          </div>
          <p className="text-[12px] text-app-text/80 leading-relaxed">{summary}</p>
        </div>

        {/* Answered badge */}
        {!isPending && (
          <div className={cn('flex items-center gap-1 text-[10px] font-medium shrink-0', response === 'approved' ? 'text-emerald-400' : 'text-app-muted/60')}>
            {response === 'approved'
              ? <><CheckCircle2 size={12} /> Approved</>
              : <><XCircle size={12} /> Rejected</>}
          </div>
        )}
      </div>

      {/* Step list */}
      <div className="border-t border-app-border/20 divide-y divide-app-border/10">
        {steps.map((step, i) => (
          <div key={step.id} className="px-3 py-2 flex items-start gap-2.5">
            <span className="text-[10px] text-app-muted/40 font-mono mt-0.5 w-4 shrink-0">{i + 1}</span>
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12px] text-app-text/85 font-medium">{step.title}</span>
                <span className={cn('text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border', RISK_STYLES[step.risk] ?? RISK_STYLES.low)}>
                  {step.risk}
                </span>
                {step.requiresApproval && (
                  <ShieldAlert size={11} className="text-amber-400/80 shrink-0" aria-label="Requires approval" role="img" />
                )}
              </div>
              <p className="text-[11px] text-app-muted/60 leading-relaxed">{step.reason}</p>
              {step.command && (
                <div className="flex items-center gap-1.5 mt-1">
                  <Terminal size={10} className="text-app-muted/40 shrink-0" />
                  <code className="text-[10px] font-mono text-app-accent/70 truncate">{step.command}</code>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      {isPending && (
        <div className="border-t border-app-border/20 px-3 py-2 flex gap-2">
          <button
            type="button"
            onClick={onApprove}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[12px] font-medium transition-colors"
          >
            <CheckCircle2 size={13} />
            Approve & Execute
          </button>
          <button
            type="button"
            onClick={onReject}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-app-surface/40 hover:bg-app-surface/70 text-app-muted/70 text-[12px] font-medium transition-colors"
          >
            <XCircle size={13} />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
