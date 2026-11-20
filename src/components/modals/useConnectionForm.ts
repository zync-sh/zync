import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { findBlockingDuplicateConnectionByEndpoint } from '../../features/connections/application/connectionService';
import {
    applyAuthMethodTransition,
    buildConnectionSavePayload,
    type ConnectionAuthMode,
    connectionUsesSshAgent,
    SELF_AGENT_FORWARDING_KEY,
    validateConnectionDraft,
} from '../../features/connections/domain';
import { Connection, useAppStore } from '../../store/useAppStore';

const EMPTY_FORM: Partial<Connection> = {
    name: '',
    host: '',
    username: '',
    port: 22,
    password: '',
    privateKeyPath: '',
    jumpServerId: undefined,
    icon: 'Server',
    agentForwardingKeyConnectionId: undefined,
    folder: '',
    theme: '',
    tags: [],
};

export type KeyInputMode = 'file' | 'paste';
export type VaultInputMode = 'existing' | 'paste' | 'import';

export function useConnectionForm(isOpen: boolean, editingConnectionId: string | null) {
    const connections = useAppStore((state) => state.connections);
    const folders = useAppStore((state) => state.folders);
    const addConnection = useAppStore((state) => state.addConnection);
    const editConnection = useAppStore((state) => state.editConnection);

    const [formData, setFormData] = useState<Partial<Connection>>(EMPTY_FORM);
    const [authMethod, setAuthMethodState] = useState<ConnectionAuthMode>('password');
    const [keyInputMode, setKeyInputMode] = useState<KeyInputMode>('file');
    const [vaultInputMode, setVaultInputMode] = useState<VaultInputMode>('existing');
    const [touched, setTouched] = useState({
        host: false,
        username: false,
        port: false,
        keyPath: false,
    });
    const [submitAttempted, setSubmitAttempted] = useState(false);
    const [allowDuplicateEndpoint, setAllowDuplicateEndpoint] = useState(false);

    const activeEditingConnectionId = useMemo(
        () =>
            editingConnectionId && connections.some((c) => c.id === editingConnectionId)
                ? editingConnectionId
                : null,
        [connections, editingConnectionId],
    );

    const authMethodRef = useRef<ConnectionAuthMode>('password');

    const setAuthMethod = useCallback((next: ConnectionAuthMode) => {
        const prev = authMethodRef.current;
        if (prev === next) {
            return;
        }
        // Keep the authMethod state updater pure — apply form secret clearing here.
        authMethodRef.current = next;
        setAuthMethodState(next);
        setFormData((fd) => applyAuthMethodTransition(fd, prev, next));
    }, []);

    useEffect(() => {
        if (!isOpen) {
            return;
        }
        setAllowDuplicateEndpoint(false);
        setSubmitAttempted(false);
        setTouched({ host: false, username: false, port: false, keyPath: false });
        setKeyInputMode('file');
        setVaultInputMode('existing');

        if (activeEditingConnectionId) {
            const conn = useAppStore
                .getState()
                .connections.find((c) => c.id === activeEditingConnectionId);
            if (conn) {
                const nextAuthMethod: ConnectionAuthMode = conn.authRef
                    ? 'vault'
                    : connectionUsesSshAgent(conn)
                      ? 'agent'
                      : conn.privateKeyPath
                        ? 'key'
                        : 'password';
                setFormData({
                    ...conn,
                    password: conn.password || '',
                    privateKeyPath: conn.privateKeyPath || '',
                    jumpServerId: conn.jumpServerId,
                    agentForwardingKeyConnectionId:
                        conn.agentForwardingKeyConnectionId === conn.id
                            ? SELF_AGENT_FORWARDING_KEY
                            : conn.agentForwardingKeyConnectionId,
                    icon: conn.icon || 'Server',
                    tags: conn.tags || [],
                });
                authMethodRef.current = nextAuthMethod;
                setAuthMethodState(nextAuthMethod);
                return;
            }
        }
        setFormData(EMPTY_FORM);
        authMethodRef.current = 'password';
        setAuthMethodState('password');
    }, [activeEditingConnectionId, isOpen]);

    // Local key paste writes a managed file on save — path not required until then.
    const deferKeyPath = authMethod === 'key' && keyInputMode === 'paste';
    const validation = useMemo(
        () => validateConnectionDraft(formData, authMethod, { deferKeyPath }),
        [formData, authMethod, deferKeyPath],
    );
    const hostError = validation.fieldErrors.host || '';
    const usernameError = validation.fieldErrors.username || '';
    const keyPathError = validation.fieldErrors.privateKeyPath || '';
    const portError = validation.fieldErrors.port || '';
    const visibleHostError = submitAttempted || touched.host ? hostError : '';
    const visibleUsernameError = submitAttempted || touched.username ? usernameError : '';
    const visiblePortError = submitAttempted || touched.port ? portError : '';
    const visibleKeyPathError = submitAttempted || touched.keyPath ? keyPathError : '';

    const duplicateConnection = useMemo(
        () =>
            findBlockingDuplicateConnectionByEndpoint(
                connections,
                formData,
                activeEditingConnectionId,
            ),
        [activeEditingConnectionId, connections, formData],
    );
    const jumpCycleWarning = useMemo(() => {
        if (!formData.jumpServerId || !activeEditingConnectionId) {
            return false;
        }
        const visited = new Set<string>();
        let current: string | undefined = formData.jumpServerId;
        while (current) {
            if (current === activeEditingConnectionId) {
                return true;
            }
            if (visited.has(current)) {
                break;
            }
            visited.add(current);
            current = connections.find((c) => c.id === current)?.jumpServerId;
        }
        return false;
    }, [formData.jumpServerId, activeEditingConnectionId, connections]);

    /** Reuse host transforms with an optional ordered persistence boundary supplied by the editor. */
    const saveForm = async (
        canSave: boolean,
        persist?: (connection: Connection) => Promise<void>,
    ): Promise<Connection | null> => {
        if (!canSave || !validation.ok) {
            return null;
        }
        const connectionData = buildConnectionSavePayload({
            formData,
            authMethod,
            editingConnectionId: activeEditingConnectionId,
            connections,
        });
        if (persist) {
            await persist(connectionData);
        } else if (activeEditingConnectionId) {
            await editConnection(connectionData);
        } else {
            await addConnection(connectionData);
        }
        return connectionData;
    };

    return {
        connections,
        folders,
        addConnection,
        editConnection,
        formData,
        setFormData,
        authMethod,
        setAuthMethod,
        keyInputMode,
        setKeyInputMode,
        vaultInputMode,
        setVaultInputMode,
        touched,
        setTouched,
        submitAttempted,
        setSubmitAttempted,
        allowDuplicateEndpoint,
        setAllowDuplicateEndpoint,
        activeEditingConnectionId,
        validation,
        visibleHostError,
        visibleUsernameError,
        visiblePortError,
        visibleKeyPathError,
        duplicateConnection,
        jumpCycleWarning,
        saveForm,
    };
}
