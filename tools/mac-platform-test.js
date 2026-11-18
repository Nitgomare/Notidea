'use strict';
// Pure VM tests: no real data-directory access, network, server, or child process.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const platformSource = fs.readFileSync(path.join(root, 'lib/platform.js'), 'utf8');
const dataSource = fs.readFileSync(path.join(root, 'lib/data-dir.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function loadData(platform, env = {}, pointer = '', existing = []) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\test' : '/Users/test';
  const app = platform === 'win32' ? 'C:\\Notidea' : '/Applications/Notidea.app/Contents/Resources/app';
  const writes = [];
  const fakeFs = {
    existsSync: p => p.endsWith('data-dir.txt') ? !!pointer : existing.includes(p),
    readFileSync: () => pointer,
    mkdirSync: p => writes.push(p),
    writeFileSync: (p, text) => writes.push([p, text]),
  };
  const process = { platform, env, cwd: () => app };
  const modules = { fs: fakeFs, path: paths, os: { homedir: () => home }, child_process: {} };
  const pctx = { module: { exports: {} }, require: name => modules[name], process };
  vm.runInNewContext(platformSource, pctx);
  modules['./platform'] = pctx.module.exports;
  const ctx = { module: { exports: {} }, require: name => modules[name], process, __dirname: paths.join(app, 'lib') };
  vm.runInNewContext(dataSource, ctx);
  return { data: ctx.module.exports, writes, platform: modules['./platform'] };
}

function loadServer(platform) {
  const effects = [];
  const fail = name => () => { effects.push(name); throw new Error('Unexpected ' + name); };
  const modules = {
    http: {}, child_process: { spawn: fail('spawn') }, path: path.posix, url: { URL },
    fs: { existsSync: () => true, mkdirSync: fail('mkdir'), writeFileSync: fail('write'), rmSync: fail('remove') },
    './db': {}, './version': { version: '3.2.2' }, './lib/platform': {}, './llm': {},
    './lib/data-dir': { DATA_DIR: '/Users/test/Library/Application Support/Notidea', DB_FILE: '/mock/notidea.db', FILES_DIR: '/mock/files' },
    './lib/shell-lifecycle': { createService: () => ({ beginUpdate: fail('beginUpdate') }) },
  };
  const ctx = {
    require: name => { assert.ok(name in modules, name); return modules[name]; },
    process: { platform, env: {} }, __dirname: '/Applications/Notidea.app/Contents/Resources/app',
    URL, console, setTimeout: fail('timer'), Date,
    fetch: fail('network'),
  };
  // Exclude only the listener/startup tail; execute actual routing and update functions.
  vm.runInNewContext(serverSource.slice(0, serverSource.indexOf('const server = http.createServer')), ctx);
  vm.runInNewContext('fetchLatestInfo = async () => ({version: "3.2.3", notes: "test", url: UPDATE_RELEASE_URL})', ctx);
  return { ctx, effects };
}

async function request(ctx, url, method) {
  let status, body;
  const res = { writeHead: code => { status = code; }, end: value => { body = JSON.parse(value); } };
  await ctx.route({ url, method }, res);
  return { status, body };
}

(async () => {
  const mac = loadData('darwin');
  assert.equal(mac.data.DATA_DIR, '/Users/test/Library/Application Support/Notidea');
  assert.equal(mac.data.CONFIG_FILE, '/Users/test/.config/notidea/data-dir.txt');
  assert.ok(mac.writes.every(p => !p.startsWith('/Applications/')));
  const custom = loadData('darwin', {}, '\ufeff/Volumes/Notes\n', ['/Volumes/Notes']);
  assert.equal(custom.data.DATA_DIR, '/Volumes/Notes');
  assert.equal(loadData('darwin', { NOTIDEA_DATA_DIR: '/Volumes/Env' }, '/Volumes/Notes', ['/Volumes/Notes']).data.DATA_DIR, '/Volumes/Env');
  assert.equal(loadData('darwin', {}, '/missing').data.DATA_DIR, mac.data.DATA_DIR);
  assert.equal(loadData('win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }).data.DATA_DIR, 'C:\\Notidea\\data');
  assert.equal(loadData('win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }).data.CONFIG_FILE, 'C:\\Users\\test\\AppData\\Roaming\\notidea\\data-dir.txt');
  custom.data.setPointer('/Volumes/New');
  assert.ok(custom.writes.some(p => Array.isArray(p) && p[0] === custom.data.CONFIG_FILE && p[1] === '/Volumes/New'));
  assert.equal(mac.platform.openCommand('darwin', '/tmp/a b').cmd, 'open');
  assert.equal(mac.platform.openCommand('darwin', '/tmp/a b').args[0], '/tmp/a b');

  const { ctx, effects } = loadServer('darwin');
  const check = await request(ctx, '/api/update/check', 'GET');
  assert.equal(check.status, 200);
  assert.equal(check.body.hasUpdate, true);
  assert.equal(check.body.asset, '');
  assert.equal(check.body.manualUpdate, true);
  const apply = await request(ctx, '/api/update/apply', 'POST');
  assert.equal(apply.status, 400);
  assert.equal(apply.body.manualUpdate, true);
  assert.match(apply.body.url, /github\.com\/Nitgomare\/Notidea\/releases\/latest$/);
  assert.match(apply.body.error, /退出.*手动替换.*保留/);
  const shortcut = await request(ctx, '/api/shortcut', 'POST');
  assert.equal(shortcut.status, 400);
  assert.match(shortcut.body.error, /Dock/);
  await assert.rejects(ctx.downloadUpdate({ latest: '3.2.3' }), /macOS/);
  assert.throws(() => ctx.writeApplyShell('/mock/app.zip'), /macOS/);
  assert.deepEqual(effects, []);
  const win = await request(loadServer('win32').ctx, '/api/update/check', 'GET');
  assert.match(win.body.asset, /notidea-3\.2\.3-app\.zip$/);
  assert.equal(win.body.manualUpdate, undefined);
  console.log('PASS macOS data/pointer/env, safe manual updates, shortcuts, Windows defaults/assets (isolated VM)');
})().catch(error => { console.error(error); process.exitCode = 1; });
