/**
 * Modal Registry
 *
 * Central store for all modal definitions in Zync.
 * Modals are registered once (at app start or from a plugin) and opened
 * from anywhere via the `useModalStore` hook — no prop-drilling required.
 *
 * Usage:
 *   // Register (at the bottom of the modal's own file):
 *   registerModal('addConnection', AddConnectionModal)
 *
 *   // Open from any component:
 *   const { open } = useModalStore()
 *   open('addConnection', { defaultHost: '10.0.0.1' })
 *
 *   // Close (usually the modal's own onClose prop does this automatically):
 *   const { close } = useModalStore()
 *   close('addConnection')
 */

import { ComponentType } from 'react';
import { create } from 'zustand';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Props every registered modal component always receives. */
export interface BaseModalProps {
  /** Always true while the modal is in the stack. Set false briefly for exit animation. */
  isOpen: boolean;
  /** Call this to close the modal. Triggers exit animation then removes from stack. */
  onClose: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

/** One entry in the open-modal stack. */
interface ModalEntry {
  /** Unique instance id — allows the same modal type to be open multiple times. */
  instanceId: string;
  /** Registered modal name. */
  name: string;
  /** Extra props forwarded to the component (merged with isOpen + onClose). */
  props: Record<string, unknown>;
  /**
   * Controls the AnimatePresence exit animation.
   * true  = visible (normal)
   * false = exit animation playing → component removed after CLOSE_DELAY_MS
   */
  isOpen: boolean;
}

/** How long the exit animation runs before the component is unmounted (ms). */
const CLOSE_DELAY_MS = 250;

// ── Registry ───────────────────────────────────────────────────────────────────

const registry = new Map<string, AnyComponent>();

/**
 * Register a modal component under a name.
 * Call this at the bottom of the modal's own file, or from a plugin entry point.
 *
 * @example
 * // At the bottom of AddConnectionModal.tsx:
 * registerModal('addConnection', AddConnectionModal)
 */
export function registerModal(name: string, component: AnyComponent): void {
  if (registry.has(name)) {
    console.warn(`[modalRegistry] Overwriting modal "${name}". Intentional?`);
  }
  registry.set(name, component);
}

/** Retrieve a registered component by name. Returns undefined if not found. */
export function getModalComponent(name: string): AnyComponent | undefined {
  return registry.get(name);
}

/** Returns the full registry (read-only). Useful for debugging. */
export function getRegistry(): ReadonlyMap<string, AnyComponent> {
  return registry;
}

// ── Store ──────────────────────────────────────────────────────────────────────

interface ModalStore {
  stack: ModalEntry[];
  open: (name: string, props?: Record<string, unknown>) => void;
  close: (name: string) => void;
  closeAll: () => void;
  /** Internal: used by close() after the exit animation delay. */
  _remove: (instanceId: string) => void;
  /** Internal: used by close() to flip isOpen=false. */
  _setClosing: (name: string) => string | null;
}

let instanceCounter = 0;

export const useModalStore = create<ModalStore>((set, get) => ({
  stack: [],

  open(name, props = {}) {
    if (!registry.has(name)) {
      console.error(`[modalRegistry] Modal "${name}" is not registered.`);
      return;
    }
    instanceCounter += 1;
    set((s) => ({
      stack: [
        ...s.stack,
        { instanceId: `${name}-${instanceCounter}`, name, props, isOpen: true },
      ],
    }));
  },

  close(name) {
    // Step 1: flip isOpen=false → exit animation plays in the component
    const instanceId = get()._setClosing(name);
    if (!instanceId) return;

    // Step 2: after the animation, remove from stack
    setTimeout(() => get()._remove(instanceId), CLOSE_DELAY_MS);
  },

  closeAll() {
    // Capture the IDs of entries currently open so any modals added during the
    // animation delay are not accidentally removed.
    const closingIds = new Set(get().stack.map((e) => e.instanceId));
    set((s) => ({
      stack: s.stack.map((e) =>
        closingIds.has(e.instanceId) ? { ...e, isOpen: false } : e,
      ),
    }));
    setTimeout(
      () => set((s) => ({ stack: s.stack.filter((e) => !closingIds.has(e.instanceId)) })),
      CLOSE_DELAY_MS,
    );
  },

  _setClosing(name) {
    // Find the most recently opened entry with this name
    const stack = get().stack;
    const entry = [...stack].reverse().find((e) => e.name === name && e.isOpen);
    if (!entry) return null;

    set((s) => ({
      stack: s.stack.map((e) =>
        e.instanceId === entry.instanceId ? { ...e, isOpen: false } : e,
      ),
    }));
    return entry.instanceId;
  },

  _remove(instanceId) {
    set((s) => ({ stack: s.stack.filter((e) => e.instanceId !== instanceId) }));
  },
}));
