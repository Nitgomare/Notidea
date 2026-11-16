'use strict';
/**
 * 桌面壳启动器（WebView2 / Edge --app 模式）
 * 1) 确保本地服务在跑（不在就拉起 node server.js）
 * 2) 用 Edge 的应用窗口打开它 —— 和 WebView2 同一个内核，但不额外占 300MB
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 7777;
const URL = 'http://127.0.0.1:' + PORT;
const PROFILE = path.join(process.env.LOCALAPPDATA || path.join(ROOT, 'data'), 'flomolocal', 'edge-profile');

function ping() {
  return new Promise((resolve) => {
    const req = http.get(URL + '/api/bootstrap', { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureServer() {
  if (await ping()) return;
  // 首次运行还没有 data/，server.js 建目录要晚于这里的日志文件
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const log = fs.openSync(path.join(ROOT, 'data', 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    if (await ping()) return;
  }
  throw new Error('服务没有起来，看看 data/server.log');
}

function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return '';
}

(async () => {
  try {
    await ensureServer();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const edge = findEdge();
  if (!edge) {
    // 没装 Edge：退回系统默认浏览器，笔记功能照常
    spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log('没找到 Edge，已用默认浏览器打开 ' + URL);
    process.exit(0);
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [
    '--app=' + URL,
    '--window-size=1220,860',
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeIdentityFRE,msImplicitSignin',
  ];
  const win = spawn(edge, args, { detached: true, stdio: 'ignore', windowsHide: false });
  win.unref();
  process.exit(0);
})();
