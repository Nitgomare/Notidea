'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const CONTROL_PATH = '/api/shell-control';
function identity(root) {
  const resolved = fs.realpathSync(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function credentials(root, stateDir = path.join(root, 'data')) {
  const install = identity(root);
  const file = path.join(stateDir, 'shell-control.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.install === install && /^[a-f0-9]{64}$/.test(value.token)) return value;
    throw new Error('桌面控制凭据无效，请在退出旧实例后移除 data/shell-control.json');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = { install, token: crypto.randomBytes(32).toString('hex') };
    try { fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') return credentials(root); throw e; }
    return value;
  }
}
function environment(value) {
  return { NOTIDEA_SHELL_INSTALL: value.install, NOTIDEA_SHELL_TOKEN: value.token };
}
function request(port, value, action = 'status') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: CONTROL_PATH,
      method: action === 'shutdown' ? 'POST' : 'GET', timeout: 1500,
      headers: { Authorization: 'Bearer ' + value.token, 'X-Notidea-Install': encodeURIComponent(value.install) } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(new Error('控制响应过大')); });
      res.on('end', () => {
        try { resolve({ code: res.statusCode, ...JSON.parse(body) }); }
        catch (_) { reject(new Error('服务不支持安全退出协议，请手动结束旧实例后重新打开拾念')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('服务正在更新交接或无响应，请稍后退出')));
    req.end();
  });
}
function createService(root, env = process.env) {
  const install = identity(root);
  const token = env.NOTIDEA_SHELL_INSTALL === install && /^[a-f0-9]{64}$/.test(env.NOTIDEA_SHELL_TOKEN || '') ? env.NOTIDEA_SHELL_TOKEN : null;
  let updating = false;
  let stopping = false;
  let updateHostFinished = false;
  function busy() {
    if (updating) return true;
    const pid = Number(env.NOTIDEA_UPDATE_HOST_PID);
    if (updateHostFinished || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { if (e.code === 'ESRCH') { updateHostFinished = true; return false; } return true; }
  }
  function beginUpdate() { if (stopping || busy()) return false; updating = true; return true; }
  function endUpdate() { updating = false; }
  function handle(req, res, stop) {
    if (req.url.split('?')[0] !== CONTROL_PATH) return false;
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const supplied = String(req.headers.authorization || '');
    const expected = 'Bearer ' + token;
    if (!token || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ||
        req.headers['x-notidea-install'] !== encodeURIComponent(install) || req.headers.origin) {
      reply(403, { error: 'Forbidden' }); return true;
    }
    if (!['GET', 'POST'].includes(req.method)) { reply(405, { error: 'Method not allowed' }); return true; }
    if (req.method === 'GET') { reply(200, { managed: true, busy: busy(), stopping }); return true; }
    if (busy()) { reply(409, { error: '更新正在执行，请稍后退出', busy: true }); return true; }
    if (!stopping) {
      stopping = true;
      res.once('finish', stop);
    }
    reply(200, { ok: true });
    return true;
  }
  return { handle, beginUpdate, endUpdate };
}
module.exports = { credentials, environment, request, createService };
