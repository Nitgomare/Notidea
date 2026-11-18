'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lifecycle = require('../lib/shell-lifecycle');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
test('shell credentials can live outside read-only application bundle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notidea-mac-shell-'));
  try {
    const app = path.join(root, 'Notidea.app'); fs.mkdirSync(app);
    const state = path.join(root, 'Application Support', 'desktop-state');
    const first = lifecycle.credentials(app, state);
    assert.deepEqual(lifecycle.credentials(app, state), first);
    assert.equal(fs.existsSync(path.join(app, 'data')), false);
    assert.equal(first.install, process.platform === 'win32' ? fs.realpathSync(app).toLowerCase() : fs.realpathSync(app));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Mac shell declares bundled runtime and native menu/window contracts', () => {
  assert.match(main, /IS_MAC \? \[path.join\(APP_DIR, 'runtime', 'node'\)\]/);
  assert.match(main, /frame: IS_MAC/);
  assert.match(main, /accelerator: 'Command\+Q', click: requestQuit/);
  assert.match(main, /app.on\('activate', showWindow\)/);
  assert.match(main, /lifecycle.credentials\(APP_DIR, STATE_DIR\)/);
  assert.match(main, /if \(IS_MAC\) return;/);
});
