import { Modal } from '../ui/Modal.js';
import type { LightEditorCommand } from './commands.js';
import { LightShortcutsList } from './LightShortcutsList.js';

interface LightShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
  commands: readonly LightEditorCommand[];
}

export function LightShortcutsModal({
  isOpen,
  onClose,
  commands,
}: LightShortcutsModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Editor Shortcuts"
      width="max-w-2xl"
    >
      <LightShortcutsList commands={commands} />
    </Modal>
  );
}
