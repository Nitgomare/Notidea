'use strict';
// server.js — 本地笔记服务（零依赖）：静态页面 + 本地 REST API + 大模型流式代理
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const dbm = require('./db');
const { version: APP_VERSION } = require('./version');

// 版本号以磁盘上的 version.js 为准（更新脚本替换文件后无需重启即可读到新值）
function currentVersion() {
  try {
    const p = require.resolve('./version');
    delete require.cache[p];
    const v = require('./version').version;
    return String(v || APP_VERSION);
  } catch (e) {
    return APP_VERSION;
  }
}
const llm = require('./llm');

const PORT = Number(process.env.PORT || 7777);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const FILES_DIR = path.join(__dirname, 'data', 'files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const UPLOAD_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
};

/** 把前端传来的 base64 落成一个文件，返回 files 表要的字段 */
function saveUpload(f) {
  const mime = String(f.mime || 'application/octet-stream');
  if (!mime.startsWith('image/') && !mime.startsWith('video/') && !mime.startsWith('audio/')) throw new Error('只支持图片 / 视频 / 音频');
  const buf = Buffer.from(String(f.dataBase64 || ''), 'base64');
  if (!buf.length) throw new Error('文件是空的');
  if (buf.length > 40 * 1024 * 1024) throw new Error('单个文件上限 40MB');
  let ext = UPLOAD_EXT[mime];
  if (!ext && f.name && f.name.indexOf('.') !== -1) ext = '.' + String(f.name).split('.').pop().slice(0, 6);
  const storeName = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + (ext || '.bin');
  fs.writeFileSync(path.join(FILES_DIR, storeName), buf);
  return { name: String(f.name || storeName).slice(0, 120), mime, size: buf.length, storeName };
}

const tagState = () => ({ tags: dbm.listTags(), tagTree: dbm.tagTree() });

/* ---------------- 批注里的 @提醒 ---------------- */
function atNine(d) { const x = new Date(d); x.setHours(9, 0, 0, 0); return x.getTime(); }

/* 从 @ 之后的文字里取时刻：19:30、7点、七点半、下午3点、晚上8点15分 */
const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(t) {
  if (/^\d+$/.test(t)) return Number(t);
  if (t === '十') return 10;
  if (t.length === 2 && t[0] === '十') return 10 + (CN_NUM[t[1]] ?? 0);
  if (t.length === 2 && t[1] === '十') return (CN_NUM[t[0]] ?? 0) * 10;
  if (t.length === 3 && t[1] === '十') return (CN_NUM[t[0]] ?? 0) * 10 + (CN_NUM[t[2]] ?? 0);
  return CN_NUM[t] ?? NaN;
}
function parseClock(s) {
  let m = s.match(/(\d{1,2})[:：](\d{2})/);
  let h, min = 0;
  if (m) { h = Number(m[1]); min = Number(m[2]); }
  else {
    m = s.match(/([0-9零〇一二两三四五六七八九十]{1,3})\s*[点时](半|一刻|三刻|([0-9零〇一二两三四五六七八九十]{1,3})\s*分?)?/);
    if (!m) return null;
    h = cnToInt(m[1]);
    if (m[2] === '半') min = 30;
    else if (m[2] === '一刻') min = 15;
    else if (m[2] === '三刻') min = 45;
    else if (m[3]) min = cnToInt(m[3]);
  }
  if (!Number.isFinite(h) || h > 24 || !Number.isFinite(min) || min > 59) return null;
  const before = s.slice(0, m.index);
  if (/(下午|晚上|傍晚|今晚|明晚|夜里|晚)/.test(before) && h < 12) h += 12;
  if (/中午/.test(before) && h < 11) h += 12;
  if (h === 24) h = 0;
  return { h, min };
}
function withClock(ts, s) {
  const c = parseClock(s);
  if (!c) return ts;
  const d = new Date(ts); d.setHours(c.h, c.min, 0, 0);
  return d.getTime();
}

