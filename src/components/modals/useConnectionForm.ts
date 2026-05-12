import { useEffect, useMemo, useState } from 'react';
import { useAppStore, Connection } from '../../store/useAppStore';
import {
    validateConnectionDraft,
    getCredentialHealthChecks,
    buildConnectionSavePayload,
} from '../../features/connections/domain';
import { findDuplicateConnectionByEndpoint } from '../../features/connections/application/connectionService';

const EMPTY_FORM: Partial<Connection> = {
    name: '', host: '', username: '', port: 22, password: '',
    privateKeyPath: '', jumpServerId: undefined, icon: 'Server',
    folder: '', theme: '', tags: [],
};

export function useConnectionForm(isOpen: boolean, editingConnectionId: string | null) {
    const connections = useAppStore(state => state.connections);
    const folders = useAppStore(state => state.folders);
    const addConnection = useAppStore(state => state.addConnection);
    const editConnection = useAppStore(state => state.editConnection);

    const [formData, setFormData] = useState<Partial<Connection>>(EMPTY_FORM);
    const [authMethod, setAuthMethod] = useState<'password' | 'key' | 'vault'>('password');
    const [keyInputMode, setKeyInputMode] = useState<'file' | 'paste'>('file');
    const [touched, setTouched] = useState({ host: false, username: false, port: false, keyPath: false });
    const [submitAttempted, setSubmitAttempted] = useState(false);
    const [allowDuplicateEndpoint, setAllowDuplicateEndpoint] = useState(false);

    const activeEditingConnectionId = useMemo(
        () => (editingConnectionId && connections.some(c => c.id === editingConnectionId))
            ? editingConnectionId
            : null,
        [connections, editingConnectionId]
    );

    useEffect(() => {
        if (!isOpen) return;
        setAllowDuplicateEndpoint(false);
        setSubmitAttempted(false);
        setTouched({ host: false, username: false, port: false, keyPath: false });
        setKeyInputMode('file');

        if (activeEditingConnectionId) {
            const conn = useAppStore.getState().connections.find(c => c.id === activeEditingConnectionId);
            if (conn) {
                setFormData({
                    ...conn,
                    password: conn.password || '',
                    privateKeyPath: conn.privateKeyPath || '',
                    jumpServerId: conn.jumpServerId,
                    icon: conn.icon || 'Server',
                    tags: conn.tags || [],
                });
                setAuthMethod(conn.authRef ? 'vault' : conn.privateKeyPath ? 'key' : 'password');
                return;
            }
        }
        setFormData(EMPTY_FORM);
        setAuthMethod('password');
    }, [activeEditingConnectionId, isOpen]);

    // Paste mode stores key in vault — treat as vault for field validation.
    const effectiveAuthMode = authMethod === 'key' && keyInputMode === 'paste' ? 'vault' : authMethod;
    const validation = useMemo(
        () => validateConnectionDraft(formData, effectiveAuthMode),
        [formData, effectiveAuthMode]
    );
    const hostError = validation.fieldErrors.host || '';
    const usernameError = validation.fieldErrors.username || '';
    const keyPathError = validation.fieldErrors.privateKeyPath || '';
    const portError = validation.fieldErrors.port || '';
    const visibleHostError = (submitAttempted || touched.host) ? hostError : '';
    const visibleUsernameError = (submitAttempted || touched.username) ? usernameError : '';
    const visiblePortError = (submitAttempted || touched.port) ? portError : '';
    const visibleKeyPathError = (submitAttempted || touched.keyPath) ? keyPathError : '';

    const duplicateConnection = useMemo(
        () => findDuplicateConnectionByEndpoint(connections, formData, activeEditingConnectionId),
        [activeEditingConnectionId, connections, formData]
    );
    const credentialHealthChecks = useMemo(
        () => getCredentialHealthChecks(formData, effectiveAuthMode),
        [formData, effectiveAuthMode]
    );
    const jumpCycleWarning = useMemo(() => {
        if (!formData.jumpServerId || !activeEditingConnectionId) return false;
        const visited = new Set<string>();
        let current: string | undefined = formData.jumpServerId;
        while (current) {
            if (current === activeEditingConnectionId) return true;
            if (visited.has(current)) break;
            visited.add(current);
            current = connections.find(c => c.id === current)?.jumpServerId;
        }
        return false;
    }, [formData.jumpServerId, activeEditingConnectionId, connections]);

    const saveForm = (canSave: boolean): Connection | null => {
        if (!canSave || !validation.ok) return null;
        const connectionData = buildConnectionSavePayload({
            formData,
            authMethod,
            editingConnectionId: activeEditingConnectionId,
            connections,
        });
        activeEditingConnectionId ? editConnection(connectionData) : addConnection(connectionData);
        return connectionData;
    };

    return {
        connections, folders, addConnection, editConnection,
        formData, setFormData,
        authMethod, setAuthMethod,
        keyInputMode, setKeyInputMode,
        touched, setTouched,
        submitAttempted, setSubmitAttempted,
        allowDuplicateEndpoint, setAllowDuplicateEndpoint,
        activeEditingConnectionId,
        validation,
        visibleHostError, visibleUsernameError, visiblePortError, visibleKeyPathError,
        duplicateConnection, credentialHealthChecks, jumpCycleWarning,
        saveForm,
    };
}
