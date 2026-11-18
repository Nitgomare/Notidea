'use strict';
/**
 * 跨平台小工具：浏览器路径、应用数据目录、打开文件、桌面路径。
 * 全部函数都显式接收 platform 参数（默认 process.platform），方便在 Windows 上单测 darwin 分支。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const APP_DIR = 'notidea';

/** macOS 应用包不可写；数据保存在用户目录，Windows 保持便携版布局。 */
function defaultDataDir(platform = process.platform, home = os.homedir(), root = process.cwd()) {
  return platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Notidea')
    : path.join(root, 'data');
}

/** Chrome/Edge 可执行文件的候选路径，按优先级排列 */
function browserCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    return [
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    const local = path.join(home, 'Applications');
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(local, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(local, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

function findBrowser(platform = process.platform) {
  for (const p of browserCandidates(platform)) {
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

/** 浏览器独立 profile 目录（Windows 用 LOCALAPPDATA，macOS 用 Application Support） */
function profileDir(platform = process.platform, env = process.env, home = os.homedir(), root = process.cwd()) {
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(root, 'data'), APP_DIR, 'edge-profile');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR, 'edge-profile');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_DIR, 'edge-profile');
}

/** 打开文件/URL 的命令（macOS 用 open，Linux 用 xdg-open，Windows 用 start） */
function openCommand(platform = process.platform, target = '') {
  if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/c', 'start', '""', target], windowsHide: true };
  if (platform === 'darwin') return { cmd: 'open', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}

/** 打开文件/URL（不阻塞、不等待） */
function openPath(target, platform = process.platform) {
  const c = openCommand(platform, target);
  try {
    spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: c.windowsHide !== false }).unref();
    return true;
  } catch (e) {
    return false;
  }
}

/** 桌面目录（macOS 有 ~/Desktop，Linux 走 XDG） */
function desktopDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Desktop');
  if (platform === 'win32') return path.join(env.USERPROFILE || home, 'Desktop');
  return path.join(env.XDG_DESKTOP_DIR || path.join(home, 'Desktop'));
}

module.exports = { APP_DIR, defaultDataDir, browserCandidates, findBrowser, profileDir, openCommand, openPath, desktopDir };
