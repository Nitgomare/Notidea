'use strict';
// Runs only on a native macOS runner, against the ZIP's actual .app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const lifecycle = require('../lib/shell-lifecycle');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(check, description, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error('Timed out: ' + description);
}
async function main() {
  const arch = process.argv[2];
  assert.equal(process.platform, 'darwin', 'Smoke test requires macOS');
  assert.ok(['arm64', 'x64'].includes(arch));
  assert.equal(process.arch, arch, 'Smoke test must run on the target architecture');
  const root = path.resolve(__dirname, '..');
  const version = require('../version').version;
  const builds = fs.readdirSync(path.join(root, 'dist')).filter(name => name.startsWith(`macos-${version}-${arch}-`));
  assert.equal(builds.length, 1, 'Expected exactly one build in a clean checkout');
  const temp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'notidea-smoke-'));
  const home = path.join(temp, 'home');
  const data = path.join(temp, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  const app = path.join(temp, 'Notidea.app');
  execFileSync('ditto', ['-x', '-k', path.join(root, 'dist', builds[0], 'Notidea.app.zip'), temp]);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const payload = path.join(app, 'Contents', 'Resources', 'app');
  const runtime = path.join(payload, 'runtime', 'node');
  assert.equal(execFileSync(runtime, ['-p', 'process.arch'], { encoding: 'utf8' }).trim(), arch);
  const state = path.join(home, 'Library', 'Application Support', 'Notidea', 'desktop-state');
  const port = await freePort();
  const log = fs.openSync(path.join(temp, 'electron.log'), 'a');
  const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home, NOTIDEA_DATA_DIR: data, PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(app, 'Contents', 'MacOS', 'Electron'), [], {
    cwd: temp, env, detached: true, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  let exited = false;
  let exitCode;
  let launchError;
  child.once('exit', code => { exited = true; exitCode = code; });
  child.once('error', error => { launchError = error; });
  let control;
  try {
    await waitFor(async () => {
      if (launchError) throw launchError;
      assert.equal(exited, false, 'Packaged Electron exited before startup');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1000) });
        if (response.status !== 200) return false;
        assert.equal((await response.json()).version, version);
        return true;
      } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error;
        return false;
      }
    }, 'packaged app /api/version');
    // This also proves Electron respected the temporary HOME for shell state.
    control = JSON.parse(fs.readFileSync(path.join(state, 'shell-control.json'), 'utf8'));
    assert.equal(control.install, fs.realpathSync(payload));
    assert.equal((await lifecycle.request(port, control)).managed, true);
    assert.ok(fs.readdirSync(data).length > 0, 'Server must write only to temporary data directory');
    // Standard macOS Quit event reaches Electron before-quit -> requestQuit.
    // No injected Electron code and no direct server shutdown on the success path.
    execFileSync('osascript', ['-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run', app], { timeout: 15000 });
    await waitFor(() => exited, 'application quit', 15000);
    assert.equal(exitCode, 0, 'Application should quit cleanly');
    await waitFor(async () => {
      try { await lifecycle.request(port, control); return false; }
      catch (error) { return error.code === 'ECONNREFUSED'; }
    }, 'owned backend shutdown', 10000);
    console.log(`PASS packaged macOS ${arch}: ZIP/signature/runtime, startup /api/version ${version}, isolated data/state, native Quit and backend shutdown`);
  } finally {
    // Failure cleanup only targets our own process group and authenticated backend.
    if (control) { try { await lifecycle.request(port, control, 'shutdown'); } catch (_) {} }
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error(error); } }
    console.log('Smoke diagnostics: ' + temp);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
