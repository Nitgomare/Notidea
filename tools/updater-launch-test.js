'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows-only process-chain test');
  const electron = process.argv[2];
  if (!electron || !fs.existsSync(electron)) throw new Error('Usage: node tools/updater-launch-test.js <Electron executable>');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '拾念 更新启动测试 (空格)-'));
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const launcher = path.resolve(__dirname, '../lib/updater-launcher.js');
  const worker = path.join(root, 'worker.cjs');
  const service = path.join(root, 'service.cjs');
  const script = path.join(root, 'safe.ps1');
  const entry = path.join(root, 'main.cjs');
  fs.writeFileSync(service, `const fs=require('fs'),http=require('http'),path=require('path');
const server=http.createServer((req,res)=>{res.end(JSON.stringify({version:'3.2.1',pid:process.pid}));if(req.url==='/stop')server.close();});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(__dirname,'port'),String(server.address().port)));
setTimeout(()=>server.close(),15000).unref();`);
  fs.writeFileSync(script, '\uFEFF' + `$ErrorActionPreference = 'Stop'\r\n[IO.File]::WriteAllText(${quote(path.join(root, 'ready'))}, 'ready')\r\nStart-Sleep -Milliseconds 2200\r\n$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ('"' + ${quote(service)} + '"') -WorkingDirectory ${quote(root)} -WindowStyle Hidden -RedirectStandardOutput ${quote(path.join(root, 'service.out'))} -RedirectStandardError ${quote(path.join(root, 'service.err'))} -PassThru\r\nStart-Sleep -Milliseconds 500\r\n[IO.File]::WriteAllText(${quote(path.join(root, 'done'))}, ('pid=' + $p.Id))\r\n`);
  fs.writeFileSync(worker, `const fs=require('fs');const {launchUpdater}=require(${JSON.stringify(launcher)});const child=launchUpdater(${JSON.stringify(script)},${JSON.stringify(root)});child.once('error',e=>{console.error(e);process.exit(1)});child.once('spawn',()=>{child.unref();setTimeout(()=>{fs.writeFileSync(${JSON.stringify(path.join(root, 'old-exit'))},String(process.pid));process.exit(0)},300)});`);
  fs.writeFileSync(entry, `const {app}=require('electron');const {spawn}=require('child_process');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(worker)}],{cwd:${JSON.stringify(root)},windowsHide:true,stdio:'ignore'});child.once('exit',()=>setTimeout(()=>app.exit(0),400));setTimeout(()=>app.exit(2),10000);`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const electronLog = fs.openSync(path.join(root, 'electron.log'), 'a');
  const child = spawn(path.resolve(electron), [entry], { env, windowsHide: true, stdio: ['ignore', electronLog, electronLog] });
  const electronExit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Electron exit ' + code))); });
  try {
    await electronExit;
    for (let i = 0; i < 120; i++) {
      if (fs.existsSync(path.join(root, 'launcher.log')) && fs.readFileSync(path.join(root, 'launcher.log'), 'utf8').includes('powershell exit=0')) break;
      await delay(100);
    }
    const log = fs.readFileSync(path.join(root, 'launcher.log'), 'utf8');
    assert(log.includes('powershell exit=0'), log);
    assert(fs.existsSync(path.join(root, 'old-exit')));
    assert(fs.existsSync(path.join(root, 'done')));
    // Host has no remaining handles after logging PowerShell exit; wait beyond that turn.
    await delay(500);
    const port = Number(fs.readFileSync(path.join(root, 'port'), 'utf8'));
    assert(port > 0 && port !== 7777);
    const get = route => new Promise((resolve, reject) => { const req = http.get({ hostname: '127.0.0.1', port, path: route, timeout: 2000 }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(JSON.parse(body))); }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTP timeout'))); });
    const result = await get('/version');
    assert.strictEqual(result.version, '3.2.1');
    await get('/stop');
    console.log(JSON.stringify({ ok: true, root, port, result, log }, null, 2));
  } finally { fs.closeSync(electronLog); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
