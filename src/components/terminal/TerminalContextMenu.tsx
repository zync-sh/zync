import { memo, type RefObject } from 'react';
import { Copy, Clipboard as ClipboardIcon, Trash2, Scissors } from 'lucide-react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { ContextMenu } from '../ui/ContextMenu';
import type { GhostPopupState } from '../../lib/ghostSuggestions/types';
import type { AppSettings } from '../../store/settingsSlice';
import { terminalCache } from '../../lib/terminal';

export interface TerminalContextMenuProps {
  position: { x: number; y: number };
  sessionId: string;
  ghostSettings: AppSettings['ghostSuggestions'];
  ghostPopup: GhostPopupState;
  ghostSuggestion: string;
  termRef: RefObject<XTerm | null>;
  truncateLabel: (label: string, max?: number) => string;
  onAcceptGhostSuffix: (suffix: string) => void;
  onClose: () => void;
}

export const TerminalContextMenu = memo(function TerminalContextMenu({
  position,
  sessionId,
  ghostSettings,
  ghostPopup,
  ghostSuggestion,
  termRef,
  truncateLabel,
  onAcceptGhostSuffix,
  onClose,
}: TerminalContextMenuProps) {
  const ghostItems = ghostSettings.contextMenuEnabled && ghostPopup.items.length
    ? [
      {
        label: 'Suggestions',
        children: ghostPopup.items.slice(0, 8).map((suffix) => ({
          label: truncateLabel(`${ghostPopup.anchorLine}${suffix}`),
          action: () => onAcceptGhostSuffix(suffix),
        })),
      },
      { separator: true as const },
    ]
    : ghostSettings.contextMenuEnabled && ghostSuggestion
      ? [
        {
          label: truncateLabel(
            `Accept suggestion: ${ghostPopup.anchorLine || (terminalCache.get(sessionId)?.ghostTracker?.getLineBuffer() ?? '')}${ghostSuggestion}`,
          ),
          action: () => onAcceptGhostSuffix(ghostSuggestion),
        },
        { separator: true as const },
      ]
      : [];

  return (
    <ContextMenu
      x={position.x}
      y={position.y}
      onClose={onClose}
      items={[
        ...ghostItems,
        {
          label: 'Copy',
          icon: <Copy className="w-4 h-4" />,
          action: () => {
            const selection = termRef.current?.getSelection();
            if (selection) navigator.clipboard.writeText(selection);
          },
          disabled: !termRef.current?.hasSelection(),
        },
        {
          label: 'Paste',
          icon: <ClipboardIcon className="w-4 h-4" />,
          action: async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) termRef.current?.paste(text);
            } catch (err) {
              console.error('Failed to paste', err);
            }
          },
        },
        {
          label: 'Select All',
          icon: <Scissors className="w-4 h-4" />,
          action: () => termRef.current?.selectAll(),
        },
        {
          label: 'Clear Terminal',
          icon: <Trash2 className="w-4 h-4" />,
          variant: 'danger',
          action: () => termRef.current?.clear(),
        },
      ]}
    />
  );
});