import type { LucideIcon } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { cn } from '../../lib/utils';

interface ResourceWidgetProps {
  title: string;
  value: string;
  subtext: string;
  icon: LucideIcon;
  data: { time: string; value: number }[];
  color?: string;
  className?: string;
}

export function ResourceWidget({
  title,
  value,
  subtext,
  icon: Icon,
  data,
  color = '#3b82f6',
  className,
}: ResourceWidgetProps) {
  return (
    <div className={cn('bg-app-panel border border-app-border rounded-lg p-4 flex flex-col h-40', className)}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-app-muted flex items-center gap-2">
            <Icon size={14} className="text-app-muted" />
            {title}
          </h3>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-[var(--color-app-text)]">{value}</span>
            <span className="text-xs text-app-muted">{subtext}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 -mx-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id={`gradient-${title}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="value"
              stroke={color}
              fillOpacity={1}
              fill={`url(#gradient-${title})`}
              strokeWidth={2}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
