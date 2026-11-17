'use strict';
// 生成 prompts/insights/*.md：数据在 tools/perspectives-a.js(复盘整理+自我觉察) 与 -b.js(思维决策+大师视角)
// 用法：node tools/build-insights.js
const fs = require('fs');
const path = require('path');

const list = [...require('./perspectives-a'), ...require('./perspectives-b')];
const OUT = path.join(__dirname, '..', 'prompts', 'insights');

// 所有视角共用的写法，追加在正文末尾
const STYLE = `写法：
- 直接对我说话，用「你」。像熟人发微信，口语，句子有长有短。
- 只说从笔记里看得出来的，多用笔记里的具体事和原话（原话用「」，引短一点）。看不出来就直说，别凑数。
- 开头直接进正题，说完就停。不总结，不升华，不祝福。
- 不加标题，不加粗，不用 emoji，不用破折号。确实要并列时才用短列表。
- 说事就说事本身，一句话一个意思，不写成对的对照句。`;

// 每张卡的字数上限（字 ≈ 汉字字符）
const CAP = {
  'aristotle': 500,
  'munger': 500,
  'seneca': 500,
  'tasha': 500,
  'mbti': 450,
  'cbt': 450,
  'default': 450,
  'main-contradiction': 450,
  'second-order': 450,
  'flywheel': 450,
  'key-people': 450,
  'soul-questions': 180,
  'friend-view': 320,
  'act': 350,
  'action-guide': 350,
  'blind-spot': 350,
  'counterintuitive': 350,
  'deep-question': 350,
  'director-view': 350,
  'energy-map': 350,
  'friendship': 350,
  'meaning-radar': 350,
  'resource-mining': 350,
  'reverse': 350,
  'theme-extend': 350,
  'values': 350,
};

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
    STYLE,
    ...(CAP[p.id] ? ['- 整段不超过 ' + CAP[p.id] + ' 字，超了就删掉不重要的句子，别整段铺开。'] : []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, p.id + '.md'), head, 'utf8');
  n++;
}
console.log(`wrote ${n} perspectives to ${OUT}`);
console.log(list.map((p) => `${p.cat}/${p.name}`).join('\n'));
