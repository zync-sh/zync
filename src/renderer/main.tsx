import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MainLayout } from './components/layout/MainLayout'
import { ConnectionProvider } from './context/ConnectionContext'
import { ToastProvider } from './context/ToastContext'
import { SettingsProvider } from './context/SettingsContext'
import './index.css'

import { TransferProvider } from './context/TransferContext'
import { TransferManager } from './components/file-manager/TransferManager'
import { WelcomeScreen } from './components/dashboard/WelcomeScreen'

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ToastProvider>
            <SettingsProvider>
                <ConnectionProvider>
                    <TransferProvider>
                        <MainLayout>
                            {/* Default Content when no tabs open */}
                            {/* Default Content when no tabs open */}
                            <WelcomeScreen />
                        </MainLayout>
                        <TransferManager />
                    </TransferProvider>
                </ConnectionProvider>
            </SettingsProvider>
        </ToastProvider>
    </StrictMode>,
)
