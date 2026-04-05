/**
 * ModalRoot — mount this ONCE inside MainLayout.
 *
 * It watches the modal store and renders every modal in the stack.
 * Each modal receives its registered props plus an `onClose` callback.
 * Modals stack correctly (last opened is on top via z-index layering).
 */

import { useModalStore, getModalComponent } from '../../lib/modalRegistry';

export function ModalRoot() {
  const stack = useModalStore((s) => s.stack);
  const close = useModalStore((s) => s.close);

  if (stack.length === 0) return null;

  return (
    <>
      {stack.map((entry) => {
        const Component = getModalComponent(entry.name);
        if (!Component) return null;

        return (
          <Component
            key={entry.instanceId}
            {...entry.props}
            isOpen={entry.isOpen}
            onClose={() => close(entry.name)}
          />
        );
      })}
    </>
  );
}
