'use strict';
// Executes the production-generated Windows updater against disposable services only.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const net = require('net');
const http = require('http');
const assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const generator = source.slice(source.indexOf('function writeApplyScript('), source.indexOf('function writeApplyShell('));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const q = s => "'" + s.replace(/'/g, "''") + "'";
function ps(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  assert.notEqual(port, 7777);
  return port;
}
function request(port, route = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: route, timeout: 500 }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(body));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function waitVersion(port, version) {
  for (let i = 0; i < 80; i++) {
    try { if (await request(port) === version) return; } catch {}
    await sleep(100);
  }
  throw new Error('service did not return ' + version);
}
async function runCase(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '拾念 更新测试 ' + name + ' '));
  const port = await freePort();
  const update = path.join(root, 'data', 'update');
  fs.mkdirSync(update, { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'data', 'keep.txt'), 'user-data');
  fs.writeFileSync(path.join(root, 'runtime', 'keep.txt'), 'bundled-runtime');
  const serverCode = version => `require('http').createServer((req,res)=>{res.end(${JSON.stringify(version)});if(req.url==='/stop')setTimeout(()=>process.exit(0),50)}).listen(${port},'127.0.0.1');`;
  fs.writeFileSync(path.join(root, 'server.js'), serverCode('old'));
  fs.writeFileSync(path.join(root, 'version.json'), '{"version":"old"}');
  const zip = path.join(update, 'app.zip');
  if (name === 'bad-zip') fs.writeFileSync(zip, 'not a zip');
  else {
    const payload = path.join(root, 'payload');
    fs.mkdirSync(path.join(payload, 'data'), { recursive: true });
    fs.mkdirSync(path.join(payload, 'runtime'));
    fs.writeFileSync(path.join(payload, 'server.js'), serverCode('new'));
    fs.writeFileSync(path.join(payload, 'version.json'), '{"version":"new"}');
    fs.writeFileSync(path.join(payload, 'data', 'keep.txt'), 'MUST NOT COPY');
    fs.writeFileSync(path.join(payload, 'runtime', 'keep.txt'), 'MUST NOT COPY');
    if (name === 'copy-fail') {
      fs.writeFileSync(path.join(root, 'blocked.txt'), 'old');
      fs.writeFileSync(path.join(payload, 'blocked.txt'), 'new file that cannot replace a locked destination');
    }
    ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${q(payload)}, ${q(zip)})`);
  }
  const context = { fs, path, __dirname: root, process: { execPath: process.execPath }, PORT: port };
  vm.createContext(context);
  const script = vm.runInContext(generator + '\nwriteApplyScript(' + JSON.stringify(zip) + ')', context);
  let old, lock;
  try {
    if (name === 'copy-fail') {
      const ready = path.join(root, 'lock-ready');
      lock = spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open(${q(path.join(root, 'blocked.txt'))}, 'Open', 'ReadWrite', 'None'); [IO.File]::WriteAllText(${q(ready)}, 'ready'); try { Start-Sleep -Seconds 90 } finally { $f.Dispose() }`], { stdio: 'inherit' });
      for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await sleep(100);
      assert.ok(fs.existsSync(ready), 'destination lock acquired');
    }
    old = spawn(process.execPath, [path.join(root, 'server.js')], { stdio: 'ignore' });
    await waitVersion(port, 'old');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (name !== 'busy-port') { await sleep(500); await request(port, '/stop'); }
    const code = await exited;
    assert.equal(code, name === 'success' ? 0 : 1, 'updater exit status');
    if (name !== 'copy-fail') await waitVersion(port, name === 'success' ? 'new' : 'old');
    assert.equal(fs.readFileSync(path.join(root, 'data', 'keep.txt'), 'utf8'), 'user-data');
    assert.equal(fs.readFileSync(path.join(root, 'runtime', 'keep.txt'), 'utf8'), 'bundled-runtime');
    assert.equal(fs.existsSync(zip), name !== 'success', 'only success removes zip');
    const log = fs.readFileSync(path.join(update, 'apply.log'), 'utf8');
    if (name === 'bad-zip') { assert.match(log, /extract FAILED/); assert.doesNotMatch(log, /robocopy exit=/); assert.match(log, /old service restarted/); }
    if (name === 'busy-port') { assert.match(log, /port wait timeout/); assert.equal(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), serverCode('old')); }
    if (name === 'copy-fail') {
      assert.match(log, /copy FAILED: robocopy failed:/);
      assert.doesNotMatch(log, /update SUCCESS|old service restarted/);
      assert.match(log, /manual recovery may be required/);
    }
    if (name === 'success') assert.match(log, /update SUCCESS/);
    console.log('PASS ' + name + ': port=' + port + ', evidence=' + root);
  } finally {
    try { await request(port, '/stop'); } catch {}
    if (old && old.exitCode === null) old.kill();
    if (lock && lock.exitCode === null) lock.kill();
  }
}
(async () => {
  assert.equal(process.platform, 'win32', 'Windows only');
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['bad-zip', 'success', 'copy-fail', 'busy-port']) {
    assert.ok(['bad-zip', 'success', 'copy-fail', 'busy-port'].includes(name));
    await runCase(name);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
