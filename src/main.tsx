import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './lib/tauri-ipc' // Initialize Tauri IPC wrapper
import { registerTerminalReloadTeardown } from './lib/terminal/terminalReloadTeardown'
import App from './App'
import './index.css'

registerTerminalReloadTeardown()

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
)
