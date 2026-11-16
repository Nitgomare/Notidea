'use strict';
/**
 * tools/import-flomo.js — 把 flomo 云端笔记导入本地库（一次性迁移用，可选）
 *
 * 用法：
 *   node tools/import-flomo.js                 # 自动读 %APPDATA%\flomo卡片笔记\config.json 的 token
 *   node tools/import-flomo.js --dry           # 只统计，不写库
 *   node tools/import-flomo.js --token=xxxx    # 指定 token
 *   node tools/import-flomo.js --since=2026-01-01
 *
 * 说明：只读取你自己的账号（GET /api/v1/memo/updated/），不做任何写操作。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const dbm = require('../db');
const { api } = require('../lib/flomo-api');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  })
);

function readToken() {
  if (args.token) return String(args.token);
  if (process.env.FLOMO_TOKEN) return process.env.FLOMO_TOKEN;
  const candidates = [
    path.join(process.env.APPDATA || '', 'flomo卡片笔记', 'config.json'),
    path.join(os.homedir(), 'Library/Application Support/flomo卡片笔记/config.json'),
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j?.user?.access_token) return j.user.access_token;
    } catch (e) { /* 下一个候选 */ }
  }
  throw new Error('找不到 access_token：请用 --token= 传入，或确认 flomo 客户端已登录');
}

function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  s = s.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{2,}(?=- )/g, '\n');   // 列表项之间不留空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function parseTime(v) {
  if (!v) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v).replace(' ', 'T') + '+08:00');
  return Number.isFinite(t) ? t : null;
}

(async function main() {
  const token = readToken();
  const ctx = { token, deviceId: 'local-import', platform: 'web', deviceModel: 'Web' };
  let latestUpdatedAt = '';
  let latestSlug = '';
  let page = 0;
  let inserted = 0;
  let skipped = 0;
  let seen = 0;
  const sinceMs = args.since ? Date.parse(args.since + 'T00:00:00+08:00') : 0;

  while (page < 200) {
    page += 1;
    const params = { limit: 100 };
    if (latestUpdatedAt && latestSlug) {
      params.latestUpdatedAt = latestUpdatedAt;
      params.latestSlug = latestSlug;
    }
    const res = await api.memos(ctx, params);
    const list = Array.isArray(res) ? res : [];
    if (!list.length) break;

    for (const m of list) {
      seen += 1;
      const createdAt = parseTime(m.created_at) || Date.now();
      if (sinceMs && createdAt < sinceMs) continue;
      const text = htmlToText(m.content);
      if (!text) { skipped += 1; continue; }
      if (args.dry) { inserted += 1; continue; }
      const r = dbm.importMemo({
        originSlug: String(m.slug),
        content: text,
        createdAt,
        pinned: m.pin ? 1 : 0,
      });
      if (r.inserted) inserted += 1; else skipped += 1;
    }

    const last = list[list.length - 1];
    const lastTime = last.updated_at || last.created_at;
    if (!lastTime || !last.slug) break;
    if (lastTime === latestUpdatedAt && last.slug === latestSlug) break;
    latestUpdatedAt = lastTime;
    latestSlug = last.slug;
    if (list.length < 100) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`扫描 ${seen} 条 → ${args.dry ? '可导入' : '新导入'} ${inserted} 条，跳过 ${skipped} 条（重复或空）`);
  const s = dbm.stats();
  console.log(`本地现有：${s.total} 条笔记 / ${s.tags} 个标签`);
})().catch((e) => {
  console.error('导入失败：' + e.message);
  process.exit(1);
});
