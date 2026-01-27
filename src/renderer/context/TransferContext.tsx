import { createContext, type ReactNode, useContext, useState } from 'react';

export interface Transfer {
  id: string;
  sourceConnectionId: string;
  sourcePath: string;
  destinationConnectionId: string;
  destinationPath: string;
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled';
  progress: {
    transferred: number;
    total: number;
    percentage: number;
  };
  error?: string;
  startTime: number;
}

interface TransferContextType {
  transfers: Transfer[];
  addTransfer: (transfer: Omit<Transfer, 'id' | 'status' | 'progress' | 'startTime'>) => string;
  updateTransferProgress: (id: string, progress: Transfer['progress']) => void;
  completeTransfer: (id: string) => void;
  failTransfer: (id: string, error: string) => void;
  cancelTransfer: (id: string) => void;
  removeTransfer: (id: string) => void;
}

const TransferContext = createContext<TransferContextType | undefined>(undefined);

export function TransferProvider({ children }: { children: ReactNode }) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  const addTransfer = (transfer: Omit<Transfer, 'id' | 'status' | 'progress' | 'startTime'>): string => {
    const id = Math.random().toString(36).substr(2, 9);
    const newTransfer: Transfer = {
      ...transfer,
      id,
      status: 'pending',
      progress: { transferred: 0, total: 0, percentage: 0 },
      startTime: Date.now(),
    };
    setTransfers((prev) => [...prev, newTransfer]);
    return id;
  };

  const updateTransferProgress = (id: string, progress: Transfer['progress']) => {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'transferring' as const, progress } : t)));
  };

  const completeTransfer = (id: string) => {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'completed' as const } : t)));
  };

  const failTransfer = (id: string, error: string) => {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'failed' as const, error } : t)));
  };

  const cancelTransfer = (id: string) => {
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'cancelled' as const } : t)));
  };

  const removeTransfer = (id: string) => {
    setTransfers((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <TransferContext.Provider
      value={{
        transfers,
        addTransfer,
        updateTransferProgress,
        completeTransfer,
        failTransfer,
        cancelTransfer,
        removeTransfer,
      }}
    >
      {children}
    </TransferContext.Provider>
  );
}

export function useTransfers() {
  const context = useContext(TransferContext);
  if (!context) {
    throw new Error('useTransfers must be used within TransferProvider');
  }
  return context;
}
