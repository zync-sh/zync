import path from 'node:path';
import { app, BrowserWindow, nativeImage } from 'electron';

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public');

// Disable GPU Acceleration for Linux/Remote stability
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

let win: BrowserWindow | null;
// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const iconPath = path.join(process.env.VITE_PUBLIC || '', 'icon.png');
  console.log('Loading icon from:', iconPath);
  const icon = nativeImage.createFromPath(iconPath);

  win = new BrowserWindow({
    icon: icon,
    titleBarStyle: 'hidden', // Sleek borderless look
    // titleBarOverlay: false,
    width: 1200,
    height: 800,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(process.env.DIST || '', 'index.html'));
  }

  // Handle Window Close
  win.on('close', (e) => {
    const activeCount = sshManager.getActiveConnectionCount();
    if (activeCount > 0) {
      const choice = dialog.showMessageBoxSync(win!, {
        type: 'question',
        buttons: ['Yes, Close', 'Cancel'],
        defaultId: 1,
        title: 'Confirm Close',
        message: 'Active Connections',
        detail: `You have ${activeCount} active SSH connection(s). Closing the app will terminate them. Are you sure?`,
        noLink: true
      });

      if (choice === 1) {
        e.preventDefault(); // Cancel closure
      } else {
        // Proceeding to close. You might want to gracefully disconnect here if needed,
        // but Electron/Node cleanup usually kills child processes (like SSH shells) anyway.
        // Explicit disconnect is cleaner though.
        // sshManager.disconnectAll(); // If we had this method.
      }
    }
  });
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

// Import SSH Manager
// import { sshManager } from './ssh-manager'; // already available globally if imported via handlers or similar. 
// However, we need to ensure it's imported.
import { sshManager } from './ssh-manager';
import { dialog } from 'electron';

// Note: We need to handle 'close' event on the window instance, 
// usually done inside createWindow or just after assigning 'win'.

// We'll wrap the window close handler logic here, but since 'win' is created in createWindow,
// we should actually modify createWindow to attach the listener.
// Let's modify the file content differently to attach the listener inside createWindow.

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(createWindow);
