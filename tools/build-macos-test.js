'use strict';
// Offline contract tests: no downloads, signing, app launch, or macOS claims.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(__dirname, 'build-macos.sh'), 'utf8');
let tests = 0;
function test(name, fn) { fn(); tests++; console.log(`PASS ${name}`); }

test('package and authoritative app version agree', () => {
  const pkg = require(path.join(root, 'package.json'));
  assert.equal(pkg.main, 'electron/main.js');
  assert.equal(pkg.version, require(path.join(root, 'version.js')).version);
  assert.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+$/);
});
test('explicit source whitelist exists and excludes development/user state', () => {
  const names = script.match(/^sources=\(([^)]+)\)$/m)[1].split(' ');
  assert.deepEqual(names, ['lib', 'electron', 'public', 'assets', 'prompts', 'server.js', 'db.js', 'llm.js', 'version.js', 'package.json', 'README.md', 'LICENSE']);
  for (const name of names) assert.ok(fs.existsSync(path.join(root, name)), name);
  assert.ok(fs.existsSync(path.join(root, 'assets/icon.png')));
});
test('checksum parser rejects missing, duplicate and non-exact names', () => {
  // Execute the actual embedded Node parser with an in-memory manifest.
  const code = script.match(/expected="\$\(node -e '([^']+)'/)[1];
  const digest = 'a'.repeat(64);
  function parse(manifest, name) {
    let result;
    vm.runInNewContext(code, {
      require: id => { assert.equal(id, 'node:fs'); return { readFileSync: () => manifest }; },
      process: { argv: ['node', 'manifest', name] },
      console: { log: value => { result = value; } }
    });
    return result;
  }
  assert.equal(parse(`${digest}  file.zip\r\n`, 'file.zip'), digest);
  assert.equal(parse(`${digest.toUpperCase()} *file.zip\n`, 'file.zip'), digest);
  assert.throws(() => parse(`${digest}  other-file.zip\n`, 'file.zip'), /Missing\/duplicate/);
  assert.throws(() => parse(`${digest}  file.zip\n${digest}  file.zip`, 'file.zip'), /Missing\/duplicate/);
  assert.throws(() => parse('not-a-hash  file.zip', 'file.zip'), /Missing\/duplicate/);
});
test('download verification precedes extraction', () => {
  assert.ok(script.indexOf('verify "$work/downloads/electron-SHASUMS256.txt"') < script.indexOf('ditto -x -k'));
  assert.ok(script.indexOf('verify "$work/downloads/node-SHASUMS256.txt"') < script.indexOf('tar -xzf'));
  assert.match(script, /\[ "\$\{actual%% \*\}" = "\$expected" \] \|\| fail/);
  assert.match(script, /--proto '=https' --proto-redir '=https'/);
});
test('cleanup cannot target user-selected paths', () => {
  assert.equal((script.match(/\brm\b/g) || []).length, 1);
  assert.match(script, /work="\$\(mktemp -d \/private\/tmp\/notidea-macos\.XXXXXXXX\)"/);
  assert.match(script, /case "\$work" in \/private\/tmp\/notidea-macos\.\?\?\?\?\?\?\?\?/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /out="\$\(mktemp -d "\$root\/dist\/macos-/);
});
test('macOS archive, architecture, icon and ad-hoc signing contracts', () => {
  for (const text of ['arm64|x64', '^24\\.[0-9]+\\.[0-9]+$', 'lipo -verify_arch', 'runtime/node', 'iconutil -c icns', 'CFBundleDisplayName Notidea', 'CFBundleIdentifier app.notidea.desktop', 'codesign --force --deep --sign - --preserve-metadata=entitlements', 'codesign --verify --deep --strict', 'ditto -c -k --sequesterRsrc --keepParent', 'hdiutil verify', 'NOT Developer ID signed or notarized']) assert.ok(script.includes(text), text);
});
console.log(`${tests} offline packaging contract tests passed; real macOS build/launch is NOT tested.`);