function parseRemind(text) {
  const s = String(text || '');
  const at = s.indexOf('@');
  if (at === -1) return null;
  const tail = s.slice(at); // 时刻只从 @ 之后找，避免误读正文里的数字
  const ts = parseRemindDay(s);
  if (ts == null) {
    // 只写了时刻（@七点 / @19:30）：今天这个点，已过就算明天
    const c = parseClock(tail.slice(1, 16));
    if (!c) return null;
    const d = new Date(); d.setHours(c.h, c.min, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return withClock(ts, tail.slice(1, 24));
}

function parseRemindDay(text) {
  const s = String(text || '');
  let m = s.match(/@(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0, 0).getTime();
  m = s.match(/@(\d{1,2})月(\d{1,2})[日号]/);
  if (m) {
    const now = new Date();
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), 9, 0, 0, 0);
    if (d.getTime() < now.getTime() - 86400000) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  m = s.match(/@(今天晚上|今晚|今天|明天晚上|明晚|明天|后天|下周[一二三四五六日天]?|下个月)/);
  if (m) {
    const base = new Date();
    const word = m[1];
    if (word === '今晚' || word === '今天晚上') { base.setHours(20, 0, 0, 0); return base.getTime(); }
    if (word === '今天') return atNine(base);
    if (word === '明天' || word === '明晚' || word === '明天晚上') {
      base.setDate(base.getDate() + 1);
      if (word !== '明天') { base.setHours(20, 0, 0, 0); return base.getTime(); }
      return atNine(base);
    }
    if (word === '后天') { base.setDate(base.getDate() + 2); return atNine(base); }
    if (word === '下个月') { base.setMonth(base.getMonth() + 1, 1); return atNine(base); }
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const want = map[word.slice(2)] !== undefined ? map[word.slice(2)] : 1;
    const d = new Date(base);
    const delta = ((want - d.getDay()) + 7) % 7 || 7;
    d.setDate(d.getDate() + delta);
    return atNine(d);
  }
  if (/@提醒/.test(s)) { const d = new Date(); d.setHours(20, 0, 0, 0); return d.getTime(); }
  return null;
}

/* ---------------- 提醒 → iCalendar(.ics) ---------------- */
function icsTime(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + 'T' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + 'Z';
}
function icsText(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// RFC 5545：每行不超过 75 字节，续行以一个空格开头；按字符切，不拆开 UTF-8 多字节字符
function foldIcsLine(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    const limit = out.length ? 74 : 75;
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function buildIcs(items) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//flomo local//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const it of items) {
    const title = String(it.content || '提醒').replace(/@\S+/g, '').trim() || '提醒';
    lines.push(
      'BEGIN:VEVENT',
      'UID:flomo-local-remind-' + it.id + '@127.0.0.1',
      'DTSTAMP:' + icsTime(Date.now()),
      'DTSTART:' + icsTime(it.remind_at),
      'DTEND:' + icsTime(it.remind_at + 30 * 60000),
      'SUMMARY:' + icsText('flomo · ' + title.slice(0, 60)),
      'DESCRIPTION:' + icsText(it.excerpt || ''),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(title.slice(0, 60)), 'TRIGGER:-PT0M', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}
function writeIcs(c, memo) {
  const dir = path.join(__dirname, 'data', 'calendar');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'remind-' + c.id + '.ics');
  const excerpt = memo ? String(memo.content || '').replace(/\s+/g, ' ').slice(0, 200) : '';
  fs.writeFileSync(file, buildIcs([{ id: c.id, remind_at: c.remind_at, content: c.content, excerpt }]), 'utf8');
  return file;
}

/* ---------------- 在真正的桌面建快捷方式（设置里的按钮） ---------------- */
function makeShortcut() {
  const script = path.join(__dirname, 'tools', 'make-shortcut.ps1');
  if (!fs.existsSync(script)) return Promise.reject(new Error('缺少 tools/make-shortcut.ps1'));
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Quiet'], {
      cwd: __dirname, windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => { try { ps.kill(); } catch (e) { } reject(new Error('创建超时')); }, 25000);
    ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ps.stderr.on('data', (d) => { out += d.toString('utf8'); });
    ps.on('error', (e) => { clearTimeout(timer); reject(e); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).reverse().find((l) => l.includes('已创建：')) || '';
      const p = line.split('已创建：')[1] ? line.split('已创建：')[1].trim() : '';
      if (code === 0 && p) resolve({ path: p, output: out.trim() });
      else reject(new Error(out.trim() || ('powershell 退出码 ' + code)));
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

const readBody = (req, limit = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
  });
  req.on('error', reject);
});

const fmtDate = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dayStart = (offsetDays = 0) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + offsetDays * 86400000;
};

