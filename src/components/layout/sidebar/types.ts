import type { Connection } from '../../../store/useAppStore';

export interface TreeNode {
    name: string;
    path: string;
    children: { [key: string]: TreeNode };
    connections: Connection[];
    folderTags?: string[];
}

export interface ConnectionItemProps {
    onEdit: (conn: Connection) => void;
    onOpenContextMenu: (conn: Connection, x: number, y: number) => void;
}
