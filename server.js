'use strict';
// server.js — 本地笔记服务（零依赖）：静态页面 + 本地 REST API + 大模型流式代理
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const dbm = require('./db');
const { version: APP_VERSION } = require('./version');
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
        app: { version: APP_VERSION },
      });
    }
    if (p === '/api/update/check' && req.method === 'GET') {
      const force = url.searchParams.get('force') === '1';
      return json(res, 200, await checkUpdate(force));
    }
    if (p === '/api/version' && req.method === 'GET') {
      return json(res, 200, { name: 'flomo local', version: APP_VERSION });
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
      const memos = dbm.listMemos({
        tag: url.searchParams.get('tag') || '',
        search: url.searchParams.get('search') || '',
        pin: pinParam === null ? undefined : pinParam === '1',
        since: url.searchParams.get('since') || '',
        until: url.searchParams.get('until') || '',
        random: url.searchParams.get('random') === '1',
        has: url.searchParams.get('has') || '',
        limit, offset,
      });
      const enriched = memos.map((m) => ({ ...m, backlinks: dbm.backlinksOf(m.id).length }));
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

async function checkUpdate(force) {
  if (!force && updateCache.data && Date.now() - updateCache.at < 10 * 60 * 1000) return updateCache.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(UPDATE_VERSION_URL + '?t=' + Date.now(), {
      signal: ctrl.signal,
      headers: { 'user-agent': 'flomo-local/' + APP_VERSION },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const remote = await r.json();
    const data = {
      current: APP_VERSION,
      latest: String(remote.version || ''),
      hasUpdate: compareVersion(remote.version, APP_VERSION) > 0,
      notes: String(remote.notes || ''),
      url: String(remote.url || UPDATE_RELEASE_URL),
      checkedAt: Date.now(),
    };
    updateCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return { current: APP_VERSION, latest: null, hasUpdate: false, error: String(e.message || e), checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
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