function memoLines(memos, withDate = true) {
  return memos.map((m) => (withDate ? `[${fmtDate(m.created_at)}] ${m.content}` : m.content)).join('\n\n');
}

function recentContext(limit = 8) {
  return memoLines(dbm.listMemos({ limit }), true);
}

/** 洞察范围：全部 / 某个标签 / 最近 N 天 */
function insightScope(body = {}) {
  const scope = body.scope || {};
  const tag = String(scope.tag || '');
  const days = Math.max(Number(scope.days || 0), 0);
  const limit = Math.min(Number(scope.limit || 150), 400);
  let memos;
  let range;
  if (days > 0) {
    memos = dbm.memosBetween(dayStart(-(days - 1)), dayStart(1));
    range = `最近 ${days} 天`;
  } else if (tag) {
    memos = dbm.listMemos({ tag, limit });
    range = `标签 #${tag}`;
  } else {
    memos = dbm.listMemos({ limit });
    range = '全部笔记';
  }
  const picked = memos.slice(-limit);
  const tagSet = new Set();
  for (const m of picked) for (const t of m.tags || []) tagSet.add(t);
  return { picked, range, tag, days, tags: tagSet.size };
}

function scopeSummary(body = {}) {
  const s = insightScope(body);
  const dates = new Set(s.picked.map((m) => new Date(m.created_at).toDateString()));
  return {
    count: s.picked.length,
    tags: s.tags,
    days: dates.size,
    range: s.range,
    scope: { tag: s.tag, days: s.days },
  };
}

/** 依据 kind 组装提示词变量 */
function reportRange(kind, body) {
  const now = new Date();
  if (kind === 'report-month') {
    const y = Number(body.year) || now.getFullYear();
    const m = Number(body.month) || now.getMonth() + 1;
    const from = new Date(y, m - 1, 1).getTime();
    const to = new Date(y, m, 1).getTime();
    return { from, to, label: y + ' 年 ' + m + ' 月' };
  }
  const y = Number(body.year) || now.getFullYear();
  return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), label: y + ' 年' };
}

function buildVars(kind, body) {
  const today = new Date().toISOString().slice(0, 10);
  if (kind === 'insight') {
    // 1) 针对单条笔记
    if (body.memoId && !body.perspective) {
      const memo = dbm.getMemo(Number(body.memoId));
      if (!memo) throw new Error('笔记不存在');
      return {
        content: memo.content,
        created_at: fmtDate(memo.created_at),
        context: memoLines(dbm.listMemos({ limit: 6 }).filter((m) => m.id !== memo.id), true),
      };
    }
    // 2) 针对一个范围 + 一个视角（默认洞察 / 价值澄清 / 逆向思考 / 二阶思考 / CBT / MBTI / 自定义）
    const perspective = String(body.perspective || 'default').replace(/[^a-z0-9-]/gi, '');
    const s = insightScope(body);
    if (!s.picked.length) throw new Error('这个范围里还没有笔记');
    return {
      count: s.picked.length,
      range: s.range,
      tags: s.tags,
      memos: memoLines(s.picked, true).slice(0, 24000),
    };
  }
  if (kind === 'daily-review') {
    const memos = dbm.memosBetween(dayStart(), dayStart(1));
    return {
      date: today,
      count: memos.length,
      memos: memos.length ? memoLines(memos, false) : '（今天还没有记录）',
      history: memoLines(dbm.memosBetween(dayStart(-7), dayStart(0)).slice(-12), true) || '（暂无更早记录）',
    };
  }
  if (kind === 'random-walk') {
    const memos = dbm.randomMemos(5);
    return { memos: memos.length ? memoLines(memos, true) : '（还没有笔记）' };
  }
  if (kind === 'tag-suggest') {
    const memo = dbm.getMemo(Number(body.memoId));
    if (!memo) throw new Error('笔记不存在');
    return { content: memo.content, tags: dbm.listTags().slice(0, 40).map((t) => '#' + t.name).join(' ') || '（暂无）' };
  }
  if (kind === 'weekly-summary') {
    const memos = dbm.memosBetween(dayStart(-7), dayStart(1));
    return { range: `${new Date(dayStart(-7)).toISOString().slice(0, 10)} 至 ${today}`, memos: memos.length ? memoLines(memos, true) : '（本周没有记录）' };
  }
  if (kind === 'report-month' || kind === 'report-year') {
    const { from, to, label } = reportRange(kind, body);
    const memos = dbm.memosBetween(from, to);
    if (!memos.length) throw new Error(label + '还没有笔记');
    const tagSet = new Set();
    for (const m of memos) for (const t of m.tags) tagSet.add(t);
    return {
      label,
      count: memos.length,
      tags: tagSet.size,
      tagList: [...tagSet].map((t) => '#' + t).join(' ') || '（没有标签）',
      memos: memoLines(memos, true).slice(0, 26000),
    };
  }
  if (kind === 'ask') {
    const q = String(body.question || '').trim();
    if (!q) throw new Error('问题为空');
    const hits = dbm.listMemos({ search: q, limit: 12 });
    const fallback = hits.length ? hits : dbm.listMemos({ limit: 10 });
    return { question: q, context: memoLines(fallback, true) || '（本地还没有笔记）' };
  }
  throw new Error('未知的 AI 技能: ' + kind);
}

