'use strict';
// db.js — 本地优先存储（node:sqlite 内置模块，零依赖）
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const { DATA_DIR, DB_FILE } = require('./lib/data-dir');

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS memos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT UNIQUE NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    pinned     INTEGER NOT NULL DEFAULT 0,
    source     TEXT NOT NULL DEFAULT 'local'
  );

  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memo_tags (
    memo_id INTEGER NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (memo_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS ai_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    memo_ids   TEXT NOT NULL DEFAULT '[]',
    prompt     TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memos_created ON memos(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memo_tags_tag ON memo_tags(tag_id);

  CREATE TABLE IF NOT EXISTS files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    memo_id    INTEGER REFERENCES memos(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT '',
    mime       TEXT NOT NULL DEFAULT '',
    size       INTEGER NOT NULL DEFAULT 0,
    store_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memo_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    memo_id    INTEGER NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
    content    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_comments_memo ON memo_comments(memo_id);
  CREATE INDEX IF NOT EXISTS idx_files_memo ON files(memo_id);
  CREATE INDEX IF NOT EXISTS idx_files_mime ON files(mime);
`);

try {
  db.exec(`ALTER TABLE memos ADD COLUMN origin_slug TEXT`);
} catch (e) { /* 已有该列 */ }
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memos_origin ON memos(origin_slug) WHERE origin_slug IS NOT NULL`);

let fts = false;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(content, content='memos', content_rowid='id');
  `);
  fts = true;
} catch (e) {
  fts = false;
}

if (fts) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memos_ai AFTER INSERT ON memos BEGIN
      INSERT INTO memos_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memos_ad AFTER DELETE ON memos BEGIN
      INSERT INTO memos_fts(memos_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memos_au AFTER UPDATE ON memos BEGIN
      INSERT INTO memos_fts(memos_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memos_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
}

// 迁移：标签的置顶 / 图标 / 排序（老库自动补齐）
for (const sql of [
  'ALTER TABLE tags ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE tags ADD COLUMN icon TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE memo_comments ADD COLUMN remind_at INTEGER',
  'ALTER TABLE memo_comments ADD COLUMN done INTEGER NOT NULL DEFAULT 0',
]) {
  try { db.exec(sql); } catch { /* 已存在 */ }
}

const now = () => Date.now();
const rand = () => Math.random().toString(36).slice(2, 10);
const newSlug = () => `${Date.now().toString(36)}${rand()}`;

const TAG_RE = /#([^\s#，。！？、；：,.!?;:()（）\[\]【】"'“”‘’]+)/g;

function extractTags(content) {
  const out = new Set();
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(content))) out.add(m[1].trim());
  return [...out].filter(Boolean);
}

function attachTags(memoId, names) {
  for (const name of names) {
    db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)').run(name);
    const row = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
    if (row) db.prepare('INSERT OR IGNORE INTO memo_tags(memo_id, tag_id) VALUES (?, ?)').run(memoId, row.id);
  }
}

function pruneTags() {
  const rows = db.prepare('SELECT t.id AS id, t.name AS name, (SELECT COUNT(*) FROM memo_tags mt WHERE mt.tag_id = t.id) AS n FROM tags t').all();
  const names = rows.map((r) => r.name);
  const del = db.prepare('DELETE FROM tags WHERE id = ?');
  for (const r of rows) {
    if (r.n > 0) continue;
    if (names.some((x) => x.startsWith(r.name + '/'))) continue;
    del.run(r.id);
  }
}

function syncTags(memoId, content) {
  db.prepare('DELETE FROM memo_tags WHERE memo_id = ?').run(memoId);
  attachTags(memoId, extractTags(content));
  pruneTags();
}

function tagsOf(memoId) {
  return db.prepare(`SELECT t.name FROM tags t JOIN memo_tags mt ON mt.tag_id = t.id WHERE mt.memo_id = ? ORDER BY t.name`).all(memoId).map((r) => r.name);
}

function hydrate(rows) {
  return rows.map((m) => ({ ...m, tags: tagsOf(m.id), files: filesOf(m.id), comments: commentCount(m.id) }));
}

/* ---------------- 批注 ---------------- */
function commentsOf(memoId) {
  return db.prepare('SELECT id, memo_id, content, created_at, remind_at, done FROM memo_comments WHERE memo_id = ? ORDER BY id ASC').all(memoId);
}
function commentHit(memoId, search) {
  if (!search) return '';
  const row = db.prepare('SELECT content FROM memo_comments WHERE memo_id = ? AND content LIKE ? ORDER BY id ASC LIMIT 1')
    .get(memoId, '%' + String(search) + '%');
  return row ? row.content : '';
}
function commentCount(memoId) {
  return db.prepare('SELECT COUNT(*) AS n FROM memo_comments WHERE memo_id = ?').get(memoId).n;
}
function commentById(id) {
  return db.prepare('SELECT id, memo_id, content, created_at, remind_at, done FROM memo_comments WHERE id = ?').get(id) || null;
}
function addComment(memoId, content, remindAt = null) {
  const info = db.prepare('INSERT INTO memo_comments(memo_id, content, created_at, remind_at) VALUES (?, ?, ?, ?)')
    .run(memoId, String(content || ''), now(), remindAt ? Number(remindAt) : null);
  return commentById(Number(info.lastInsertRowid));
}
function deleteComment(id) {
  return db.prepare('DELETE FROM memo_comments WHERE id = ?').run(id).changes > 0;
}

// 提醒：批注里带 @日期 / @今天 / @明天 的，按时间排
function reminders({ includeDone = false, limit = 200 } = {}) {
  const where = includeDone ? 'c.remind_at IS NOT NULL' : 'c.remind_at IS NOT NULL AND c.done = 0';
  return db.prepare(`
    SELECT c.id, c.memo_id, c.content, c.created_at, c.remind_at, c.done,
           substr(replace(m.content, char(10), ' '), 1, 80) AS memo_excerpt,
           m.created_at AS memo_created_at
    FROM memo_comments c JOIN memos m ON m.id = c.memo_id
    WHERE ${where}
    ORDER BY c.remind_at ASC, c.id ASC
    LIMIT ?
  `).all(limit);
}

function reminderCount() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memo_comments WHERE remind_at IS NOT NULL AND done = 0').get();
  return row.n;
}

function clearReminder(id) {
  return db.prepare('UPDATE memo_comments SET done = 1 WHERE id = ?').run(id).changes > 0;
}

function setReminder(id, ts) {
  return db.prepare('UPDATE memo_comments SET remind_at = ?, done = 0 WHERE id = ?').run(ts ? Number(ts) : null, id).changes > 0;
}


/* ---------------- 附件 ---------------- */
function filesOf(memoId) {
  return db.prepare('SELECT id, name, mime, size, store_name, created_at FROM files WHERE memo_id = ? ORDER BY id ASC')
    .all(memoId)
    .map((f) => ({ ...f, url: '/files/' + f.store_name }));
}

function addFile(memoId, { name = '', mime = '', size = 0, storeName }) {
  const info = db.prepare('INSERT INTO files(memo_id, name, mime, size, store_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(memoId, name, mime, size, storeName, now());
  return Number(info.lastInsertRowid);
}

function attachFiles(memoId, files = []) {
  for (const f of files) addFile(memoId, f);
  return filesOf(memoId);
}

/* ---------------- 双向链接 ---------------- */
/** 从正文里取出 [[目标]]，目标可以是 #id、slug，或另一条笔记的开头文字 */
function parseLinkTargets(content) {
  const out = [];
  let i = 0;
  while (i < content.length) {
    const s = content.indexOf('[[', i);
    if (s === -1) break;
    const e = content.indexOf(']]', s + 2);
    if (e === -1) break;
    const t = content.slice(s + 2, e).trim();
    if (t) out.push(t);
    i = e + 2;
  }
  return [...new Set(out)];
}

function resolveLinkTarget(target) {
  if (target.startsWith('#')) {
    const id = Number(target.slice(1));
    if (Number.isFinite(id)) return db.prepare('SELECT id, slug, content FROM memos WHERE id = ?').get(id) || null;
  }
  const bySlug = db.prepare('SELECT id, slug, content FROM memos WHERE slug = ?').get(target);
  if (bySlug) return bySlug;
  return db.prepare(`SELECT id, slug, content FROM memos WHERE content LIKE ? ORDER BY created_at ASC LIMIT 1`).get(target + '%') || null;
}

/** 谁引用了这条笔记 */
function backlinksOf(memoId) {
  const me = db.prepare('SELECT id, slug FROM memos WHERE id = ?').get(memoId);
  if (!me) return [];
  const needles = ['[[' + me.slug + ']]', '[[#' + me.id + ']]'];
  const rows = db.prepare(`${selectBase} WHERE id != ?`).all(memoId);
  return hydrate(rows.filter((m) => needles.some((n) => m.content.includes(n))));
}

/** 这条笔记引用了谁 */
function forwardLinksOf(memoId) {
  const memo = db.prepare('SELECT content FROM memos WHERE id = ?').get(memoId);
  if (!memo) return [];
  return parseLinkTargets(memo.content)
    .map((t) => ({ target: t, memo: resolveLinkTarget(t) }))
    .filter((x) => x.memo)
    .map((x) => ({ target: x.target, id: x.memo.id, slug: x.memo.slug, excerpt: x.memo.content.replace(/\s+/g, ' ').slice(0, 60) }));
}

/* ---------------- 相关笔记（TF-IDF 余弦，中文按二元组切） ---------------- */
const CJK = (c) => c >= '\u4e00' && c <= '\u9fff';
const ALNUM = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

function tokensOf(text) {
  const s = String(text).toLowerCase();
  const out = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (CJK(c)) {
      if (buf) { out.push(buf); buf = ''; }
      const n = s[i + 1];
      if (n && CJK(n)) out.push(c + n);
    } else if (ALNUM(c)) {
      buf += c;
    } else if (buf) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 找出和某条笔记内容最接近的其它笔记（本地计算，不联网） */
function relatedMemos(memoId, limit = 6) {
  const me = db.prepare('SELECT id, content FROM memos WHERE id = ?').get(memoId);
  if (!me) return [];
  const rows = db.prepare('SELECT id, slug, content, created_at, pinned FROM memos').all();
  if (rows.length < 2) return [];

  const docs = rows.map((r) => {
    const tf = new Map();
    for (const t of tokensOf(r.content)) tf.set(t, (tf.get(t) || 0) + 1);
    return { row: r, tf, norm: Math.sqrt([...tf.values()].reduce((a, b) => a + b * b, 0)) || 1 };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const weight = (t) => Math.log(1 + N / (df.get(t) || 1));

  const mine = docs.find((d) => d.row.id === memoId);
  const scored = [];
  for (const d of docs) {
    if (d.row.id === memoId) continue;
    let dot = 0;
    for (const [t, n] of mine.tf) {
      const other = d.tf.get(t);
      if (!other) continue;
      const w = weight(t);
      dot += n * w * other * w;
    }
    if (!dot) continue;
    scored.push({ d, score: dot / (mine.norm * d.norm) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => ({
    id: s.d.row.id,
    slug: s.d.row.slug,
    created_at: s.d.row.created_at,
    score: Math.round(s.score * 1000) / 1000,
    excerpt: String(s.d.row.content).replace(/\s+/g, ' ').slice(0, 70),
  }));
}

/** 热力图数据：按本地日期聚合最近 N 天的笔记数 */function heatmap(days = 120) {
  const since = Date.now() - Number(days) * 86400000;
  const rows = db.prepare(`SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n FROM memos WHERE created_at >= ? GROUP BY day ORDER BY day`).all(since);
  const map = {};
  for (const r of rows) map[r.day] = r.n;
  return map;
}

const selectBase = `SELECT id, slug, content, created_at, updated_at, pinned, source FROM memos`;

function listMemos({ tag = '', excludeTag = '', search = '', pin, since, until, random = false, has = '', source = '', order = '', onThisDay = false, limit = 50, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (pin !== undefined && pin !== null) {
    where.push('pinned = ?');
    args.push(pin ? 1 : 0);
  }
  if (since) {
    where.push('created_at >= ?');
    args.push(Number(since));
  }
  if (until) {
    where.push('created_at < ?');
    args.push(Number(until));
  }
  if (tag) {
    where.push(`id IN (SELECT mt.memo_id FROM memo_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?)`);
    args.push(tag);
  }
  if (excludeTag) {
    where.push(`id NOT IN (SELECT mt.memo_id FROM memo_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ? OR t.name LIKE ?)`);
    args.push(excludeTag, excludeTag + '/%');
  }
  // has 支持逗号分隔的多个条件，彼此为“且”
  for (const h of String(has || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (h === 'notags') {
      where.push('id NOT IN (SELECT memo_id FROM memo_tags)');
    } else if (h === 'images' || h === 'videos' || h === 'audio') {
      const prefix = h === 'images' ? 'image/' : h === 'videos' ? 'video/' : 'audio/';
      where.push('id IN (SELECT memo_id FROM files WHERE memo_id IS NOT NULL AND mime LIKE ?)');
      args.push(prefix + '%');
    } else if (h === 'files') {
      where.push('id IN (SELECT memo_id FROM files WHERE memo_id IS NOT NULL)');
    } else if (h === 'links') {
      where.push(`(content LIKE '%http://%' OR content LIKE '%https://%' OR content LIKE '%[[]%')`);
    }
  }
  if (source === 'ai') {
    where.push(`(source = 'ai' OR content LIKE '#AI/%')`);
  } else if (source === 'local') {
    where.push(`(source = 'local' AND content NOT LIKE '#AI/%')`);
  } else if (source === 'import') {
    where.push(`source = 'import'`);
  }
  if (onThisDay) {
    const now = new Date();
    const md = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    where.push(`strftime('%m-%d', created_at / 1000, 'unixepoch', 'localtime') = ? AND strftime('%Y', created_at / 1000, 'unixepoch', 'localtime') < ?`);
    args.push(md, String(now.getFullYear()));
  }
  if (search) {
    // 正文和批注一起搜：正文走 FTS，批注走 LIKE
    const like = '%' + search + '%';
    if (fts) {
      where.push(`(id IN (SELECT rowid FROM memos_fts WHERE memos_fts MATCH ?) OR id IN (SELECT memo_id FROM memo_comments WHERE content LIKE ?))`);
      args.push(search.replace(/["*]/g, ' ').trim() + '*');
      args.push(like);
    } else {
      where.push(`(content LIKE ? OR id IN (SELECT memo_id FROM memo_comments WHERE content LIKE ?))`);
      args.push(like);
      args.push(like);
    }
  }
  const orderSql = random ? 'ORDER BY RANDOM()'
    : order === 'created_asc' ? 'ORDER BY pinned DESC, created_at ASC'
    : order === 'updated_desc' ? 'ORDER BY pinned DESC, updated_at DESC'
    : 'ORDER BY pinned DESC, created_at DESC';
  if (random) {
    const sql = `${selectBase} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${orderSql} LIMIT ?`;
    return hydrate(db.prepare(sql).all(...args, limit));
  }
  const sql = `${selectBase} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ${orderSql} LIMIT ? OFFSET ?`;
  return hydrate(db.prepare(sql).all(...args, limit, offset));
}

function countMemos() {
  return db.prepare('SELECT COUNT(*) AS n FROM memos').get().n;
}

function getMemo(id) {
  const row = db.prepare(`${selectBase} WHERE id = ?`).get(id);
  return row ? { ...row, tags: tagsOf(row.id), files: filesOf(row.id), comments: commentsOf(row.id) } : null;
}

function createMemo(content, { createdAt, source = 'local', pinned = 0 } = {}) {
  const t = createdAt || now();
  const slug = newSlug();
  const info = db.prepare('INSERT INTO memos(slug, content, created_at, updated_at, pinned, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(slug, content, t, t, pinned ? 1 : 0, source);
  const id = Number(info.lastInsertRowid);
  syncTags(id, content);
  return getMemo(id);
}

function updateMemo(id, { content, pinned }) {
  const old = db.prepare('SELECT * FROM memos WHERE id = ?').get(id);
  if (!old) return null;
  const next = {
    content: content === undefined ? old.content : content,
    pinned: pinned === undefined ? old.pinned : pinned ? 1 : 0,
    updated_at: now(),
  };
  db.prepare('UPDATE memos SET content = ?, pinned = ?, updated_at = ? WHERE id = ?').run(next.content, next.pinned, next.updated_at, id);
  if (content !== undefined) syncTags(id, next.content);
  return getMemo(id);
}

function deleteMemo(id) {
  const r = db.prepare('DELETE FROM memos WHERE id = ?').run(id);
  if (r.changes > 0) pruneTags();
  return r.changes > 0;
}

function listTags() {
  return db.prepare(`
    SELECT t.name, COUNT(mt.memo_id) AS count, t.pinned, t.icon, t.sort_order
    FROM tags t LEFT JOIN memo_tags mt ON mt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.pinned DESC, t.sort_order ASC, count DESC, t.name ASC
  `).all();
}

/* ---------------- 标签管理 ---------------- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TAG_CHAR = `[^\\s#，。！？、；：,.!?;:()（）\\[\\]【】"'“”‘’]`;

function tagPattern(name) {
  return new RegExp('#' + esc(name) + '(?!' + TAG_CHAR + ')', 'g');
}

function ensureTag(name) {
  const clean = String(name || '').trim().replace(/^#/, '');
  if (!clean) throw new Error('标签名不能为空');
  db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)').run(clean);
  return clean;
}

function setTagMeta(name, patch = {}) {
  const clean = String(name || '').replace(/^#/, '');
  let row = db.prepare('SELECT * FROM tags WHERE name = ?').get(clean);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)').run(clean);
    row = db.prepare('SELECT * FROM tags WHERE name = ?').get(clean);
  }
  if (!row) throw new Error('标签不存在：' + clean);
  const pinned = patch.pinned === undefined ? row.pinned : patch.pinned ? 1 : 0;
  const icon = patch.icon === undefined ? row.icon : String(patch.icon).slice(0, 4);
  db.prepare('UPDATE tags SET pinned = ?, icon = ? WHERE id = ?').run(pinned, icon, row.id);
  return db.prepare('SELECT name, pinned, icon FROM tags WHERE id = ?').get(row.id);
}

/** 重命名（或移动）标签：name -> next，子标签一并跟着改名，正文里的 #tag 也重写 */
function renameTag(fromRaw, toRaw) {
  const from = String(fromRaw || '').replace(/^#/, '').trim();
  const to = String(toRaw || '').replace(/^#/, '').replace(/\/+$/, '').trim();
  if (!from || !to) throw new Error('标签名不能为空');
  if (from === to) return { changed: 0, merged: false };
  if (to.startsWith(from + '/')) throw new Error('不能移动到自己里面');

  const affected = db.prepare('SELECT name FROM tags WHERE name = ? OR name LIKE ?').all(from, from + '/%').map((r) => r.name);
  if (!affected.length && !db.prepare('SELECT 1 FROM tags WHERE name = ?').get(from)) throw new Error('标签不存在：' + from);
  affected.sort((a, b) => b.length - a.length); // 先替换更长的子标签名

  const memoIds = new Set();
  for (const oldName of affected) {
    const rows = db.prepare(`SELECT mt.memo_id FROM memo_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?`).all(oldName);
    for (const r of rows) memoIds.add(r.memo_id);
  }

  const targetExists = !!db.prepare('SELECT id FROM tags WHERE name = ?').get(to);
  let changed = 0;
  const tx = db.prepare('BEGIN');
  try {
    tx.run();
    for (const id of memoIds) {
      const memo = db.prepare('SELECT id, content FROM memos WHERE id = ?').get(id);
      let content = memo.content;
      for (const oldName of affected) {
        const nextName = to + oldName.slice(from.length);
        content = content.replace(tagPattern(oldName), '#' + nextName);
      }
      if (content !== memo.content) {
        db.prepare('UPDATE memos SET content = ?, updated_at = ? WHERE id = ?').run(content, now(), id);
        changed++;
      }
      syncTags(id, content);
    }
    db.prepare('DELETE FROM tags WHERE name = ? OR name LIKE ?').run(from, from + '/%');
    // 补上新的祖先节点，保证「移动到…」之后父标签仍然存在
    const parts = to.split('/');
    for (let i = 1; i < parts.length; i++) db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)').run(parts.slice(0, i).join('/'));
    if (targetExists) pruneTags();
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  return { changed, merged: targetExists };
}

/** 删除标签：从正文里去掉 #tag（含子标签），标签本身消失 */
function deleteTag(nameRaw) {
  const name = String(nameRaw || '').replace(/^#/, '').trim();
  if (!name) throw new Error('标签名不能为空');
  const affected = db.prepare('SELECT name FROM tags WHERE name = ? OR name LIKE ?').all(name, name + '/%').map((r) => r.name);
  if (!affected.length) throw new Error('标签不存在：' + name);
  affected.sort((a, b) => b.length - a.length);

  const memoIds = new Set();
  for (const n of affected) {
    const rows = db.prepare(`SELECT mt.memo_id FROM memo_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?`).all(n);
    for (const r of rows) memoIds.add(r.memo_id);
  }
  let changed = 0;
  for (const id of memoIds) {
    const memo = db.prepare('SELECT id, content FROM memos WHERE id = ?').get(id);
    let content = memo.content;
    for (const n of affected) content = content.replace(tagPattern(n), '');
    content = content.split(String.fromCharCode(10)).map((line) => line.replace(/[ ]{2,}/g, ' ')).join(String.fromCharCode(10)).trim();
    db.prepare('UPDATE memos SET content = ?, updated_at = ? WHERE id = ?').run(content, now(), id);
    syncTags(id, content);
    changed++;
  }
  db.prepare('DELETE FROM tags WHERE name = ? OR name LIKE ?').run(name, name + '/%');
  return { changed };
}

/** 标签树：按 "/" 分层 */
function tagTree() {
  const flat = listTags();
  const nodes = new Map();
  const roots = [];
  const ensure = (pathName) => {
    if (nodes.has(pathName)) return nodes.get(pathName);
    const leaf = flat.find((t) => t.name === pathName);
    const node = { name: pathName, label: pathName.split('/').pop(), count: leaf ? leaf.count : 0, pinned: leaf ? leaf.pinned : 0, icon: leaf ? leaf.icon : '', children: [] };
    nodes.set(pathName, node);
    const cut = pathName.lastIndexOf('/');
    if (cut === -1) roots.push(node);
    else ensure(pathName.slice(0, cut)).children.push(node);
    return node;
  };
  for (const t of flat) ensure(t.name);
  return roots.sort(sortNode);
}

function sortNode(a, b) {
  if (a.pinned !== b.pinned) return b.pinned - a.pinned;
  if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
  return a.name.localeCompare(b.name);
}

function memosBetween(fromMs, toMs) {
  return hydrate(db.prepare(`${selectBase} WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC`).all(fromMs, toMs));
}

function randomMemos(n = 5) {
  return hydrate(db.prepare(`${selectBase} ORDER BY RANDOM() LIMIT ?`).all(n));
}

function memosByIds(ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return hydrate(db.prepare(`${selectBase} WHERE id IN (${ph}) ORDER BY created_at ASC`).all(...ids));
}

function saveAiNote({ kind, memoIds = [], prompt = '', content }) {
  const info = db.prepare('INSERT INTO ai_notes(kind, memo_ids, prompt, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, JSON.stringify(memoIds), prompt, content, now());
  return { id: Number(info.lastInsertRowid), kind, memo_ids: memoIds, prompt, content, created_at: now() };
}

function listAiNotes(limit = 20) {
  return db.prepare('SELECT * FROM ai_notes ORDER BY created_at DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, memo_ids: JSON.parse(r.memo_ids || '[]') }));
}

function exportAll() {
  return {
    version: 1,
    exported_at: now(),
    memos: hydrate(db.prepare(`${selectBase} ORDER BY created_at ASC`).all()),
    ai_notes: db.prepare('SELECT * FROM ai_notes ORDER BY created_at ASC').all(),
  };
}

function importAll(payload) {
  let added = 0;
  const items = Array.isArray(payload) ? payload : payload.memos || [];
  for (const m of items) {
    if (!m || typeof m.content !== 'string') continue;
    const dup = db.prepare('SELECT id FROM memos WHERE content = ? AND created_at = ?').get(m.content, m.created_at || now());
    if (dup) continue;
    createMemo(m.content, { createdAt: m.created_at, source: m.source || 'import', pinned: m.pinned ? 1 : 0 });
    added += 1;
  }
  return { added };
}

function stats() {
  const total = countMemos();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayCount = db.prepare('SELECT COUNT(*) AS n FROM memos WHERE created_at >= ?').get(today.getTime()).n;
  const days = db.prepare(`SELECT DISTINCT date(created_at/1000, 'unixepoch', 'localtime') AS d FROM memos ORDER BY d DESC`).all().length;
  const tagCount = db.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
  return { total, today: todayCount, days, tags: tagCount };
}

function importMemo({ originSlug, content, createdAt, pinned = 0, source = 'import' }) {
  const exists = db.prepare('SELECT id FROM memos WHERE origin_slug = ?').get(originSlug);
  if (exists) return { inserted: false, id: exists.id };
  const t = createdAt || now();
  const info = db.prepare(
    'INSERT INTO memos(slug, content, created_at, updated_at, pinned, source, origin_slug) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(newSlug(), content, t, t, pinned ? 1 : 0, source, originSlug);
  const id = Number(info.lastInsertRowid);
  syncTags(id, content);
  return { inserted: true, id };
}

module.exports = {
  ensureTag, setTagMeta, renameTag, deleteTag, tagTree, listTags,
  db, fts, listMemos, countMemos, getMemo, createMemo, updateMemo, deleteMemo,
  listTags, memosBetween, randomMemos, memosByIds, saveAiNote, listAiNotes,
  exportAll, importAll, stats, extractTags, syncTags, importMemo,
  filesOf, addFile, attachFiles, parseLinkTargets, resolveLinkTarget, backlinksOf, forwardLinksOf, heatmap,
  relatedMemos, tokensOf,
  commentsOf, commentCount, commentHit, commentById, addComment, deleteComment,
  reminders, reminderCount, clearReminder, setReminder,
};
