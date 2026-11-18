'use strict';
/**
 * 拾念 · Electron 桌面壳
 * - 无边框窗口（frame:false），页面自己画标题栏与窗口按钮
 * - 本地服务由 node.exe 子进程提供，壳只负责起服务、开窗、转发窗口按钮
 */
const { app, BrowserWindow, ipcMain, shell, dialog, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const lifecycle = require('../lib/shell-lifecycle');

const APP_DIR = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 7777);
const APP_URL = 'http://127.0.0.1:' + PORT;
const IS_MAC = process.platform === 'darwin';
const STATE_DIR = IS_MAC ? path.join(app.getPath('appData'), 'Notidea', 'desktop-state') : path.join(APP_DIR, 'data');
const STATE_FILE = path.join(STATE_DIR, 'shell-window.json');
const BG = '#f3f3f7';

let win = null;
let serverProc = null;
let tray = null;
let quitting = false;
let trayHintShown = false;
let control = null;
let exitPending = false;
let serverStarting = false;

async function requestQuit() {
  if (quitting || exitPending) return;
  exitPending = true;
  try {
    if (serverStarting) throw new Error('服务正在启动，请稍后退出');
    if (control) {
      const result = await lifecycle.request(PORT, control, 'shutdown');
      if (result.code !== 200 || !result.ok) throw new Error(result.error === 'Forbidden'
        ? '当前服务不是本桌面管理的服务，请手动结束旧实例后重新打开拾念'
        : result.error || '无法确认服务已退出，请稍后重试');
      let stopped = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { await lifecycle.request(PORT, control); }
        catch (e) { if (e.code === 'ECONNREFUSED') { stopped = true; break; } }
      }
      if (!stopped) throw new Error('尚未确认后台服务停止，请稍后退出');
      control = null;
    }
    quitting = true;
    app.quit();
  } catch (e) {
    dialog.showMessageBox({ type: 'info', title: '拾念', message: '暂时无法退出', detail: String(e.message || e) });
  } finally { exitPending = false; }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(APP_URL + '/api/bootstrap', { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function nodeExe() {
  const candidates = [
    ...(IS_MAC ? [path.join(APP_DIR, 'runtime', 'node')] : []),
    path.join(APP_DIR, 'node.exe'),
    path.join(APP_DIR, 'runtime', 'node.exe'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'node';
}

async function ensureServer() {
  control = lifecycle.credentials(APP_DIR, STATE_DIR);
  if (await ping()) {
    let status;
    try { status = await lifecycle.request(PORT, control); }
    catch (e) { control = null; throw e; }
    if (status.code !== 200 || !status.managed) {
      control = null;
      throw new Error('端口已有旧版或独立网页服务，不能安全接管。请手动结束旧实例后重新打开拾念。');
    }
    return;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(path.join(STATE_DIR, 'server.log'), 'a');
  serverProc = spawn(nodeExe(), [path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, ...lifecycle.environment(control), NOTIDEA_UPDATE_HOST_PID: '' },
  });
  fs.closeSync(log);
  serverProc.on('error', (e) => logTray('server spawn failed: ' + e.message));
  serverProc.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await ping()) {
      const status = await lifecycle.request(PORT, control);
      if (status.code !== 200 || !status.managed) {
        control = null;
        throw new Error('端口被其他服务占用，不能安全接管');
      }
      return;
    }
  }
  throw new Error('本地服务没有起来，看看 data/server.log');
}

function loadBounds() {
  const fallback = { width: 1220, height: 860 };
  try {
    if (!fs.existsSync(STATE_FILE)) return fallback;
    const p = fs.readFileSync(STATE_FILE, 'utf8').split(',');
    if (p.length !== 4) return fallback;
    const b = { x: Number(p[0]), y: Number(p[1]), width: Number(p[2]), height: Number(p[3]) };
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return fallback;
    if (b.width < 720 || b.height < 520) return fallback;
    // 上次是在托盘/最小化状态退出的，坐标可能是 -32000，这种直接回默认
    if (b.x < -10000 || b.y < -10000 || b.x > 20000 || b.y > 20000) return fallback;
    return b;
  } catch (e) {
    return fallback;
  }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, [b.x, b.y, b.width, b.height].join(','));
  } catch (e) { /* 记不住也不影响 */ }
}

// 无边框窗口最大化时 Electron 会超出工作区 8px（WS_THICKFRAME 的隐形边框），钳回工作区，避免压住任务栏
function clampMaximized() {
  if (IS_MAC) return;
  if (!win || win.isDestroyed() || !win.isMaximized()) return;
  try {
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const b = win.getBounds();
    if (b.x !== wa.x || b.y !== wa.y || b.width !== wa.width || b.height !== wa.height) win.setBounds(wa);
  } catch (e) { }
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('shell-state', { max: win.isMaximized() }); } catch (e) { }
}

async function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 520,
    frame: IS_MAC,
    show: false,
    icon: path.join(APP_DIR, 'assets', 'icon.png'),
    backgroundColor: BG,
    title: '拾念',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  // ready-to-show 偶尔不触发（窗口会一直藏着），补两道兜底
  const showOnce = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', showOnce);
  win.webContents.on('did-finish-load', showOnce);
  setTimeout(showOnce, 2500);
  win.on('maximize', () => { clampMaximized(); sendState(); });
  win.on('unmaximize', sendState);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', (e) => {
    saveBounds();
    // 没有托盘就别藏窗口，否则用户再也找不回来
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
    if (tray && !trayHintShown) {
      trayHintShown = true;
      try { tray.displayBalloon({ title: '拾念', content: '已缩到托盘，点托盘图标可以再打开；退出请用托盘菜单。' }); } catch (err) { }
    }
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', sendState);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  serverStarting = true;
  try {
    await ensureServer();
    win.loadURL(APP_URL);
  } catch (e) {
    dialog.showErrorBox('拾念', String(e.message || e));
  } finally { serverStarting = false; }
}

ipcMain.handle('pick-dir', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择数据目录',
    defaultPath: current || app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '用这个目录',
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return '';
  return r.filePaths[0];
});

ipcMain.on('shell', (_event, action) => {
  if (!win || win.isDestroyed()) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
  else if (action === 'relaunch') { app.relaunch(); app.exit(0); }
});

function logTray(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'tray.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch (e) { }
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return;
  const ico = path.join(APP_DIR, 'assets', 'notidea.ico');
  const png = path.join(APP_DIR, 'assets', 'icon-32.png');
  let img = nativeImage.createFromPath(IS_MAC ? png : ico);
  if (IS_MAC && !img.isEmpty()) img = img.resize({ width: 18, height: 18 });
  if (img.isEmpty()) img = nativeImage.createFromPath(png);
  try {
    tray = new Tray(img);
    logTray('tray created, empty=' + img.isEmpty());
  } catch (e) {
    tray = null;
    logTray('tray FAILED: ' + (e && e.message));
    return;
  }
  tray.setToolTip('拾念');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 拾念', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: requestQuit },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

if (!IS_MAC) app.setAppUserModelId('com.notidea.app');

app.on('activate', showWindow);
app.whenReady().then(() => {
  if (IS_MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Notidea', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: '退出 Notidea', accelerator: 'Command+Q', click: requestQuit }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  createTray();
  return createWindow();
});

app.on('window-all-closed', () => {
  // 缩到托盘后窗口只是隐藏，这里兜底：真关了窗口也不退出
  if (quitting) app.quit();
});

app.on('before-quit', (e) => {
  if (!quitting) { e.preventDefault(); requestQuit(); return; }
  saveBounds();
});