async function handleAi(req, res, kind) {
  const body = await readBody(req);
  let vars;
  try { vars = buildVars(kind, body); }
  catch (e) { return json(res, 400, { error: e.message }); }

  const promptKind = kind === 'insight' && body.perspective
    ? 'insights/' + String(body.perspective).replace(/[^a-z0-9-]/gi, '')
    : kind;
  const messages = llm.buildMessages(promptKind, vars);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  let acc = '';
  try {
    for await (const delta of llm.chat({ messages })) {
      acc += delta;
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    const savedKind = kind === 'insight' && body.perspective ? `insights/${String(body.perspective).replace(/[^a-z0-9-]/gi, '')}` : kind;
    const note = dbm.saveAiNote({ kind: savedKind, memoIds: body.memoId ? [Number(body.memoId)] : [], prompt: messages[1].content, content: acc });
    res.write(`data: ${JSON.stringify({ done: true, id: note.id })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
}

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    // ---- 配置 ----
    if (p === '/api/bootstrap' && req.method === 'GET') {
      return json(res, 200, {
        stats: dbm.stats(),
        tags: dbm.listTags(),
        tagTree: dbm.tagTree(),
        heatmap: dbm.heatmap(154),
        prompts: llm.listPrompts(),
        llm: llm.publicConfig(),
        storage: { path: path.join(__dirname, 'data', 'flomo.db'), fts: dbm.fts },
        reminders: dbm.reminderCount(),
        app: { version: currentVersion() },
      });
    }
    if (p === '/api/update/check' && req.method === 'GET') {
      const force = url.searchParams.get('force') === '1';
      return json(res, 200, await checkUpdate(force));
    }
    if (p === '/api/version' && req.method === 'GET') {
      return json(res, 200, { name: 'flomo local', version: currentVersion() });
    }
    if (p === '/api/shortcut' && req.method === 'POST') {
      try {
        const r = await makeShortcut();
        return json(res, 200, { ok: true, path: r.path });
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    }
    if (p === '/api/update/apply' && req.method === 'POST') {
      try {
        const info = await checkUpdate(true);
        if (info.error) return json(res, 502, { error: '检查更新失败：' + info.error });
        if (!info.hasUpdate) return json(res, 400, { error: '已经是最新版本' });
        const dl = await downloadUpdate(info);
        const vbs = writeApplyScript(dl.zip);
        const latest = info.latest;
        setTimeout(() => {
          try {
            spawn('wscript.exe', [vbs], {
              detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname,
            }).unref();
          } catch (e) { /* 交给用户手动重启 */ }
          setTimeout(() => process.exit(0), 300);
        }, 500);
        return json(res, 200, { ok: true, latest, size: dl.size, note: '正在替换文件并重启服务' });
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    }
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const next = llm.writeConfig({
        ...(body.baseUrl !== undefined ? { baseUrl: String(body.baseUrl).trim() } : {}),
        ...(body.model !== undefined ? { model: String(body.model).trim() } : {}),
        ...(body.apiKey !== undefined && String(body.apiKey).trim() ? { apiKey: String(body.apiKey).trim() } : {}),
        ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
      });
      return json(res, 200, llm.publicConfig(next));
    }

    // ---- 笔记 ----
    if (p === '/api/memos' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
      const pinParam = url.searchParams.get('pinned');
      const searchTerm = url.searchParams.get('search') || '';
      const memos = dbm.listMemos({
        tag: url.searchParams.get('tag') || '',
        search: searchTerm,
        pin: pinParam === null ? undefined : pinParam === '1',
        since: url.searchParams.get('since') || '',
        until: url.searchParams.get('until') || '',
        random: url.searchParams.get('random') === '1',
        has: url.searchParams.get('has') || '',
        excludeTag: url.searchParams.get('excludeTag') || '',
        source: url.searchParams.get('source') || '',
        order: url.searchParams.get('order') || '',
        onThisDay: url.searchParams.get('onThisDay') === '1',
        limit, offset,
      });
      const enriched = memos.map((m) => ({ ...m, backlinks: dbm.backlinksOf(m.id).length, comment_hit: dbm.commentHit(m.id, searchTerm) }));
      return json(res, 200, { memos: enriched, hasMore: memos.length === limit });
    }
    if (p === '/api/memos' && req.method === 'POST') {
      const body = await readBody(req);
      const content = String(body.content || '').trim();
      if (!content) return json(res, 400, { error: '内容为空' });
      const memo = dbm.createMemo(content, { createdAt: body.createdAt ? Number(body.createdAt) : undefined });
      if (Array.isArray(body.files) && body.files.length) {
        const saved = [];
        for (const f of body.files) saved.push(saveUpload(f));
        dbm.attachFiles(memo.id, saved);
      }
      // 写笔记时直接设提醒：挂一条带 remind_at 的批注，复用提醒列表
      if (body.remindAt && Number(body.remindAt) > 0) {
        const c = dbm.addComment(memo.id, String(body.remindNote || '⏰ 提醒').slice(0, 200), Number(body.remindAt));
        if (body.calendar && c) {
          try {
            const file = writeIcs(c, dbm.getMemo(memo.id));
            spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          } catch (e) { /* 日历打不开不影响保存 */ }
        }
      }
      const full = dbm.getMemo(memo.id);
      return json(res, 200, { memo: full, stats: dbm.stats(), tags: dbm.listTags(), tagTree: dbm.tagTree(), heatmap: dbm.heatmap(154) });
    }
    const memoMatch = p.match(/^\/api\/memos\/(\d+)$/);
    if (memoMatch) {
      const id = Number(memoMatch[1]);
      if (req.method === 'GET') {
        const memo = dbm.getMemo(id);
        if (!memo) return json(res, 404, { error: '笔记不存在' });
        return json(res, 200, { memo });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const memo = dbm.updateMemo(id, {
          ...(body.content !== undefined ? { content: String(body.content) } : {}),
          ...(body.pinned !== undefined ? { pinned: !!body.pinned } : {}),
        });
        if (!memo) return json(res, 404, { error: '笔记不存在' });
        return json(res, 200, { memo, tags: dbm.listTags() });
      }
      if (req.method === 'DELETE') {
        const ok = dbm.deleteMemo(id);
        return json(res, ok ? 200 : 404, { ok, stats: dbm.stats(), tags: dbm.listTags() });
      }
    }

    // ---- 标签 / 导出导入 ----
    if (p === '/api/tags' && req.method === 'GET') return json(res, 200, { tags: dbm.listTags(), tagTree: dbm.tagTree() });

    if (p === '/api/tags/tree' && req.method === 'GET') return json(res, 200, { tags: dbm.listTags(), tree: dbm.tagTree() });

    if (p === '/api/tags/create' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const leaf = String(body.name || '').trim().replace(/^#/, '');
        if (!leaf) return json(res, 400, { error: '标签名不能为空' });
        const parent = String(body.parent || '').trim().replace(/^#/, '').replace(/\/+$/, '');
        dbm.ensureTag(parent ? parent + '/' + leaf : leaf);
        return json(res, 200, tagState());
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/tags/rename' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = dbm.renameTag(body.from, body.to);
        return json(res, 200, { ...r, ...tagState(), stats: dbm.stats(), heatmap: dbm.heatmap(154) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/tags/meta' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        dbm.setTagMeta(body.name, { pinned: body.pinned, icon: body.icon });
        return json(res, 200, tagState());
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/tags/delete' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = dbm.deleteTag(body.name);
        return json(res, 200, { ...r, ...tagState(), stats: dbm.stats(), heatmap: dbm.heatmap(154) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/heatmap' && req.method === 'GET') {
      const days = Math.min(Number(url.searchParams.get('days') || 154), 400);
      return json(res, 200, { heatmap: dbm.heatmap(days) });
    }

    if (p.startsWith('/api/memos/') && p.endsWith('/related') && req.method === 'GET') {
      const id = Number(p.slice('/api/memos/'.length, -'/related'.length));
      const limit = Math.min(Number(url.searchParams.get('limit') || 6), 20);
      return json(res, 200, { related: dbm.relatedMemos(id, limit) });
    }

    if (p.startsWith('/api/memos/') && p.endsWith('/links') && req.method === 'GET') {
      const id = Number(p.slice('/api/memos/'.length, -'/links'.length));
      return json(res, 200, { backlinks: dbm.backlinksOf(id), forward: dbm.forwardLinksOf(id) });
    }

    if (p.startsWith('/api/memos/') && p.endsWith('/files') && req.method === 'POST') {
      const id = Number(p.slice('/api/memos/'.length, -'/files'.length));
      const body = await readBody(req, 64 * 1024 * 1024);
      const memo = dbm.getMemo(id);
      if (!memo) return json(res, 404, { error: '笔记不存在' });
      try {
        const saved = (body.files || []).map(saveUpload);
        dbm.attachFiles(id, saved);
        return json(res, 200, { memo: dbm.getMemo(id) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p.startsWith('/api/memos/') && p.endsWith('/comments')) {
      const id = Number(p.slice('/api/memos/'.length, -'/comments'.length));
      if (!dbm.getMemo(id)) return json(res, 404, { error: '笔记不存在' });
      if (req.method === 'GET') return json(res, 200, { comments: dbm.commentsOf(id) });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const content = String(body.content || '').trim();
        if (!content) return json(res, 400, { error: '批注不能为空' });
        const remindAt = body.remindAt ? Number(body.remindAt) : parseRemind(content);
        return json(res, 200, { comment: dbm.addComment(id, content, remindAt), memo: dbm.getMemo(id) });
      }
    }

    if (p === '/api/reminders' && req.method === 'GET') {
      const includeDone = url.searchParams.get('done') === '1';
      return json(res, 200, {
        reminders: dbm.reminders({ includeDone }),
        count: dbm.reminderCount(),
        now: Date.now(),
      });
    }

    // 同步到 Windows 日历：生成标准 .ics，交给系统默认日历程序（Windows 日历 / Outlook）打开
    const icsMatch = p.match(/^\/api\/comments\/(\d+)\/calendar$/);
    if (icsMatch && req.method === 'POST') {
      const c = dbm.commentById(Number(icsMatch[1]));
      if (!c || !c.remind_at) return json(res, 404, { error: '这条批注没有提醒时间' });
      const memo = dbm.getMemo(c.memo_id);
      const file = writeIcs(c, memo);
      try {
        spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return json(res, 200, { ok: true, file });
      } catch (e) { return json(res, 500, { error: '打不开日历：' + e.message, file }); }
    }
    if (p === '/api/reminders.ics' && req.method === 'GET') {
      const list = dbm.reminders({ includeDone: false });
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="flomo-local-reminders.ics"',
      });
      return res.end(buildIcs(list.map((r) => ({ id: r.id, remind_at: r.remind_at, content: r.content, excerpt: r.memo_excerpt }))));
    }

    if (p.startsWith('/api/comments/') && p.endsWith('/done') && req.method === 'POST') {
      const id = Number(p.slice('/api/comments/'.length, -'/done'.length));
      return json(res, 200, { done: dbm.clearReminder(id), count: dbm.reminderCount() });
    }

    if (p.startsWith('/api/comments/') && req.method === 'DELETE') {
      const id = Number(p.slice('/api/comments/'.length));
      return json(res, 200, { deleted: dbm.deleteComment(id) });
    }

    if (p === '/api/export' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="flomo-local-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return res.end(JSON.stringify(dbm.exportAll(), null, 2));
    }
    if (p === '/api/import' && req.method === 'POST') {
      const body = await readBody(req, 64 * 1024 * 1024);
      return json(res, 200, { ...dbm.importAll(body), stats: dbm.stats(), tags: dbm.listTags() });
    }
    if (p === '/api/ai-notes' && req.method === 'GET') return json(res, 200, { notes: dbm.listAiNotes(30) });

    // ---- AI 洞察（视角）----
    if (p === '/api/insights' && req.method === 'GET') {
      const scope = {
        tag: url.searchParams.get('tag') || '',
        days: Number(url.searchParams.get('days') || 0),
      };
      return json(res, 200, { perspectives: llm.listInsights(), summary: scopeSummary({ scope }) });
    }
    if (p === '/api/insights/history' && req.method === 'GET') {
      const all = dbm.listAiNotes(200).filter((n) => String(n.kind).startsWith('insights/') || n.kind === 'insight');
      return json(res, 200, { notes: all.slice(0, Math.min(Number(url.searchParams.get('limit') || 20), 100)) });
    }

    // ---- AI ----
    const aiMatch = p.match(/^\/api\/ai\/([a-z-]+)$/);
    if (aiMatch && req.method === 'POST') return handleAi(req, res, aiMatch[1]);

    return json(res, 404, { error: 'not found' });
  }

  // ---- 附件（图片/视频/音频）----
  if (p.startsWith('/files/')) {
    const name = path.basename(decodeURIComponent(p.slice('/files/'.length)));
    const f = path.join(FILES_DIR, name);
    if (!f.startsWith(FILES_DIR)) return json(res, 403, { error: 'forbidden' });
    return fs.readFile(f, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
      const ext = path.extname(f).toLowerCase();
      const type = MIME[ext] || (ext === '.jpg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : 'application/octet-stream');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000', 'Accept-Ranges': 'bytes' });
      res.end(data);
    });
  }

  // ---- 静态文件 ----
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---- 检查更新（方法一：拉 GitHub 上的 version.json）----
const UPDATE_REPO = 'Nitgomare/flomo-local';
const UPDATE_REPO_URL = 'https://github.com/' + UPDATE_REPO;
const UPDATE_VERSION_URL = 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/main/version.json';
const UPDATE_RELEASE_URL = 'https://github.com/' + UPDATE_REPO + '/releases/latest';
let updateCache = { at: 0, data: null };

function versionParts(v) {
  return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
}
function compareVersion(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

async function fetchLatestInfo() {
  // 1) GitHub API（不走 CDN，最可靠）
  try {
    const r = await fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', {
      headers: { 'user-agent': 'flomo-local', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(7000),
    });
    if (r.ok) {
      const j = await r.json();
      const version = String(j.tag_name || '').replace(/^v/i, '');
      if (version) {
        return { version, notes: String(j.body || ''), url: String(j.html_url || UPDATE_RELEASE_URL) };
      }
    }
  } catch (e) { /* 下一个 */ }

  // 2) 仓库根 version.json（raw；加时间戳绕缓存）
  try {
    const r = await fetch(UPDATE_VERSION_URL + '?t=' + Date.now(), {
      headers: { 'user-agent': 'flomo-local', 'cache-control': 'no-cache', pragma: 'no-cache' },
      signal: AbortSignal.timeout(7000),
    });
    if (r.ok) {
      const j = await r.json();
      const version = String(j.version || '');
      if (version) return { version, notes: String(j.notes || ''), url: String(j.url || UPDATE_RELEASE_URL) };
    }
  } catch (e) { /* 下一个 */ }

  // 3) jsDelivr 镜像（国内网络更通）
  const r = await fetch('https://cdn.jsdelivr.net/gh/' + UPDATE_REPO + '@main/version.json?t=' + Date.now(), {
    headers: { 'user-agent': 'flomo-local' },
    signal: AbortSignal.timeout(7000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return { version: String(j.version || ''), notes: String(j.notes || ''), url: String(j.url || UPDATE_RELEASE_URL) };
}

async function checkUpdate(force) {
  const current = currentVersion();
  if (!force && updateCache.data && Date.now() - updateCache.at < 60 * 1000) return updateCache.data;
  try {
    const info = await fetchLatestInfo();
    const latest = info.version;
    const hasUpdate = compareVersion(latest, current) > 0;
    const data = {
      current,
      latest,
      hasUpdate,
      notes: info.notes,
      url: info.url,
      asset: hasUpdate ? UPDATE_APP_ZIP(latest) : '',
      checkedAt: Date.now(),
    };
    updateCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return { current, latest: null, hasUpdate: false, error: String(e.message || e), checkedAt: Date.now() };
  }
}

/* ---------------- 自动更新：下载 → 解压 → 覆盖 → 重启 ---------------- */
const UPDATE_APP_ZIP = (v) => UPDATE_REPO_URL + '/releases/download/v' + v + '/flomo-local-' + v + '-app.zip';

async function downloadUpdate(info) {
  const dir = path.join(__dirname, 'data', 'update');
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'app.zip');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const r = await fetch(info.asset, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'flomo-local/' + APP_VERSION },
    });
    if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('下载内容不是 zip（可能被网络拦截）');
    fs.writeFileSync(zip, buf);
    return { zip, size: buf.length };
  } finally {
    clearTimeout(timer);
  }
}

function writeApplyScript(zipPath) {
  const dir = path.join(__dirname, 'data', 'update');
  const src = path.join(dir, 'app');
  fs.rmSync(src, { recursive: true, force: true });
  const ps1 = path.join(dir, 'apply.ps1');
  const q = (p) => "'" + String(p).replace(/'/g, "''") + "'";
  const root = __dirname.replace(/\\/g, '\\');
  const nodeExe = process.execPath;
  const content = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$root = ' + q(root),
    '$zip = ' + q(zipPath),
    '$src = ' + q(src),
    '$node = ' + q(nodeExe),
    '$port = ' + PORT,
    'function Port-Free {',
    '  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $port); $c.Close(); return $false } catch { return $true }',
    '}',
    'for ($i = 0; $i -lt 120; $i++) { if (Port-Free) { break }; Start-Sleep -Milliseconds 250 }',
    'Start-Sleep -Milliseconds 400',
    'Expand-Archive -LiteralPath $zip -DestinationPath $src -Force',
    'robocopy $src $root /E /NFL /NDL /NJH /NJS /XD "$root\\data" "$root\\runtime" | Out-Null',
    'Start-Process -FilePath $node -ArgumentList (\'"\' + (Join-Path $root "server.js") + \'"\') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root "data\\server.log") -RedirectStandardError (Join-Path $root "data\\server.err.log")',
    'Start-Sleep -Seconds 1',
    'Remove-Item -LiteralPath $zip -Force',
    'Remove-Item -LiteralPath $src -Recurse -Force',
    "$vbsSelf = Join-Path (Split-Path -Parent $PSCommandPath) 'apply.vbs'",
    'Remove-Item -LiteralPath $vbsSelf -Force',
    'Remove-Item -LiteralPath $PSCommandPath -Force',
    '',
  ].join('\r\n');
  fs.writeFileSync(ps1, '\ufeff' + content, 'utf8');

  const vbsPath = path.join(dir, 'apply.vbs');
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""' + ps1 + '""", 0, False',
    '',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, vbs, 'utf8');
  return vbsPath;
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  flomo-local 已启动  →  http://${HOST}:${PORT}\n  数据目录: ${path.join(__dirname, 'data')}\n`);
});

// 自检：程序文件被删 / 被移走时主动退出，避免“页面能开、接口全挂”的僵尸服务占着端口
const SELF_FILES = [__filename, path.join(PUBLIC_DIR, 'index.html'), path.join(__dirname, 'prompts')];
setInterval(() => {
  const missing = SELF_FILES.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error('[flomo-local] 程序文件缺失，服务退出：' + missing.join(', '));
    process.exit(3);
  }
}, 10000).unref();
