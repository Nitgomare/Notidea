'use strict';
// 数据目录解析：优先环境变量，其次用户级指针文件，最后回落到程序目录下的 data\
// 指针文件放在 %APPDATA%\flomo-local\data-dir.txt，和安装目录分开，重装/升级不会动它。
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');

function configDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'flomo-local');
}

function configFile() {
  return path.join(configDir(), 'data-dir.txt');
}

function readPointer() {
  try {
    const f = configFile();
    if (!fs.existsSync(f)) return '';
    const s = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').trim();
    return s || '';
  } catch (e) {
    return '';
  }
}

function defaultDir() {
  return path.join(APP_DIR, 'data');
}

function resolve() {
  const env = String(process.env.FLOMO_DATA_DIR || '').trim();
  if (env) return path.resolve(env);
  const p = readPointer();
  if (p) {
    try {
      if (fs.existsSync(p)) return path.resolve(p);
    } catch (e) { /* 路径无效就回落 */ }
  }
  return defaultDir();
}

function setPointer(dir) {
  const target = path.resolve(String(dir || '').trim());
  if (!target) throw new Error('路径为空');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configFile(), target, 'utf8');
  return target;
}

function clearPointer() {
  try {
    const f = configFile();
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (e) { /* 忽略 */ }
}

const DATA_DIR = resolve();
fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  APP_DIR,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'flomo.db'),
  FILES_DIR: path.join(DATA_DIR, 'files'),
  CONFIG_FILE: configFile(),
  DEFAULT_DIR: defaultDir(),
  ENV_DIR: String(process.env.FLOMO_DATA_DIR || '').trim(),
  readPointer,
  setPointer,
  clearPointer,
};
