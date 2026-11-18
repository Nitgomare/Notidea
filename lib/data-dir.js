'use strict';
// 数据目录解析：优先环境变量，其次用户级指针文件，最后使用平台默认目录。
// 指针文件放在 %APPDATA%\notidea\data-dir.txt，和安装目录分开，重装/升级不会动它。
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');

function configDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'notidea');
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
  return require('./platform').defaultDataDir(process.platform, os.homedir(), APP_DIR);
}

function resolve() {
  const env = String(process.env.NOTIDEA_DATA_DIR || '').trim();
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

// 兼容 1.x 的数据库文件名（历史遗留），首次启动自动改名，连同 -wal / -shm
(function migrateDbName() {
  const fresh = path.join(DATA_DIR, 'notidea.db');
  const legacy = path.join(DATA_DIR, 'flomo.db');
  if (fs.existsSync(fresh) || !fs.existsSync(legacy)) return;
  try {
    fs.renameSync(legacy, fresh);
    for (const suffix of ['-wal', '-shm']) {
      const a = legacy + suffix;
      if (fs.existsSync(a)) fs.renameSync(a, fresh + suffix);
    }
  } catch (e) { /* 迁移失败就让上层按旧文件继续用 */ }
})();

module.exports = {
  APP_DIR,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'notidea.db'),
  FILES_DIR: path.join(DATA_DIR, 'files'),
  CONFIG_FILE: configFile(),
  DEFAULT_DIR: defaultDir(),
  ENV_DIR: String(process.env.NOTIDEA_DATA_DIR || '').trim(),
  readPointer,
  setPointer,
  clearPointer,
};
