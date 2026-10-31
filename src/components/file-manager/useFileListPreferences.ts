import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
    type FileListPreferences,
    loadFileListPreferences,
    normalizeFileListPreferences,
    saveFileListPreferences,
} from './fileListPresentation';

/** Pane-local state restores by stable workspace identity; only explicit actions write storage. */
export function useFileListPreferences(
    connectionId: string | undefined,
    instanceId: string | undefined,
) {
    const scope = JSON.stringify([connectionId ?? '', (instanceId ?? '').trim()]);
    const restored = useMemo(() => loadFileListPreferences(scope), [scope]);
    const [preferences, setPreferences] = useState(restored);
    const current = useRef(restored);

    useLayoutEffect(() => {
        current.current = restored;
        setPreferences(restored);
    }, [restored]);

    const update = useCallback(
        (patch: Partial<FileListPreferences>) => {
            const next = normalizeFileListPreferences({ ...current.current, ...patch });
            if (JSON.stringify(next) === JSON.stringify(current.current)) {
                return;
            }
            current.current = next;
            setPreferences(next);
            if (connectionId) {
                saveFileListPreferences(scope, next);
            }
        },
        [connectionId, scope],
    );

    return [preferences, update] as const;
}
