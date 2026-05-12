import type { Connection } from '../../../../features/connections/domain/types';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import { Modal } from '../../../ui/Modal';

interface ManageAssignmentsModalProps {
  isOpen: boolean;
  itemLabel: string | null;
  assignSearch: string;
  selectedAssignConnectionIds: string[];
  filteredConnections: Connection[];
  isAssigning: boolean;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onToggleConnection: (connectionId: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onSubmit: () => void;
}

export function ManageAssignmentsModal({
  isOpen,
  itemLabel,
  assignSearch,
  selectedAssignConnectionIds,
  filteredConnections,
  isAssigning,
  onClose,
  onSearchChange,
  onToggleConnection,
  onSelectAll,
  onClear,
  onSubmit,
}: ManageAssignmentsModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={itemLabel ? `Manage "${itemLabel}" Assignments` : 'Manage Credential Assignments'}
      subtitle="Selected hosts will use this vault credential. Deselecting a currently assigned host removes the credential from that host."
      width="max-w-2xl"
    >
      <div className="space-y-4">
        <Input
          label="Search hosts"
          value={assignSearch}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by host, name, or username"
          disabled={isAssigning}
        />

        <div className="rounded-xl border border-app-border/60 bg-app-surface/25 divide-y divide-app-border/30 max-h-[360px] overflow-y-auto">
          {filteredConnections.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-app-muted">
              No hosts match your search.
            </div>
          ) : filteredConnections.map((connection) => {
            const checked = selectedAssignConnectionIds.includes(connection.id);
            return (
              <label
                key={connection.id}
                className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-app-surface/35"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleConnection(connection.id)}
                  disabled={isAssigning}
                  className="mt-1 h-4 w-4 rounded border-app-border bg-app-surface"
                />
                <div className="min-w-0">
                  <p className="text-sm text-app-text font-medium truncate">{connection.name}</p>
                  <p className="text-xs text-app-muted">
                    {connection.username}@{connection.host}:{connection.port}
                  </p>
                  {connection.authRef && (
                    <p className="text-[11px] text-app-muted/70 mt-1">
                      Current vault ref · {connection.authRef.credentialId?.slice(0, 8) || connection.authRef.itemId.slice(0, 8)}
                    </p>
                  )}
                </div>
              </label>
            );
          })}
        </div>

        <div className="flex items-center justify-between text-xs text-app-muted">
          <span>{selectedAssignConnectionIds.length} host{selectedAssignConnectionIds.length === 1 ? '' : 's'} selected</span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onSelectAll}
              disabled={isAssigning || filteredConnections.length === 0}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              disabled={isAssigning || selectedAssignConnectionIds.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isAssigning}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} isLoading={isAssigning}>
            Save Assignments
          </Button>
        </div>
      </div>
    </Modal>
  );
}

