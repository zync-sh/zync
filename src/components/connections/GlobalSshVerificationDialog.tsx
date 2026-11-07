import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { formatConnectionEndpoint } from '../../features/connections/domain/connectionDisplay';
import {
    currentSshVerification,
    respondSshVerification,
    type SshVerificationRequest,
    subscribeSshVerification,
} from '../../features/connections/infrastructure/sshVerificationIpc';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';

/** Present one verified SSH connection's server challenge at a time. */
export function GlobalSshVerificationDialog() {
    const request = useSyncExternalStore(
        subscribeSshVerification,
        currentSshVerification,
        currentSshVerification,
    );
    return (
        request && (
            <VerificationForm
                key={request.requestId}
                request={request}
            />
        )
    );
}

/** Keep answers in the round's form and discard them when the round ends. */
function VerificationForm({ request }: { request: SshVerificationRequest }) {
    const formRef = useRef<HTMLFormElement>(null);
    const sending = useRef(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        // Each round opens with focus on its first response instead of the close button.
        const frame = window.requestAnimationFrame(() => {
            const form = formRef.current;
            (
                form?.querySelector('input') ??
                form?.querySelector<HTMLButtonElement>('[type=submit]')
            )?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, []);

    /** Keep rejected IPC replies available for retry or cancellation. */
    const respond = async (answers: string[] | null) => {
        if (sending.current) {
            return;
        }
        sending.current = true;
        setSubmitting(true);
        setError('');
        try {
            await respondSshVerification(request, answers);
            formRef.current?.reset();
        } catch (cause) {
            setError(
                String(cause).includes('SSH verification responses must be at most')
                    ? 'A response is too long. Shorten it and try again.'
                    : 'Could not send the response. Try again or cancel.',
            );
        } finally {
            sending.current = false;
            setSubmitting(false);
        }
    };
    /** Cancel the active round through the same guarded reply path. */
    const cancel = () => void respond(null);
    /** Read fields in SSH prompt order without storing responses in React state. */
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const answers = request.prompts.map(({ index }) => String(fields.get(String(index)) ?? ''));
        void respond(answers);
    };

    return (
        <Modal
            isOpen
            onClose={cancel}
            title="SSH verification"
            subtitle={formatConnectionEndpoint(request)}
            closeOnOverlayClick={false}
            zIndexClassName="z-[16000]"
        >
            <form
                ref={formRef}
                className="space-y-4"
                onSubmit={submit}
                autoComplete="off"
            >
                {request.title && (
                    <p className="whitespace-pre-wrap break-words text-sm font-medium text-app-text">
                        {request.title}
                    </p>
                )}
                {request.instructions && (
                    <p className="whitespace-pre-wrap break-words text-sm text-app-muted">
                        {request.instructions}
                    </p>
                )}
                {request.prompts.map(({ index, label, echo }) => (
                    <Input
                        key={index}
                        name={String(index)}
                        label={label.trim() ? label : 'Response'}
                        type={echo ? 'text' : 'password'}
                        maxLength={4096}
                        readOnly={submitting}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                    />
                ))}
                {error && (
                    <p
                        role="alert"
                        className="text-sm text-control-danger"
                    >
                        {error}
                    </p>
                )}
                <div className="flex justify-end gap-2 border-t border-app-border pt-4">
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={submitting}
                        onClick={cancel}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        size="sm"
                        isLoading={submitting}
                    >
                        Continue
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
