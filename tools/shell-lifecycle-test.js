'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const lifecycle = require('../lib/shell-lifecycle');

if (process.argv[2] === 'fixture') {
  const service = lifecycle.createService(process.argv[3]);
  const server = http.createServer((req, res) => {
    if (!service.handle(req, res, () => server.close(() => process.exit(0)))) { res.writeHead(404); res.end('{}'); }
  });
  process.on('message', action => {
    if (action === 'busy') process.send({ busy: service.beginUpdate() });
    if (action === 'idle') { service.endUpdate(); process.send({ idle: true }); }
    if (action === 'handoff') process.exit(0);
  });
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
} else {
  const once = (emitter, event) => new Promise(resolve => emitter.once(event, resolve));
  async function fixture(t, root, env) {
    const child = fork(__filename, ['fixture', root], { env: { ...process.env, NOTIDEA_SHELL_TOKEN: '', NOTIDEA_SHELL_INSTALL: '', NOTIDEA_UPDATE_HOST_PID: '', ...env }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const { port } = await once(child, 'message');
    return { child, port };
  }
  function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notidea-control-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
  test('authenticated shutdown, unauthorized and different-install requests rejected', async t => {
    const root = temp(t), value = lifecycle.credentials(root);
    assert.deepEqual(lifecycle.credentials(root), value);
    const { child, port } = await fixture(t, root, lifecycle.environment(value));
    assert.equal((await lifecycle.request(port, { ...value, token: '0'.repeat(64) }, 'shutdown')).code, 403);
    assert.equal((await lifecycle.request(port, { ...value, install: root + '-other' }, 'shutdown')).code, 403);
    const raw = headers => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/shell-control', method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(await raw({}), 403);
    assert.equal(await raw({ Authorization: 'Bearer ' + value.token, 'X-Notidea-Install': encodeURIComponent(value.install), Origin: 'http://evil.invalid' }), 403);
    assert.equal((await lifecycle.request(port, value)).managed, true);
    const exit = once(child, 'exit');
    assert.equal((await lifecycle.request(port, value, 'shutdown')).ok, true);
    assert.equal(await exit, 0);
  });
  test('standalone web service cannot be adopted or stopped', async t => {
    const root = temp(t), value = lifecycle.credentials(root);
    const { child, port } = await fixture(t, root, {});
    assert.equal((await lifecycle.request(port, value, 'shutdown')).code, 403);
    assert.equal(child.exitCode, null);
  });
  test('update busy refuses shutdown; replacement inherits lifecycle and exits', async t => {
    const root = temp(t), value = lifecycle.credentials(root), env = lifecycle.environment(value);
    const first = await fixture(t, root, env);
    let message = once(first.child, 'message'); first.child.send('busy'); assert.equal((await message).busy, true);
    assert.equal((await lifecycle.request(first.port, value, 'shutdown')).code, 409);
    assert.equal(first.child.exitCode, null);
    const oldExit = once(first.child, 'exit'); first.child.send('handoff'); await oldExit;
    const replacement = await fixture(t, root, env);
    const exit = once(replacement.child, 'exit');
    assert.equal((await lifecycle.request(replacement.port, value, 'shutdown')).ok, true);
    assert.equal(await exit, 0);
  });
  test('live updater host prevents replacement shutdown', async t => {
    const root = temp(t), value = lifecycle.credentials(root);
    const { port } = await fixture(t, root, { ...lifecycle.environment(value), NOTIDEA_UPDATE_HOST_PID: String(process.pid) });
    assert.equal((await lifecycle.request(port, value, 'shutdown')).code, 409);
  });
  test('shutdown admission blocks concurrent update admission', async t => {
    const root = temp(t), value = lifecycle.credentials(root);
    const service = lifecycle.createService(root, lifecycle.environment(value));
    const server = http.createServer((req, res) => service.handle(req, res, () => {}));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    assert.equal((await lifecycle.request(server.address().port, value, 'shutdown')).ok, true);
    assert.equal(service.beginUpdate(), false);
  });
}
