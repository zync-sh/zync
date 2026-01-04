import path from 'node:path';
import { app, BrowserWindow } from 'electron';

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public');

// Disable GPU/Sandbox for stability
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

let win: BrowserWindow | null;
// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5000";

function createWindow() {
  const iconPath = path.join(process.env.VITE_PUBLIC || '', 'icon.svg');
  console.log('Loading icon from:', iconPath);

  win = new BrowserWindow({
    icon: iconPath,
    // titleBarStyle: 'hidden', // Commented out to test blackout fix
    // titleBarOverlay: {
    //   color: '#0f172a',
    //   symbolColor: '#ffffff',
    // },
    autoHideMenuBar: true, // Hide default menu bar but keep window frame
    width: 1200,
    height: 800,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false, // Required when app.commandLine.appendSwitch('no-sandbox') is used
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString());
  });

  if (process.env.DIST && path.join(process.env.DIST, 'index.html')) {
    // lint fix
  }

  if (VITE_DEV_SERVER_URL) {
    console.log('Loading Dev Server:', VITE_DEV_SERVER_URL);
    win.loadURL(VITE_DEV_SERVER_URL);
    console.log('Opening DevTools...');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(process.env.DIST || '', 'index.html'));
  }
}

// Set up IPC
import { setupIPC } from './ipc-handlers';

setupIPC();

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(createWindow);
