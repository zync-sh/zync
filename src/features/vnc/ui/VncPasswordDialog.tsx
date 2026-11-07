import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Modal } from '../../../components/ui/Modal';

interface VncPasswordDialogProps {
    endpoint: string;
    onCancel: () => void;
    onSubmit: (password: string) => void;
}

/** Collect the viewer's password for this negotiation and clear the form on submission. */
export function VncPasswordDialog({ endpoint, onCancel, onSubmit }: VncPasswordDialogProps) {
    return (
        <Modal
            isOpen
            onClose={onCancel}
            title="VNC authentication"
            subtitle={endpoint}
            width="max-w-sm"
            closeOnOverlayClick={false}
            zIndexClassName="z-[15000]"
        >
            <form
                className="space-y-4"
                autoComplete="off"
                onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const password = new FormData(form).get('password');
                    if (typeof password === 'string' && password) {
                        form.reset();
                        onSubmit(password);
                    }
                }}
            >
                <Input
                    type="password"
                    name="password"
                    label="VNC password"
                    required
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                />
                <div className="flex justify-end gap-2 border-t border-app-border pt-4">
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={onCancel}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        size="sm"
                    >
                        Continue
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
