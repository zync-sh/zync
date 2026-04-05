/**
 * `useModal` — open and close any registered modal from anywhere in the app.
 *
 * @example
 * // Open:
 * const { open } = useModal()
 * open('addConnection')
 * open('addConnection', { defaultHost: '10.0.0.1' })
 *
 * // Close (usually handled by the modal itself via its onClose prop):
 * const { close } = useModal()
 * close('addConnection')
 *
 * // Check if a specific modal is currently open:
 * const { isOpen } = useModal()
 * if (isOpen('addConnection')) { ... }
 *
 * // Close everything (e.g. on route change):
 * const { closeAll } = useModal()
 * closeAll()
 */

import { useCallback } from 'react';
import { useModalStore } from '../lib/modalRegistry';

export function useModal() {
  const open     = useModalStore((s) => s.open);
  const close    = useModalStore((s) => s.close);
  const closeAll = useModalStore((s) => s.closeAll);
  const stack    = useModalStore((s) => s.stack);

  const isOpen = useCallback(
    (name: string) => stack.some((e) => e.name === name),
    [stack],
  );

  return { open, close, closeAll, isOpen };
}
