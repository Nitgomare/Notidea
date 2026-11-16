'use strict';
// 生成 prompts/insights/*.md：数据在 tools/perspectives-a.js(复盘整理+自我觉察) 与 -b.js(思维决策+大师视角)
// 用法：node tools/build-insights.js
const fs = require('fs');
const path = require('path');

const list = [...require('./perspectives-a'), ...require('./perspectives-b')];
const OUT = path.join(__dirname, '..', 'prompts', 'insights');

const yaml = (v) => (String(v).includes(':') ? `"${String(v).replace(/"/g, '\\"')}"` : String(v));

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const p of list) {
  const head = [
    '---',
    `name: ${yaml(p.name)}`,
    `author: ${yaml(p.author)}`,
    `category: ${yaml(p.cat)}`,
    `range: ${yaml(p.range)}`,
    `days: ${p.days || 0}`,
    `icon: ${p.icon || '✧'}`,
    `order: ${p.order}`,
    ...(p.badge ? [`badge: ${p.badge}`] : []),
    `description: ${yaml(p.desc)}`,
    `system: ${yaml(p.sys)}`,
    '---',
    '',
    p.body.trim(),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, p.id + '.md'), head, 'utf8');
  n++;
}
console.log(`wrote ${n} perspectives to ${OUT}`);
console.log(list.map((p) => `${p.cat}/${p.name}`).join('\n'));
