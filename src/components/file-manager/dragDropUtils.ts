import type React from 'react';
import type { FileEntry } from './types';
import { setCurrentDragSource } from '../../lib/dragDrop';

const normalizePath = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '') || '/';

export interface DragData {
  type: string;
  connectionId: string;
  path: string;
  paths: string[];
  names: string[];
  name: string;
  size: number;
}

export const buildDragData = (
  file: FileEntry,
  isSelected: boolean,
  selectedFiles: string[],
  connectionId: string,
  currentPath: string
): DragData => {
  const fullPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
  
  let draggedFiles: { name: string; path: string }[] = [];
  if (isSelected && selectedFiles.length > 0) {
    draggedFiles = selectedFiles.map(name => ({
      name,
      path: currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
    }));
  } else {
    draggedFiles = [{ name: file.name, path: file.path }];
  }

  return {
    type: 'server-file',
    connectionId,
    path: fullPath,
    paths: draggedFiles.map(f => f.path),
    names: draggedFiles.map(f => f.name),
    name: file.name,
    size: file.size,
  };
};

export const createDragPreview = (
  count: number,
  isFolder: boolean,
  fileName: string
): HTMLDivElement => {
  const dragPreview = document.createElement('div');
  dragPreview.style.cssText = `
    position: absolute; 
    top: -1000px; 
    padding: 8px 12px; 
    background: var(--color-app-surface); 
    border: 1px solid var(--color-app-border); 
    border-radius: 10px; 
    font-weight: 500; 
    font-size: 13px; 
    color: var(--color-app-text); 
    z-index: 9999; 
    pointer-events: none; 
    display: flex; 
    align-items: center; 
    gap: 8px; 
    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  `;
  
  const iconNode = document.createElement('span');
  iconNode.textContent = count > 1 ? '📚' : (isFolder ? '📁' : '📄');
  dragPreview.appendChild(iconNode);

  const nameNode = document.createElement('span');
  nameNode.textContent = count > 1 ? `${count} items` : fileName;
  dragPreview.appendChild(nameNode);

  document.body.appendChild(dragPreview);

  return dragPreview;
};

export const cleanupDragPreview = (dragPreview: HTMLDivElement) => {
  setTimeout(() => {
    if (dragPreview.parentNode) {
      dragPreview.parentNode.removeChild(dragPreview);
    }
  }, 0);
};

export const validateAndBuildMoves = (
  data: DragData,
  targetFolder: string
): { source: string; target: string; sourceConnectionId?: string }[] => {
  const moves: { source: string; target: string; sourceConnectionId?: string }[] = [];
  const normTarget = normalizePath(targetFolder);

  const handleSource = (sourcePath: string, sourceName?: string) => {
    const normSource = normalizePath(sourcePath);
    const name = sourceName || normSource.split(/[/\\]/).pop();
    if (!name) return;

    // Self-drop check
    if (normSource === normTarget) return;

    // Descendant check
    if (normTarget.startsWith(normSource + '/')) return;

    moves.push({ 
      source: normSource, 
      target: `${normTarget}/${name}`,
      sourceConnectionId: data.connectionId
    });
  };

  if (data.paths && Array.isArray(data.paths)) {
    data.paths.forEach((s: string, i: number) => handleSource(s, data.names?.[i]));
  } else if (data.path) {
    handleSource(data.path, data.name);
  }

  return moves;
};

export const startInternalDrag = (
  e: React.DragEvent,
  dragData: DragData,
  isFolder: boolean,
  count: number
) => {
  setCurrentDragSource({ connectionId: dragData.connectionId, path: dragData.path });

  const preview = createDragPreview(count, isFolder, dragData.name);
  e.dataTransfer.setDragImage(preview, 20, 20);
  cleanupDragPreview(preview);

  e.dataTransfer.setData('application/json', JSON.stringify(dragData));
  e.dataTransfer.effectAllowed = 'copyMove';
  
  if (e.currentTarget instanceof HTMLElement) {
    e.currentTarget.style.opacity = '0.5';
  }
};
