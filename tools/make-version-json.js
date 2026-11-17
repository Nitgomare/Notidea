'use strict';
// 生成仓库根目录的 version.json —— 供旧版本客户端「检查更新」拉取
// 用法：node tools/make-version-json.js [notes]
const fs = require('fs');
const path = require('path');
const { version } = require('../version');

const root = path.join(__dirname, '..');
const notes = process.argv.slice(2).join(' ') || '';
const data = {
  version,
  notes,
  url: 'https://github.com/Nitgomare/Notidea/releases/latest',
  released_at: new Date().toISOString().slice(0, 10),
};
const file = path.join(root, 'version.json');
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('wrote ' + file + ' -> ' + version);
