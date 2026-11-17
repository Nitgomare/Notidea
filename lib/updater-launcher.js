'use strict';
const path = require('path');
const { spawn } = require('child_process');

// A detached Windows PowerShell can silently exit before running its script.
// Give it a detached Node host which stays alive until PowerShell completes.
const WINDOWS_HOST = String.raw`
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const script = process.argv[1];
const log = fs.openSync(path.join(path.dirname(script), 'launcher.log'), 'a');
const say = message => fs.writeSync(log, new Date().toISOString() + ' ' + message + '\n');
const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
say('host pid=' + process.pid);
const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
  cwd: process.cwd(), detached: false, windowsHide: true, stdio: ['ignore', log, log]
});
child.once('spawn', () => say('powershell pid=' + child.pid));
child.once('error', error => { say('spawn ERROR: ' + error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { say('powershell exit=' + code + ' signal=' + signal); process.exitCode = code === 0 ? 0 : 1; });
`;

function launchUpdater(script, cwd, windows = process.platform === 'win32') {
  return spawn(windows ? process.execPath : '/bin/sh',
    windows ? ['-e', WINDOWS_HOST, path.resolve(script)] : [script],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd });
}
module.exports = { launchUpdater };
