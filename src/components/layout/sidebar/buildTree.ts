import type { Connection, Folder } from '../../../store/useAppStore';
import type { TreeNode } from './types';

export function buildTree(conns: Connection[], allFolders: Folder[], searchTerm: string): TreeNode {
    const root: TreeNode = { name: 'root', path: '', children: {}, connections: [] };
    const folderMap = new Map(allFolders.map(f => [f.name, f]));
    const normalizedSearch = searchTerm.toLowerCase();

    // Helper to get/create node
    const getNode = (path: string) => {
        const parts = path.split('/').filter(Boolean);
        let current = root;
        let currentPath = '';
        parts.forEach((part) => {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (!current.children[part]) {
                const folderMeta = folderMap.get(currentPath);
                current.children[part] = {
                    name: part,
                    path: currentPath,
                    children: {},
                    connections: [],
                    folderTags: folderMeta?.tags
                };
            }
            current = current.children[part];
        });
        return current;
    };

    // 1. Ensure matching folders exist
    if (!searchTerm) {
        allFolders.forEach(f => getNode(f.name));
    } else {
        allFolders.filter(f =>
            f.name.toLowerCase().includes(normalizedSearch) ||
            (f.tags && f.tags.some(t => t.toLowerCase().includes(normalizedSearch)))
        ).forEach(f => getNode(f.name));
    }

    // 2. Populate Connections
    conns.forEach((conn: Connection) => {
        const matchesSearch = !searchTerm ||
            (conn.name ?? conn.host ?? '').toLowerCase().includes(normalizedSearch) ||
            (conn.tags && conn.tags.some(t => t.toLowerCase().includes(normalizedSearch)));

        if (matchesSearch) {
            if (conn.folder) {
                getNode(conn.folder).connections.push(conn);
            } else {
                root.connections.push(conn);
            }
        }
    });

    return root;
}
