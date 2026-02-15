import type { LucideIcon } from 'lucide-react';
import React from 'react';
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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = React.useState({ width: 0, height: 0 });

  React.useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // Only update if actually changed to avoid loop
        setDimensions(prev => (prev.width === width && prev.height === height) ? prev : { width, height });
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div className={cn(
      'bg-app-panel border border-[var(--color-app-border)] rounded-2xl p-5 flex flex-col h-40 shadow-sm transition-all hover:border-[var(--color-app-accent)]/50 hover:shadow-md group relative overflow-hidden',
      // Vibrancy handled by parent or global class usually, but let's add specific glass utility if needed
      'backdrop-blur-xl bg-opacity-60', // Default glass-ish
      className
    )}
    >
      <div className="flex items-start justify-between mb-4 relative z-10">
        <div>
          <h3 className="text-xs font-medium text-[var(--color-app-muted)] uppercase tracking-wider flex items-center gap-2 mb-1">
            <Icon size={14} className={cn("text-[var(--color-app-muted)]/70 group-hover:text-[var(--color-app-accent)] transition-colors")} />
            {title}
          </h3>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-[var(--color-app-text)] tracking-tight">{value}</span>
            <span className="text-xs text-[var(--color-app-muted)]/70">{subtext}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 -mx-2 -mb-2 relative z-0 opacity-80 group-hover:opacity-100 transition-opacity min-h-[100px]">
        {/* Force chart to only mount when we have non-zero dimensions */}
        <div ref={containerRef} className="absolute inset-0">
          {dimensions.width > 0 && dimensions.height > 0 && (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <defs>
                  <linearGradient id={`gradient-${title}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="basis" // Smoother curve
                  dataKey="value"
                  stroke={color}
                  strokeWidth={2}
                  fillOpacity={1}
                  fill={`url(#gradient-${title})`}
                  isAnimationActive={true}
                  animationDuration={1500}
                  animationEasing="ease-in-out"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
