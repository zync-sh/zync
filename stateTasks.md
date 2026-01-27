# State Management Refactoring Tasks

The following components and patterns have been identified for migration to the unified Zustand store (`src/renderer/store`).
**Crucial:** All persistent data (Snippets, Tunnels, Settings) must continue to be saved to the filesystem via the existing IPC channels (`window.ipcRenderer`). The Zustand store will act as the frontend "cache" and synchronization layer, exactly matching the pattern in `connectionSlice.ts`.

## 1. Cleanup & Redundancy

- [x] **Remove `ToastContext`**: The file `src/renderer/context/ToastContext.tsx` appears to be redundant as `toastSlice.ts` is already implemented and used by `ToastContainer.tsx`.
    - **Target**: `src/renderer/context/ToastContext.tsx` (Delete) (Completed)

## 2. Global Data Migration (Store + IPC Persistence)

Transform components that fetch and hold global/shared data in local state to use Zustand slices. This improves data consistency and allows access from other parts of the app.

### Snippets Management
- [x] **Create `snippetsSlice.ts`**:
    - **State**: `snippets: Snippet[]`
    - **Actions**: `loadSnippets()` (calls `snippets:getAll`), `addSnippet()`, `updateSnippet()`, `deleteSnippet()` (call `snippets:save`/`delete`). (Completed)
- [x] **Refactor `SnippetsManager.tsx`**:
    - Remove local `useState` for snippets.
    - Use store `snippets` for list and `isLoadingSnippets` for loading state.
    - **Target**: `src/renderer/components/snippets/SnippetsManager.tsx` (Completed)

### Tunnel Management
- [x] **Create `tunnelSlice.ts`**:
    - **State**: `tunnels: Record<connectionId, TunnelConfig[]>`
    - **Actions**: `loadTunnels(connId)`, `saveTunnel(connId, tunnel)`, `deleteTunnel(tunnelId)`, `toggleTunnel(tunnelId)`.
    - **Persistence**: Ensure `tunnel:save`, `tunnel:start`, `tunnel:stop` IPC calls are made within actions. (Completed)
- [x] **Refactor `TunnelManager.tsx`**:
    - Remove local `useState` for tunnels.
    - Use store to manage tunnel status and list.
    - **Target**: `src/renderer/components/tunnel/TunnelManager.tsx` (Completed)

## 3. Complex Component State (UI Persistence)

Refactor complex local state that acts like a "mini-store" into proper Zustand slices.

### Terminal Types
- [x] **Create `terminalSlice.ts`**:
    - **State**: `terminals: Record<connectionId, TerminalTab[]>`
    - **Actions**: `createTerminal(connId)`, `closeTerminal(termId)`.
- [x] **Refactor `TerminalManager.tsx`**:
    - Move `tabs` and `activeTabId` logic to store.
    - **Target**: `src/renderer/components/terminal/TerminalManager.tsx`

### File System State
- [x] **Create `fileSystemSlice.ts`**:
    - **State**: `fileCache: Record<connectionId, { path: string, files: FileEntry[] }>`
    - **Actions**: `loadDirectory(connId, path)`, `setFiles(connId, files)`.
- [x] **Refactor `FileManager.tsx`**:
    - Move `currentPath`, `files`, `viewMode` to store.
    - **Target**: `src/renderer/components/FileManager.tsx`

## 4. UI Preferences

### Sidebar State
- [x] **Update `settingsSlice.ts`**:
    - Add `expandedFolders: string[]` to `settings` (or separate UI slice usage if not saved to `config.json`).
    - **Target**: `src/renderer/components/layout/Sidebar.tsx`
