import path from 'node:path';
import { app, BrowserWindow, nativeImage, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { appConfigManager } from './app-config-manager';

// Configure Logs to use Data Path
log.transports.file.resolvePathFn = () => path.join(appConfigManager.getLogPath(), 'main.log');
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB limit
log.transports.file.fileName = 'main.log'; // Explicit filename

// Redirect console to log file
Object.assign(console, log.functions);

// Import SSH Manager
import { sshManager } from './ssh-manager';
// Set up IPC
import { setupIPC } from './ipc-handlers';

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public');

// Disable GPU Acceleration for Linux/Remote stability
// Note: Transparency on Linux requires GPU acceleration in many cases.
// app.commandLine.appendSwitch('disable-gpu');
// app.commandLine.appendSwitch('disable-software-rasterizer');
// app.disableHardwareAcceleration();

// Enable Transparency Flags for Linux
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.commandLine.appendSwitch('disable-gpu'); // Try keeping this disabled for now as it causes flicker on some drivers, but if transparency fails, we might need to enable it.
  // Actually, for many Linux compositors, we DO need hardware acceleration. 
  // Let's try re-enabling HW accel by commenting out the disable calls above.
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

// Use var to hoisted variable and avoid Temporal Dead Zone in bundled code
// eslint-disable-next-line no-var
var win: BrowserWindow | null = null;

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, we should focus our window.
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Proceed with app initialization
  setupIPC();

  // 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
  const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

  function createWindow() {
    const iconPath = path.join(process.env.VITE_PUBLIC || '', 'icon.png');
    console.log('Loading icon from:', iconPath);
    const icon = nativeImage.createFromPath(iconPath);

    const isMac = process.platform === 'darwin';

    win = new BrowserWindow({
      icon: icon,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      frame: !isMac, // macOS uses titleBarStyle, Windows/Linux need frameless
      width: 1200,
      height: 800,
      transparent: !isMac, // Transparent only on non-macOS
      backgroundColor: isMac ? undefined : '#00000000',
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
          // Proceeding to close.
        }
      }
    });
  }

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
      win = null;
    }
  });

  app.on('before-quit', () => {
    try {
      sshManager.disconnectAll();
      log.info('Forcefully disconnected all SSH sessions on quit.');
    } catch (e) {
      log.error('Error disconnecting sessions on quit:', e);
    }
  });

  app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Import SSH Manager
  // import { sshManager } from './ssh-manager'; // Moved to top

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

  app.whenReady().then(() => {
    log.info('==========================================');
    log.info(`Zync App Started (v${app.getVersion()})`);
    log.info(`Platform: ${process.platform} (${process.arch})`);
    log.info(`Data Path: ${appConfigManager.getDataPath()}`);
    log.info(`Log Path: ${appConfigManager.getLogPath()}`);
    log.info('==========================================');
    createWindow();

    // Auto Updater Logic
    if (app.isPackaged) {
      autoUpdater.logger = log;
      // @ts-ignore
      autoUpdater.logger.transports.file.level = 'info';

      // Check for updates after a short delay to ensure window is ready
      setTimeout(() => {
        log.info('Checking for updates...');
        autoUpdater.checkForUpdatesAndNotify();
      }, 3000);
    }
  });

  // Auto Updater Events
  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
    win?.webContents.send('update:status', 'Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info);
    win?.webContents.send('update:available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available:', info);
    win?.webContents.send('update:status', 'Update not available.');
  });

  autoUpdater.on('error', (err) => {
    log.error('Error in auto-updater:', err);
    win?.webContents.send('update:error', err.message);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    let log_message = "Download speed: " + progressObj.bytesPerSecond;
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
    log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
    log.info(log_message);
    win?.webContents.send('update:progress', progressObj);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info);
    win?.webContents.send('update:downloaded', info);
  });
}
