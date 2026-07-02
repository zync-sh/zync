import { useMemo } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import {
    DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS,
    getConnectionDisplayLabels,
    type ConnectionDisplayLabels,
} from '../domain/connectionDisplay.js';
import type { Connection } from '../domain/types.js';

export function useShowHostAddressesInLists(): boolean {
    return useAppStore(
        (state) => state.settings.privacy?.showHostAddressesInLists ?? DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS,
    );
}

export function useConnectionDisplayLabels(conn: Connection): ConnectionDisplayLabels {
    const showHostAddressesInLists = useShowHostAddressesInLists();
    return useMemo(
        () => getConnectionDisplayLabels(conn, showHostAddressesInLists),
        [conn, showHostAddressesInLists],
    );
}