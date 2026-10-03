import { MessageSquare } from 'lucide-react';
import { Tooltip } from '../../components/ui/Tooltip';
import { feedbackInboxEnabled, INBOX_OPEN_EVENT } from './client';
import { useInboxUnreadCount } from './status';

/** Persistent entry point; the inbox coordinator remains the sole data owner. */
export function StatusBarInboxIndicator() {
  const unread = useInboxUnreadCount((state) => state.unread);
  if (!feedbackInboxEnabled) return null;

  const label = unread > 0
    ? `Open inbox, ${unread} unread ${unread === 1 ? 'message' : 'messages'}`
    : 'Open inbox';

  return (
    <Tooltip content={label} position="top">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(INBOX_OPEN_EVENT))}
        aria-label={label}
        className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-transparent text-app-muted transition-colors hover:border-app-border/40 hover:bg-app-surface hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60"
      >
        <MessageSquare size={13} aria-hidden="true" />
        {unread > 0 && (
          <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-4 rounded-full bg-app-accent px-1 text-center text-[10px] font-semibold leading-4 text-app-bg">
            {unread}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
