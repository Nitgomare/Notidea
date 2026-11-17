'use strict';

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
};

const state = {
  filter: { type: 'all' },
  has: '',
  memos: [],
  offset: 0,
  limit: 30,
  hasMore: false,
  search: '',
  tags: [],
  tagTree: [],
  heatmap: {},
  stats: { total: 0, today: 0, days: 0, tags: 0 },
  llm: { hasKey: false },
  tagSort: 'count',
  tagSearch: '',
  collapsed: {},
  pendingFiles: [],
  aiSkill: 'ask',
  aiText: '',
  heatMonth: null,
  // 默认折叠；只有用户明确展开过（存了 '1'）才展开
  subnavOpen: false, // 每次启动默认收起
  // 视图：排序 / 来源 / 搜索筛选
  view: { order: '', source: '', since: 0, until: 0, range: '', tagMode: '', tag: '', fhas: [], onThisDay: false },
  selecting: false,
  selected: new Set(),
};

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('out');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('out');
    toastTimer = setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 250);
  }, 2200);
}

/* 动效辅助：重放一个一次性动画类 */
function replayClass(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
let bornMemoId = null;

const pad = (n) => String(n).padStart(2, '0');
const pad2 = pad;
const fmtTime = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
function dayLabel(ms) {
  const k = dayKey(ms);
  if (k === dayKey(Date.now())) return '今天';
  if (k === dayKey(Date.now() - 86400000)) return '昨天';
  const d = new Date(ms);
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

/* ---------------- 文本渲染 ---------------- */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 先转义，再处理 #标签 / [[链接]] / 粗体 / 行内代码 / URL；不把用户内容当 HTML 执行 */
function renderContent(text, highlight = '') {  let html = escapeHtml(text);

  // [[链接]]：手工扫描，避免正则转义问题
  let out = '';
  let i = 0;
  while (i < html.length) {
    const s = html.indexOf('[[', i);
    if (s === -1) { out += html.slice(i); break; }
    const e = html.indexOf(']]', s + 2);
    if (e === -1) { out += html.slice(i); break; }
    out += html.slice(i, s);
    const target = html.slice(s + 2, e).trim();
    out += '<span class="wikilink" data-target="' + target.replace(/"/g, '&quot;') + '">' + target + '</span>';
    i = e + 2;
  }
  html = out;

  html = html.replace(/#([^<>\s#，。！？、；：,.!?;:()（）\[\]【】]+)/g, '<span class="tag" data-tag="$1">#$1</span>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  if (highlight) {
    const safe = escapeHtml(highlight).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp('(' + safe + ')', 'gi'), '<mark>$1</mark>');
  }
  return html;
}

/* ---------------- Markdown 渲染（AI 输出用） ----------------
   先整体转义，再按行组装块级结构；行内只认 **粗体** / *斜体* / `代码` / 链接 / #标签 */
function inlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/#([^<>\s#，。！？、；：,.!?;:()（）\[\]【】]+)/g, '<span class="tag" data-tag="$1">#$1</span>');
  return s;
}

function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = '';
  let inCode = false;
  let codeBuf = [];
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = ''; } };
  const flushCode = () => { out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; };
  const cellsOf = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) {
      closeList();
      if (inCode) { flushCode(); inCode = false; } else { inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lv = Math.min(m[1].length, 4);
      out.push('<h' + lv + '>' + inlineMd(m[2]) + '</h' + lv + '>');
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { closeList(); out.push('<blockquote>' + inlineMd(m[1]) + '</blockquote>'); continue; }
    // 表格：| a | b |  紧跟一行 | --- | --- |
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const sep = (lines[i + 1] || '').trim();
      if (/^\|?[\s:|-]+\|?$/.test(sep) && sep.indexOf('-') >= 0) {
        closeList();
        const head = cellsOf(line);
        let html = '<table><thead><tr>' + head.map((c) => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          html += '<tr>' + cellsOf(lines[i]).map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>';
          i++;
        }
        i--;
        out.push(html + '</tbody></table>');
        continue;
      }
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + inlineMd(m[1]) + '</li>');
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + inlineMd(m[1]) + '</li>');
      continue;
    }
    closeList();
    out.push('<p>' + inlineMd(line) + '</p>');
  }
  closeList();
  if (inCode && codeBuf.length) flushCode();
  return out.join('\n');
}

/** 流式输出时按 60ms 节流重绘，避免每个 delta 都全量渲染 */
function makeMdPainter(el) {
  let last = 0;
  return function paint(text, force) {
    const now = Date.now();
    if (!force && now - last < 60) return;
    last = now;
    el.innerHTML = renderMarkdown(text);
    el.scrollTop = el.scrollHeight;
  };
}

/* ---------------- 热力图（按周列，按周列：7 行 × N 周，底部月份） ---------------- */
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const HEAT_WEEKS = 10;
let heatLoadedDays = 154;

function heatMonthStart() {
  if (state.heatOffset == null) state.heatOffset = 0;
  return state.heatOffset;
}

function showHeatTip(cell, x, y) {
  const tip = $('#heat-tip');
  tip.innerHTML = '<b>' + cell.n + '</b> 条笔记 · ' + cell.label;
  tip.hidden = false;
  const rect = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8);
  tip.style.left = left + 'px';
  tip.style.top = Math.max(8, y - rect.height - 12) + 'px';
  tip.classList.add('show');
}

function hideHeatTip() {
  const tip = $('#heat-tip');
  tip.classList.remove('show');
  tip.hidden = true;
}

function heatRange() {
  const offset = heatMonthStart();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const mondayIdx = (today.getDay() + 6) % 7;
  const lastMonday = new Date(today); lastMonday.setDate(today.getDate() - mondayIdx - offset * HEAT_WEEKS * 7);
  const start = new Date(lastMonday); start.setDate(lastMonday.getDate() - (HEAT_WEEKS - 1) * 7);
  return { start, today };
}

async function ensureHeatData() {
  const { start } = heatRange();
  const need = Math.ceil((Date.now() - start.getTime()) / 86400000) + 1;
  if (need <= heatLoadedDays) return;
  const days = Math.min(400, need + 7 * HEAT_WEEKS);
  try {
    const { heatmap } = await api('/api/heatmap?days=' + days);
    state.heatmap = Object.assign({}, heatmap, state.heatmap);
    heatLoadedDays = days;
  } catch (e) { /* 忽略，按已有数据画 */ }
}

function renderHeatmap() {
  const grid = $('#heat-grid');
  const months = $('#heat-months');
  const { start, today } = heatRange();
  const todayKey = dayKey(today.getTime());
  const max = Math.max(1, ...Object.values(state.heatmap));
  grid.innerHTML = '';
  grid.style.setProperty('--weeks', HEAT_WEEKS);
  if (months) { months.innerHTML = ''; months.style.setProperty('--weeks', HEAT_WEEKS); }

  let lastMonth = -1;
  for (let w = 0; w < HEAT_WEEKS; w++) {
    for (let r = 0; r < 7; r++) {
      const d = new Date(start); d.setDate(start.getDate() + w * 7 + r);
      const key = dayKey(d.getTime());
      const n = state.heatmap[key] || 0;
      const cell = document.createElement('div');
      cell.className = 'heat-cell day';
      cell.style.setProperty('--i', w * 7 + r);
      if (n > 0) cell.classList.add('l' + Math.min(4, 1 + Math.floor((n / max) * 3.999)));
      if (key === todayKey) cell.classList.add('today');
      if (key > todayKey) cell.classList.add('future');
      if (key === state.filter.value && state.filter.type === 'day') cell.classList.add('picked');
      cell.dataset.key = key;
      cell.dataset.n = n;
      cell.dataset.label = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 周' + WEEK_LABELS[r];
      grid.appendChild(cell);
      // 月份标签：该列包含某月 1 号，或第一列
      if (months && r === 0) {
        const colEnd = new Date(d); colEnd.setDate(d.getDate() + 6);
        const m = (w === 0) ? d.getMonth() : (colEnd.getDate() <= 7 ? colEnd.getMonth() : -1);
        if (m !== -1 && m !== lastMonth) {
          const lab = document.createElement('span');
          lab.textContent = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'][m] + '月';
          lab.style.gridColumn = (w + 1) + ' / span 3';
          months.appendChild(lab);
          lastMonth = m;
        }
      }
    }
  }
  const end = new Date(start); end.setDate(start.getDate() + HEAT_WEEKS * 7 - 1);
  const fmt = (x) => (x.getMonth() + 1) + '.' + x.getDate();
  $('#heat-month').textContent = (start.getFullYear() !== today.getFullYear() ? start.getFullYear() + ' · ' : '') + fmt(start) + ' – ' + fmt(end > today ? today : end);
  $('#heat-next').disabled = heatMonthStart() === 0;
}

$('#heat').addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.heat-cell.day');
  if (!cell) return;
  const r = cell.getBoundingClientRect();
  showHeatTip({ n: Number(cell.dataset.n) || 0, label: cell.dataset.label }, r.left + r.width / 2, r.top);
});
$('#heat').addEventListener('mouseout', (e) => {
  if (e.target.closest('.heat-cell.day')) hideHeatTip();
});
$('#heat').addEventListener('click', async (e) => {
  const btn = e.target.closest('#heat-prev, #heat-next');
  if (btn) {
    const delta = btn.id === 'heat-prev' ? 1 : -1;
    state.heatOffset = Math.max(0, heatMonthStart() + delta);
    hideHeatTip();
    await ensureHeatData();
    const grid = $('#heat-grid');
    grid.classList.remove('slide-l', 'slide-r');
    void grid.offsetWidth;
    grid.classList.add(delta > 0 ? 'slide-r' : 'slide-l');
    renderHeatmap();
    return;
  }
  const cell = e.target.closest('.heat-cell.day');
  if (!cell || cell.classList.contains('future')) return;
  hideHeatTip();
  setFilter({ type: 'day', value: cell.dataset.key });
});


/* ---------------- 标签树 ---------------- */
function buildTreeView() {
  const q = state.tagSearch.trim().toLowerCase();
  const walk = (nodes, depth) => {
    const out = [];
    for (const n of nodes) {
      const kids = walk(n.children || [], depth + 1);
      const hit = !q || n.name.toLowerCase().includes(q) || kids.length > 0;
      if (!hit) continue;
      out.push({ node: n, depth, kids });
    }
    return out;
  };
  return walk(state.tagTree, 0);
}

function tagRow(node, depth) {
  const el = document.createElement('div');
  el.className = 'tag-row';
  el.dataset.name = node.name;
  const hasKids = (node.children || []).length > 0;
  const isClosed = state.collapsed[node.name];
  el.innerHTML =
    '<span class="tag-caret">' + (hasKids ? (isClosed ? '▸' : '▾') : '') + '</span>' +
    '<span class="tag-ico">' + (node.icon || (node.pinned ? '📌' : '')) + '</span>' +
    '<span class="tag-name">' + escapeHtml(node.label || node.name) + '</span>' +
    '<span class="tag-count">' + (node.count || 0) + '</span>' +
    '<button class="tag-more" title="标签操作">⋯</button>';
  el.style.paddingLeft = 6 + depth * 12 + 'px';
  if (state.filter.type === 'tag' && state.filter.value === node.name) el.classList.add('active');
  el.querySelector('.tag-name').onclick = (e) => { e.stopPropagation(); setFilter({ type: 'tag', value: node.name }); };
  el.querySelector('.tag-caret').onclick = (e) => {
    e.stopPropagation();
    if (!hasKids) return;
    state.collapsed[node.name] = !isClosed;
    renderTags();
  };
  el.querySelector('.tag-more').onclick = (e) => { e.stopPropagation(); openTagMenu(e.currentTarget, node); };
  return el;
}

function renderTagNodes(nodes, depth, container) {
  for (const item of nodes) {
    container.appendChild(tagRow(item.node, depth));
    if ((item.node.children || []).length && !state.collapsed[item.node.name]) {
      renderTagNodes(item.kids, depth + 1, container);
    }
  }
}

function renderTags() {
  const box = $('#tag-list');
  box.innerHTML = '';
  $('#stat-tags').textContent = state.tags.length;
  const rows = buildTreeView();
  if (!rows.length) {
    box.innerHTML = '<div class="muted small" style="padding:6px 9px">' + (state.tagSearch ? '没有匹配的标签' : '还没有标签') + '</div>';
    return;
  }
  renderTagNodes(rows, 0, box);
}

/* ---------------- 标签操作菜单 ---------------- */
let menuTag = null;
function openTagMenu(anchor, node) {
  menuTag = node;
  const menu = $('#tag-menu');
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pinBtn = menu.querySelector('[data-act="pin"]');
  pinBtn.textContent = node.pinned ? '取消置顶' : '置顶';
  // 小窗口下放不下就往上翻，并夹在视口内
  const mw = menu.offsetWidth || 190;
  const mh = menu.offsetHeight || 220;
  const vh = window.innerHeight;
  let left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > vh - 8) top = r.top - mh - 6 >= 8 ? r.top - mh - 6 : Math.max(8, vh - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

document.addEventListener('click', (e) => {
  const menu = $('#tag-menu');
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.tag-more')) menu.hidden = true;
});

$('#tag-menu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !menuTag) return;
  const act = btn.dataset.act;
  const node = menuTag;
  $('#tag-menu').hidden = true;
  try {
    if (act === 'pin') {
      const r = await api('/api/tags/meta', { method: 'POST', body: { name: node.name, pinned: !node.pinned } });
      applyTags(r);
      toast(node.pinned ? '已取消置顶' : '已置顶');
    } else if (act === 'copy') {
      await navigator.clipboard.writeText('#' + node.name);
      toast('已复制 #' + node.name);
    } else if (act === 'edit') {
      openTagEdit(node);
    } else if (act === 'move') {
      openTagEdit(node, true);
    } else if (act === 'delete') {
      if (!confirm('删除标签 #' + node.name + '？\n正文里的这个标签也会被去掉，笔记本身保留。')) return;
      const r = await api('/api/tags/delete', { method: 'POST', body: { name: node.name } });
      applyTags(r);
      if (state.filter.type === 'tag' && state.filter.value.startsWith(node.name)) setFilter({ type: 'all' });
      await loadMemos();
      toast('标签已删除');
    }
  } catch (err) { toast(err.message); }
});

function applyTags(r) {
  if (r.tags) state.tags = r.tags;
  if (r.tagTree) state.tagTree = r.tagTree;
  if (r.stats) state.stats = r.stats;
  if (r.heatmap) state.heatmap = r.heatmap;
  renderTags();
  renderHeatmap();
  renderStats();
}

let editingTag = null;
function openTagEdit(node, focusMove = false) {
  editingTag = node;
  $('#te-name').value = node.name;
  $('#te-icon').value = node.icon || '';
  const sel = $('#te-parent');
  sel.innerHTML = '<option value="">（顶层）</option>';
  for (const t of state.tags) {
    if (t.name === node.name || t.name.startsWith(node.name + '/')) continue;
    const o = document.createElement('option');
    o.value = t.name;
    o.textContent = t.name;
    sel.appendChild(o);
  }
  const cut = node.name.lastIndexOf('/');
  sel.value = focusMove ? '' : (cut > 0 ? node.name.slice(0, cut) : '');
  $('#te-note').textContent = focusMove ? '选一个父标签，整个分支会移过去' : '改名会同时改写所有笔记里的 #标签';
  $('#tag-edit').showModal();
  if (focusMove) sel.focus();
}

$('#btn-te-save').onclick = async (e) => {
  if (!editingTag) return;
  const name = $('#te-name').value.trim().replace(/^#/, '');
  const icon = $('#te-icon').value.trim();
  const parent = $('#te-parent').value;
  if (!name) { e.preventDefault(); toast('标签名不能为空'); return; }
  const leaf = name.split('/').pop();
  const next = parent ? parent + '/' + leaf : name;
  try {
    if (next !== editingTag.name) {
      const r = await api('/api/tags/rename', { method: 'POST', body: { from: editingTag.name, to: next } });
      applyTags(r);
      await loadMemos();
    }
    if (icon !== (editingTag.icon || '')) {
      const r = await api('/api/tags/meta', { method: 'POST', body: { name: next, icon } });
      applyTags(r);
    }
    toast('标签已更新');
  } catch (err) { e.preventDefault(); toast(err.message); }
};

/* ---------------- 笔记列表 ---------------- */
function fileBlock(f) {
  if (f.mime.startsWith('image/')) {
    return '<a class="att-img" href="' + f.url + '" target="_blank"><img src="' + f.url + '" alt="' + escapeHtml(f.name) + '" loading="lazy"></a>';
  }
  if (f.mime.startsWith('video/')) {
    return '<video class="att-video" controls preload="metadata" src="' + f.url + '"></video>';
  }
  return '<audio class="att-audio" controls preload="metadata" src="' + f.url + '"></audio>';
}

function memoNode(m) {
  const el = document.createElement('article');
  el.className = 'memo' + (m.pinned ? ' pinned' : '');
  el.dataset.id = m.id;
  const words = (m.content || '').replace(/\s+/g, '').length;
  const backCount = Array.isArray(m.backlinks) ? m.backlinks.length : Number(m.backlinks || 0);
  const commentCount = Array.isArray(m.comments) ? m.comments.length : Number(m.comments || 0);
  const isEdited = m.updated_at && m.updated_at - m.created_at > 60000;
  const cd = new Date(m.created_at);
  const fullTime = cd.getFullYear() + '-' + pad(cd.getMonth() + 1) + '-' + pad(cd.getDate()) + ' ' + fmtTime(m.created_at);
  el.innerHTML =
    '<span class="memo-check" aria-hidden="true"></span>' +
    '<div class="memo-foot memo-head">' +
      '<span class="memo-time" title="' + cd.toLocaleString() + '">' + fullTime + '</span>' +
      '<span class="memo-tags muted small">' + (m.tags || []).map((t) => '#' + escapeHtml(t)).join(' ') + '</span>' +
      (commentCount ? '<button class="memo-comment-count" data-act="comment-toggle" title="批注">✎ ' + commentCount + '</button>' : '') +
      (backCount ? '<span class="memo-back" title="有几条笔记引用了它">↩ ' + backCount + '</span>' : '') +
      '<span class="memo-words muted small">' + words + ' 字' + (isEdited ? ' · 编辑于 ' + fmtTime(m.updated_at) : '') + '</span>' +
      '<div class="memo-actions">' +
        '<button class="memo-ai" data-act="insight" title="用 AI 看这条笔记">✧<span class="ai-label"> AI 洞察</span></button>' +
        '<button class="memo-dot" data-act="menu" title="更多">⋯</button>' +
      '</div>' +
    '</div>' +
    '<div class="memo-body">' + renderContent(m.content, state.search) + '</div>' +
    (m.comment_hit ? '<div class="comment-hit">批注：' + escapeHtml(String(m.comment_hit).slice(0, 120)) + '</div>' : '') +
    (m.files && m.files.length ? '<div class="att-grid">' + m.files.map(fileBlock).join('') + '</div>' : '') +
    '<div class="comment-box" hidden>' +
      '<div class="comment-list"></div>' +
      '<div class="comment-input">' +
        '<input type="text" placeholder="写一句批注…（回车发送；@明天 / @2026-11-20 可设提醒）" maxlength="2000">' +
        '<button class="mini-btn" data-act="comment-send">发送</button>' +
      '</div>' +
    '</div>' +
    '<div class="related-box" hidden></div>';
  return el;
}

function renderList() {
  const list = $('#memo-list');
  list.innerHTML = '';
  if (!state.memos.length) {
    list.innerHTML = '<div class="empty"><h3>这里还没有文字</h3><p>先写一条，哪怕只有一句话。按 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 保存。</p></div>';
    return;
  }
  let lastDay = '';
  let idx = 0;
  const animate = (node) => {
    if (idx < 14) { node.classList.add('enter'); node.style.setProperty('--d', idx); }
    idx++;
  };
  for (const m of state.memos) {
    const k = dayKey(m.created_at);
    if (k !== lastDay) {
      lastDay = k;
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = dayLabel(m.created_at);
      animate(sep);
      list.appendChild(sep);
    }
    const node = memoNode(m);
    if (bornMemoId && m.id === bornMemoId) node.classList.add('born');
    else animate(node);
    list.appendChild(node);
  }
  bornMemoId = null;
  $('#btn-more').hidden = !state.hasMore;
}

function renderStats() {
  const setNum = (sel, v) => {
    const el = $(sel);
    if (!el) return;
    const next = String(v ?? 0);
    if (el.textContent !== next && el.textContent !== '') replayClass(el, 'bump');
    el.textContent = next;
  };
  setNum('#stat-total', state.stats.total);
  setNum('#stat-today', state.stats.today);
  setNum('#stat-days', state.stats.days);
  $('#memo-count').textContent = (state.stats.total ?? 0) + ' 条 · ' + (state.stats.days ?? 0) + ' 天';
}

function fmtRemind(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return '今天 ' + hm;
  const md = (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + ' 年 ' : '') + md + ' ' + hm;
}

function renderReminders(nowTs) {
  const list = $('#memo-list');
  list.innerHTML = '';
  const items = state.reminders || [];
  if (!items.length) {
    list.innerHTML = '<div class="empty"><h3>没有待办的提醒</h3><p>在批注里写 <code>@明天</code>、<code>@2026-11-20</code> 或 <code>@今晚</code>，就会出现在这里。</p></div>';
    return;
  }
  for (const r of items) {
    const overdue = r.remind_at <= (nowTs || Date.now());
    const row = document.createElement('div');
    row.className = 'reminder enter' + (overdue ? ' overdue' : '');
    row.style.setProperty('--d', Math.min(items.indexOf(r), 14));
    row.dataset.memo = r.memo_id;
    row.dataset.cid = r.id;
    row.innerHTML =
      '<div class="reminder-when">' + (overdue ? '已到时间 · ' : '') + escapeHtml(fmtRemind(r.remind_at)) + '</div>' +
      '<div class="reminder-text">' + escapeHtml(r.content) + '</div>' +
      '<div class="reminder-memo">' + escapeHtml(r.memo_excerpt) + '</div>' +
      '<div class="reminder-acts">' +
        '<button class="mini-btn" data-remind="open">打开笔记</button>' +
        '<button class="mini-btn" data-remind="done">标记完成</button>' +
        '<button class="mini-btn" data-remind="calendar">加入 Windows 日历</button>' +
      '</div>';
    list.appendChild(row);
  }
}

/* 提醒列表的按钮 */
$('#memo-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-remind]');
  if (!btn) return;
  const row = ev.target.closest('.reminder');
  if (!row) return;
  if (btn.dataset.remind === 'done') {
    await api('/api/comments/' + row.dataset.cid + '/done', { method: 'POST' });
    toast('已标记完成');
    await loadMemos();
    return;
  }
  if (btn.dataset.remind === 'calendar') {
    try {
      await api('/api/comments/' + row.dataset.cid + '/calendar', { method: 'POST' });
      toast('已交给 Windows 日历，在弹出的窗口里点“保存”即可');
    } catch (e) { toast('加入日历失败：' + e.message); }
    return;
  }
  location.href = '/?memo=' + row.dataset.memo;
});

function renderListTitle() {
  const f = state.filter;
  const hasLabel = { notags: '无标签', images: '有图片', videos: '有视频', audio: '有语音', links: '有链接' }[state.has];
  const title = state.view.onThisDay ? '那年今日' : hasLabel ? '全部笔记 · ' + hasLabel
    : f.type === 'day' ? (() => { const [yy, mm, dd] = String(f.value).split('-').map(Number); return yy + ' 年 ' + mm + ' 月 ' + dd + ' 日'; })()
    : f.type === 'tag' ? '#' + f.value
    : f.type === 'today' ? '今日'
    : f.type === 'pinned' ? '置顶笔记'
    : f.type === 'reminders' ? '提醒'
    : f.type === 'random' ? '随机漫步'
    : '全部笔记';
  const titleEl = $('#list-title');
  if (titleEl.textContent !== title) { titleEl.textContent = title; replayClass(titleEl, 'swap'); }
  $('#list-sub').textContent = state.search ? '搜索「' + state.search + '」' : '';
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', !state.has && a.dataset.filter === f.type));
  document.querySelectorAll('#subnav a').forEach((a) => a.classList.toggle('active', a.dataset.has === state.has));
  renderTags();
}

/* ---------------- 数据加载 ---------------- */
async function loadMemos({ append = false } = {}) {
  const f = state.filter;
  if (f.type === 'reminders') {
    const data = await api('/api/reminders');
    state.reminders = data.reminders || [];
    $('#stat-reminders').textContent = data.count || 0;
    renderReminders(data.now);
    renderListTitle();
    return;
  }
  const q = new URLSearchParams({ limit: state.limit, offset: append ? state.offset : 0 });
  if (f.type === 'tag') q.set('tag', f.value);
  if (f.type === 'day' && f.value) {
    const [yy, mm, dd] = f.value.split('-').map(Number);
    q.set('since', String(new Date(yy, mm - 1, dd).getTime()));
    q.set('until', String(new Date(yy, mm - 1, dd + 1).getTime()));
  }
  if (state.search) q.set('search', state.search);
  const vw = state.view;
  const hasList = [state.has, ...vw.fhas].filter(Boolean);
  if (vw.tagMode === 'notags') hasList.push('notags');
  if (hasList.length) q.set('has', [...new Set(hasList)].join(','));
  if (vw.order) q.set('order', vw.order);
  if (vw.source) q.set('source', vw.source);
  if (vw.onThisDay) q.set('onThisDay', '1');
  if (vw.tag && vw.tagMode === 'include' && f.type !== 'tag') q.set('tag', vw.tag);
  if (vw.tag && vw.tagMode === 'exclude') q.set('excludeTag', vw.tag);
  if (vw.since && !q.has('since')) q.set('since', String(vw.since));
  if (vw.until && !q.has('until')) q.set('until', String(vw.until));
  let memos = (await api('/api/memos?' + q.toString())).memos;
  if (f.type === 'today') {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    memos = memos.filter((m) => m.created_at >= start.getTime());
  }
  if (f.type === 'pinned') memos = memos.filter((m) => m.pinned);
  if (f.type === 'random') {
    memos = memos.slice().sort(() => Math.random() - 0.5).slice(0, 8);
    state.hasMore = false;
  } else {
    state.hasMore = memos.length === state.limit;
  }
  state.memos = append ? state.memos.concat(memos) : memos;
  state.offset = state.memos.length;
  renderList();
  renderListTitle();
}

async function refreshBootstrap() {
  const b = await api('/api/bootstrap');
  state.stats = b.stats;
  state.tags = b.tags;
  state.tagTree = b.tagTree || [];
  state.heatmap = b.heatmap || {};
  state.llm = b.llm;
  renderStats();
  renderHeatmap();
  renderTags();
  $('#db-path').textContent = b.storage.path;
  if (b.reminders !== undefined) $('#stat-reminders').textContent = b.reminders;
}

async function setFilter(f) {
  state.filter = f;
  state.has = '';
  state.view.onThisDay = false;
  state.offset = 0;
  await loadMemos();
}

/* ---------------- 事件：列表 ---------------- */
$('#memo-list').addEventListener('click', async (ev) => {
  const tagEl = ev.target.closest('.tag');
  if (tagEl) { setFilter({ type: 'tag', value: tagEl.dataset.tag }); return; }

  const wl = ev.target.closest('.wikilink');
  if (wl) {
    const target = wl.dataset.target;
    const { memos } = await api('/api/memos?limit=200');
    const bySlug = memos.find((m) => m.slug === target);
    const byId = target.startsWith('#') ? memos.find((m) => String(m.id) === target.slice(1)) : null;
    const byText = memos.find((m) => m.content.startsWith(target));
    const hit = bySlug || byId || byText;
    if (!hit) { toast('没有找到这条笔记：' + target); return; }
    state.memos = [hit];
    renderList();
    $('#list-title').textContent = '跳转：' + target;
    return;
  }

  const link = ev.target.closest('.related-box .rel-chip');
  if (link) {
    const target = link.dataset.id;
    const el = document.querySelector('.memo[data-id="' + target + '"]');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1400);
    } else {
      const got = await api('/api/memos/' + target);
      if (got && got.memo) setFilter({ type: 'day', value: dayKey(got.memo.created_at) });
    }
    return;
  }

  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.memo');
  const act = btn.dataset.act;
  if (act === 'menu') { openMemoMenu(card, btn); return; }
  if (act === 'comment-toggle') { toggleCommentBox(card); return; }
  memoAction(act, card);
});

async function memoAction(act, card) {
  const id = Number(card.dataset.id);
  const memo = state.memos.find((m) => m.id === id);
  if (!memo) return;

  if (act === 'related') {
    const box = card.querySelector('.related-box');
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<span class="muted small">找相似…</span>';
    try {
      const { related } = await api('/api/memos/' + id + '/related?limit=5');
      if (!related.length) { box.innerHTML = '<span class="muted small">还没有足够相似的笔记</span>'; return; }
      box.innerHTML = '<span class="rel-label">相关笔记</span>' + related.map((r) =>
        '<span class="rel-chip" data-id="' + r.id + '" title="相似度 ' + r.score + '">' + escapeHtml(r.excerpt) + '</span>'
      ).join('');
    } catch (e) { box.innerHTML = '<span class="muted small">' + escapeHtml(e.message) + '</span>'; }
    return;
  }

  if (act === 'quote') {
    await navigator.clipboard.writeText('[[' + memo.slug + ']]');
    toast('已复制引用，粘到别的笔记里即可双向链接');
    return;
  }

  if (act === 'del') {
    if (!confirm('删除这条笔记？（本地数据库，不可恢复）')) return;
    await api('/api/memos/' + id, { method: 'DELETE' });
    const gone = document.querySelector('.memo[data-id="' + id + '"]');
    if (gone && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gone.classList.add('leaving');
      await new Promise((r) => setTimeout(r, 360));
    }
    state.memos = state.memos.filter((m) => m.id !== id);
    renderList();
    await refreshBootstrap();
    toast('已删除');
    return;
  }

  if (act === 'pin') {
    const { memo: next } = await api('/api/memos/' + id, { method: 'PUT', body: { pinned: !memo.pinned } });
    Object.assign(memo, next);
    renderList();
    toast(next.pinned ? '已置顶' : '已取消置顶');
    return;
  }

  if (act === 'edit') {
    const bodyEl = card.querySelector('.memo-body');
    const ta = document.createElement('textarea');
    ta.className = 'memo-edit';
    ta.value = memo.content;
    bodyEl.replaceWith(ta);
    ta.focus();
    const done = async (save) => {
      if (save && ta.value.trim() && ta.value !== memo.content) {
        const { memo: next } = await api('/api/memos/' + id, { method: 'PUT', body: { content: ta.value.trim() } });
        Object.assign(memo, next);
        await refreshBootstrap();
        toast('已保存');
      }
      renderList();
    };
    ta.addEventListener('blur', () => done(true));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(true); }
    });
    return;
  }

  if (act === 'insight') {
    openInsight(id);
    runInsight({ id: 'default', name: '单条洞察', category: '复盘整理', days: 0, range: '这条笔记', single: true, memoId: id });
    return;
  }

  if (act === 'copy') {
    await copyText(memo.content);
    toast('已复制内容');
    return;
  }

  if (act === 'share') {
    openShare(memo);
    return;
  }

  if (act === 'copy-link') {
    await copyText(location.origin + '/?memo=' + id);
    toast('链接已复制');
    return;
  }

  if (act === 'open-window') {
    window.open('/?memo=' + id, 'memo-' + id, 'width=760,height=720');
    return;
  }

  if (act === 'float') {
    window.open('/?memo=' + id + '&float=1', 'float-' + id, 'width=400,height=560,menubar=no,toolbar=no,location=no,status=no');
    return;
  }

  if (act === 'export-md') {
    const md = (memo.tags || []).map((t) => '#' + t).join(' ') + '\n\n' + memo.content + '\n';
    downloadFile('memo-' + memo.slug + '.md', md, 'text/markdown');
    return;
  }

  if (act === 'copy-json') {
    await copyText(JSON.stringify(memo, null, 2));
    toast('JSON 已复制');
    return;
  }

  if (act === 'comment') {
    toggleCommentBox(card, true);
    return;
  }

  if (act === 'comment-send') {
    await sendComment(card);
    return;
  }
}

/* 批注输入框回车发送 */
document.getElementById('memo-list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.comment-input input')) {
    e.preventDefault();
    sendComment(e.target.closest('.memo'));
  }
});

/* ---------------- 写作 / 附件 ---------------- */
const draft = $('#draft');
const updateHint = () => { $('#draft-hint').textContent = draft.value.trim().length + ' 字'; };
draft.addEventListener('input', updateHint);

function renderPending() {
  const strip = $('#attach-strip');
  strip.innerHTML = '';
  strip.hidden = state.pendingFiles.length === 0;
  state.pendingFiles.forEach((f, idx) => {
    const item = document.createElement('div');
    item.className = 'att-item';
    item.innerHTML = (f.mime.startsWith('image/') ? '<img src="' + f.preview + '">' : '<span class="att-ico">' + (f.mime.startsWith('video/') ? '▷' : '♪') + '</span>') +
      '<button class="att-del" title="移除">✕</button>';
    item.querySelector('.att-del').onclick = () => { state.pendingFiles.splice(idx, 1); renderPending(); };
    strip.appendChild(item);
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (file.size > 40 * 1024 * 1024) { toast(file.name + ' 超过 40MB'); continue; }
    if (!/^(image|video|audio)\//.test(file.type)) { toast('只支持图片/视频/音频'); continue; }
    const dataBase64 = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.readAsDataURL(file);
    });
    state.pendingFiles.push({ name: file.name, mime: file.type, dataBase64, preview: 'data:' + file.type + ';base64,' + dataBase64 });
  }
  renderPending();
}

$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
draft.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addFiles(files); }
});
['dragover', 'drop'].forEach((ev) => draft.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'drop' && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
}));

async function saveMemo() {
  const content = draft.value.trim();
  if (!content && !state.pendingFiles.length) { toast('写点什么再保存'); return; }
  const body = { content: content || '（附件）' };
  if (state.pendingFiles.length) body.files = state.pendingFiles.map(({ name, mime, dataBase64 }) => ({ name, mime, dataBase64 }));
  if (draftRemind.at) {
    body.remindAt = draftRemind.at;
    body.calendar = draftRemind.calendar;
    body.remindNote = '⏰ ' + (content.replace(/\s+/g, ' ').slice(0, 40) || '提醒');
  }
  const { memo, stats, tags, tagTree, heatmap } = await api('/api/memos', { method: 'POST', body });
  const hadRemind = !!draftRemind.at;
  setDraftRemind(0, false);
  if (hadRemind) refreshReminderCount();
  draft.value = '';
  state.pendingFiles = [];
  renderPending();
  updateHint();
  state.stats = stats;
  applyTags({ tags, tagTree, heatmap });
  state.filter = { type: 'all' };
  state.has = '';
  bornMemoId = memo && memo.id;
  await loadMemos();
  replayClass($('#composer'), 'saved');
  toast('已保存到本地');
  return memo;
}
$('#btn-save').onclick = saveMemo;
$('#btn-new').onclick = () => { draft.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
draft.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveMemo(); }
});

/* ---------------- 搜索 / 过滤 ---------------- */
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value.trim();
  searchTimer = setTimeout(() => {
    state.search = v;
    if (v) { state.filter = { type: 'all' }; state.has = ''; }
    loadMemos();
  }, 220);
});

document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;

  // Ctrl+K 搜索
  if (mod && key === 'k') {
    e.preventDefault();
    $('#search').focus();
    $('#search').select();
    return;
  }

  // Ctrl+Shift+N 新建
  if (mod && e.shiftKey && key === 'n') {
    e.preventDefault();
    $('#btn-new').click();
    $('#draft').focus();
    return;
  }

  // Alt+Shift+A 唤起 AI 面板
  if (e.altKey && e.shiftKey && key === 'a') {
    e.preventDefault();
    toggleRail();
    return;
  }

  // Esc：先关弹窗，再清搜索
  if (e.key === 'Escape') {
    if (APP().classList.contains('side-open') || APP().classList.contains('rail-open')) {
      APP().classList.remove('side-open');
      APP().classList.remove('rail-open');
      syncScrim();
      return;
    }
    const openDialog = [...document.querySelectorAll('dialog[open]')].pop();
    if (openDialog) { openDialog.close(); return; }
    if (document.activeElement === $('#search')) {
      $('#search').value = '';
      state.search = '';
      loadMemos();
      $('#search').blur();
    }
  }
});

document.querySelectorAll('.nav-item[data-filter]').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); setFilter({ type: a.dataset.filter }); });
});
$('#subnav').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-has]');
  if (!a) return;
  e.preventDefault();
  state.has = state.has === a.dataset.has ? '' : a.dataset.has;
  state.filter = { type: 'all' };
  state.offset = 0;
  loadMemos();
});

/* 子筛选抽屉：可收起，状态记在 localStorage */
function applySubnav() {
  const open = state.subnavOpen;
  $('#subnav').classList.toggle('closed', !open);
  $('#subnav-toggle').textContent = open ? '▾' : '▸';
  $('#nav-all').classList.toggle('has-open-sub', open);
}

applySubnav();
$('#subnav-toggle').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  state.subnavOpen = !state.subnavOpen;
  applySubnav();
});
$('#nav-all').addEventListener('click', (e) => { e.preventDefault(); });

$('#tag-search').addEventListener('input', (e) => { state.tagSearch = e.target.value; renderTags(); });
$('#btn-tag-sort').onclick = () => {
  state.tagSort = state.tagSort === 'count' ? 'name' : 'count';
  if (state.tagSort === 'name') {
    const sortByName = (nodes) => nodes.slice().sort((a, b) => a.label.localeCompare(b.label, 'zh')).map((n) => ({ ...n, children: sortByName(n.children || []) }));
    state.tagTree = sortByName(state.tagTree);
  } else {
    refreshBootstrap().catch(() => {});
    return;
  }
  renderTags();
  toast(state.tagSort === 'name' ? '按名称排序' : '按数量排序');
};

/* ---------------- 右栏 AI ---------------- */
const APP = () => document.querySelector('.app');
function syncScrim() {
  const scrim = $('#scrim');
  if (!scrim) return;
  // AI 面板是浮动卡片，不需要遮罩；遮罩只服务于窄屏侧栏抽屉
  scrim.hidden = !APP().classList.contains('side-open');
}
function openRail() {
  APP().classList.add('rail-open');
  if (!$('#rail-tabs .chip.active')) activateRailTab('ask');
  $('#rail-input').hidden = state.aiSkill !== 'ask';
  APP().classList.remove('side-open');
  syncScrim();
  setTimeout(() => { const ask = $('#ask-input'); (state.aiSkill === 'ask' && ask ? ask : $('#btn-ai-run')).focus(); }, 200);
}
function closeRail() { APP().classList.remove('rail-open'); syncScrim(); }
function toggleRail() { if (APP().classList.contains('rail-open')) closeRail(); else openRail(); }
function toggleSide() { APP().classList.toggle('side-open'); syncScrim(); }
$('#btn-rail-close').onclick = closeRail;
$('#btn-ai-fab').onclick = toggleRail;
$('#btn-side').onclick = toggleSide;
$('#scrim').onclick = () => {
  APP().classList.remove('side-open');
  APP().classList.remove('rail-open');
  syncScrim();
};
const btnExpand = $('#btn-expand');
const syncSideExpand = () => { if (btnExpand) btnExpand.hidden = !APP().classList.contains('side-off'); };
$('#btn-collapse').onclick = () => {
  APP().classList.toggle('side-off');
  syncSideExpand();
};
if (btnExpand) {
  btnExpand.onclick = () => { APP().classList.remove('side-off'); syncSideExpand(); };
}
syncSideExpand();

let currentAi = { skill: null, text: '', payload: {} };

async function runAi(skill, payload = {}) {
  if (!state.llm.hasKey) { toast('先到设置里填模型 API Key'); $('#btn-settings').click(); return; }
  const body = $('#rail-body');
  const paint = makeMdPainter(body);
  body.classList.remove('streaming');
  body.innerHTML = '<p class="thinking muted small">思考中<i></i><i></i><i></i></p>';
  $('#btn-ai-save').hidden = true;
  currentAi = { skill, text: '', payload };
  try {
    const res = await fetch('/api/ai/' + skill, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'HTTP ' + res.status);
    }
    body.innerHTML = '';
    body.classList.add('streaming');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\u000a\u000a');
      buf = parts.pop() || '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const json = JSON.parse(line.slice(5).trim());
        if (json.error) throw new Error(json.error);
        if (json.delta) {
          currentAi.text += json.delta;
          paint(currentAi.text);
        }
      }
    }
    paint(currentAi.text, true);
    body.classList.remove('streaming');
    $('#btn-ai-save').hidden = !currentAi.text;
  } catch (e) {
    body.classList.remove('streaming');
    body.innerHTML = '<p class="muted small">生成失败：' + escapeHtml(e.message) + '</p>';
  }
}

/* 右侧面板默认是「跟 AI 对话」：打开时若没有激活的 chip，就选 ask */
function activateRailTab(skill) {
  state.aiSkill = skill;
  const chips = $('#rail-tabs').querySelectorAll('.chip');
  chips.forEach((c) => c.classList.toggle('active', c.dataset.ai === skill));
  const ask = skill === 'ask';
  $('#rail-input').hidden = !ask;
  const run = $('#btn-ai-run');
  if (run) run.textContent = ask ? '问一下' : '生成';
  const body = $('#rail-body');
  if (body && !body.classList.contains('streaming') && !(currentAi && currentAi.text)) {
    body.innerHTML = '<p class="muted small">' + (ask
      ? '输入问题，AI 会检索本地笔记作答；聊过的内容会记住上下文。'
      : '选一个技能，AI 会读取本地笔记生成内容。结果只保存在本地。') + '</p>';
  }
}

/* 追问上下文：从洞察带过来的正文 + 最近几轮对话 */
let railSeed = '';
let railHistory = [];

function railReset(seed = '') {
  railSeed = seed || '';
  railHistory = [];
}

async function askAi(q) {
  const question = q.trim();
  if (!question) { toast('先输入问题'); return; }
  let payload = question;
  const parts = [];
  if (railSeed) parts.push('【刚才的洞察】\n' + railSeed.slice(0, 6000));
  if (railHistory.length) {
    parts.push('【之前的对话】\n' + railHistory.slice(-6).map((m) => (m.role === 'user' ? '我：' : 'AI：') + m.text).join('\n'));
  }
  if (parts.length) payload = parts.join('\n\n') + '\n\n【新问题】' + question;
  railHistory.push({ role: 'user', text: question });
  $('#ask-input').value = '';
  await runAi('ask', { question: payload });
  if (currentAi.text) railHistory.push({ role: 'ai', text: currentAi.text.slice(0, 1500) });
}

$('#rail-tabs').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('#rail-tabs').querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
  state.aiSkill = chip.dataset.ai;
  $('#rail-input').hidden = state.aiSkill !== 'ask';
  $('#rail-body').innerHTML = '<p class="muted small">' + (state.aiSkill === 'ask' ? '输入问题，AI 会检索本地笔记作答。' : '点击「生成」，AI 会读取本地笔记。') + '</p>';
  $('#btn-ai-save').hidden = true;
  if (state.aiSkill === 'ask') $('#ask-input').focus();
});

$('#btn-ai-run').onclick = () => {
  const skill = state.aiSkill;
  if (skill === 'ask') return askAi($('#ask-input').value);
  return runAi(skill, {});
};

/* 洞察结果：带着这条洞察继续对话 */
$('#btn-insight-chat').onclick = () => {
  const text = (insightState && insightState.text) ? insightState.text : ($('#insight-result-body').textContent || '');
  const title = ($('#insight-result-title').textContent || '').trim();
  if (!text.trim()) { toast('先生成一条洞察'); return; }
  railReset('视角：' + (title || '未命名') + '\n' + text.trim());
  dlgInsight.close();
  openRail();
  activateRailTab('ask');
  $('#rail-body').innerHTML = '<p class="muted small">已把这条洞察带进对话，接着问就行（比如“那我该怎么改？”）。</p>';
  setTimeout(() => $('#ask-input').focus(), 120);
};

$('#btn-ai-save').onclick = async () => {
  if (!currentAi.text) return;
  const title = { 'daily-review': '每日回顾', 'weekly-summary': '本周小结', 'random-walk': '随机漫步', insight: 'AI 洞察', ask: '问笔记' }[currentAi.skill] || 'AI';
  await api('/api/memos', { method: 'POST', body: { content: '#AI/' + title + '\u000a' + currentAi.text } });
  await refreshBootstrap();
  await loadMemos();
  toast('已存为笔记');
};

/* ---------------- 标签建议 ---------------- */
$('#btn-tagsuggest').onclick = async () => {
  const content = draft.value.trim();
  if (!content) { toast('先写内容'); return; }
  if (!state.llm.hasKey) { toast('先到设置里填模型 API Key'); return; }
  try {
    const res = await fetch('/api/ai/tag-suggest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    let text = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\u000a')) {
        if (!line.startsWith('data:')) continue;
        try { const j = JSON.parse(line.slice(5).trim()); if (j.delta) text += j.delta; } catch {}
      }
    }
    const tags = (text.match(/#[^\s,#，]+/g) || []).slice(0, 3);
    if (!tags.length) { toast('这个 AI 没给出标签'); return; }
    draft.value = content + (content.endsWith('\u000a') ? '' : '\u000a') + tags.join(' ');
    updateHint();
    toast('已追加建议标签，可自行删改');
  } catch (e) { toast('建议失败：' + e.message); }
};

/* ---------------- 设置 ---------------- */
$('#btn-settings').onclick = async () => {
  const b = await api('/api/bootstrap');
  state.llm = b.llm;
  $('#cfg-base').value = b.llm.baseUrl || '';
  $('#cfg-model').value = b.llm.model || '';
  $('#cfg-temp').value = b.llm.temperature ?? 0.7;
  $('#cfg-key').value = '';
  $('#cfg-note').textContent = b.llm.hasKey ? '已保存 Key：' + b.llm.keyHint + '（留空则不修改）' : 'Key 只写入本机 data/llm.json';
  $('#app-version').textContent = 'v' + ((b.app && b.app.version) || '—');
  $('#update-note').textContent = '';
  $('#settings').showModal();
  refreshDataDir();
};

$('#btn-check-update').onclick = async () => {
  const note = $('#update-note');
  note.textContent = '正在检查…';
  $('#btn-do-update').hidden = true;
  try {
    const r = await api('/api/update/check?force=1');
    if (r.error) { note.textContent = '检查失败：' + r.error + '（离线也能正常用）'; return; }
    if (r.hasUpdate) {
      // 新版介绍是 Markdown（release notes），渲染出来，别直接塞纯文本
      var notesHtml = r.notes ? '<div class="md update-notes">' + renderMarkdown(r.notes) + '</div>' : '';
      note.innerHTML = '发现新版本 <b>v' + escapeHtml(r.latest) + '</b>' + notesHtml;
      $('#btn-do-update').hidden = false;
      $('#btn-do-update').textContent = '下载并安装 v' + r.latest;
    } else {
      note.textContent = '已是最新版本（v' + r.current + '）';
    }
  } catch (e) {
    note.textContent = '检查失败：' + e.message;
  }
};

/** 下载并安装更新；note 显示进度，btn 在更新期间禁用 */
async function installUpdate(note, btn) {
  btn.disabled = true;
  note.textContent = '正在下载并安装…装好后窗口会自动刷新，请不要关掉它';
  try {
    const r = await api('/api/update/apply', { method: 'POST' });
    if (r.error) {
      note.innerHTML = '更新失败：' + escapeHtml(r.error) +
        (r.url ? ' · <a href="' + escapeHtml(r.url) + '" target="_blank" rel="noreferrer">手动下载</a>' : '');
      btn.disabled = false;
      return;
    }
    note.textContent = '已下载 v' + r.latest + '（' + Math.round((r.size || 0) / 1024) + ' KB），正在重启服务…';
    const want = r.latest;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const v = await fetch('/api/version', { cache: 'no-store' }).then((x) => x.json());
        if (v && v.version === want) {
          clearInterval(timer);
          note.textContent = '已更新到 v' + want + '，正在刷新…';
          setTimeout(() => location.reload(), 600);
          return;
        }
      } catch (err) { /* 服务正在重启 */ }
      if (tries > 90) {
        clearInterval(timer);
        note.textContent = '服务没有自己起来，请手动关掉窗口再重新打开应用（数据没动）';
        btn.disabled = false;
      }
    }, 1000);
  } catch (e) {
    note.textContent = '更新失败：' + e.message;
    btn.disabled = false;
  }
}

$('#btn-do-update').onclick = () => installUpdate($('#update-note'), $('#btn-do-update'));

$('#btn-shortcut').onclick = async () => {
  const note = $('#shortcut-note');
  note.textContent = '正在创建…';
  try {
    const r = await api('/api/shortcut', { method: 'POST' });
    note.textContent = '已创建：' + r.path;
  } catch (e) {
    note.textContent = '创建失败：' + e.message + '（也可以双击包里的 创建桌面快捷方式.cmd）';
  }
};
/* ---- 数据目录：可自定义，重装/升级不会动它 ---- */
const dataDirState = { dir: '' };
async function refreshDataDir() {
  const note = $('#data-dir-note');
  try {
    const d = await api('/api/data-dir');
    dataDirState.dir = d.dir;
    if (note) {
      const extra = d.env ? '（由环境变量 NOTIDEA_DATA_DIR 指定）' : '';
      note.textContent = d.dir + extra;
      note.title = '指针文件：' + d.config;
    }
  } catch (e) {
    if (note) note.textContent = '读取失败：' + e.message;
  }
}
$('#btn-data-dir').onclick = async () => {
  let dir = '';
  try {
    if (window.__shell && window.__shell.pickDir) {
      dir = await window.__shell.pickDir(dataDirState.dir);
    } else {
      dir = window.prompt('新的数据目录（留空取消）：', dataDirState.dir || '');
    }
  } catch (e) { /* 取消 */ }
  dir = String(dir || '').trim();
  if (!dir) return;
  if (!window.confirm('把现有笔记复制到：\n' + dir + '\n\n然后重启应用？')) return;
  try {
    const r = await api('/api/data-dir', { method: 'POST', body: { dir, copy: true } });
    await refreshDataDir();
    if (window.__shell && window.__shell.post) {
      window.__shell.post('relaunch');
    } else {
      toast('已切换数据目录，重启应用后生效');
    }
  } catch (e) {
    toast('切换失败：' + e.message);
  }
};
$('#btn-data-open').onclick = async () => {
  try {
    await api('/api/open-data-dir', { method: 'POST' });
  } catch (e) {
    toast('打不开：' + e.message);
  }
};
$('#btn-cfg-save').onclick = async () => {
  await api('/api/config', {
    method: 'POST',
    body: {
      baseUrl: $('#cfg-base').value,
      model: $('#cfg-model').value,
      apiKey: $('#cfg-key').value,
      temperature: Number($('#cfg-temp').value),
    },
  });
  await refreshBootstrap();
  toast('已保存模型配置');
};
const btnExport = $('#btn-export');
if (btnExport) btnExport.onclick = () => { window.location.href = '/api/export'; };
$('#btn-more').onclick = () => loadMemos({ append: true });

/* ---------------- AI 洞察 ---------------- */
const insightState = { scope: { tag: '', days: 0 }, custom: false, perspectives: [], summary: null, running: false, current: null, text: '', target: null };
const CATEGORY_ORDER = ['复盘整理', '自我觉察', '思维决策', '大师视角'];
const dlgInsight = $('#insight');

function insightScopeText() {
  const s = insightState.summary;
  if (!s) return '读取范围…';
  const parts = [s.count + ' 条笔记', s.tags + ' 标签', s.days + ' 天'];
  if (s.scope && s.scope.tag) parts.push('#' + s.scope.tag);
  return parts.join(' / ');
}

function renderInsightPicker() {
  $('#insight-scope-text').textContent = insightScopeText();
  const grid = $('#insight-grid');
  grid.innerHTML = '';
  const cats = [...new Set(insightState.perspectives.map((p) => p.category))];
  cats.sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a); const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const cat of cats) {
    const h = document.createElement('div');
    h.className = 'insight-cat';
    h.textContent = cat;
    grid.appendChild(h);
    const row = document.createElement('div');
    row.className = 'insight-row';
    for (const p of insightState.perspectives.filter((x) => x.category === cat)) {
      const btn = document.createElement('button');
      btn.className = 'insight-card';
      btn.dataset.id = p.id;
      btn.innerHTML =
        '<div class="insight-top"><span class="insight-ico">' + escapeHtml(p.icon || '✧') + '</span><span class="insight-plus">＋</span></div>' +
        '<h4>' + escapeHtml(p.name) + (p.badge ? ' <span class="insight-badge">' + escapeHtml(p.badge) + '</span>' : '') +
        (p.author ? ' <span class="by">by ' + escapeHtml(p.author) + '</span>' : '') + '</h4>' +
        '<p>' + escapeHtml(p.description) + '</p>' +
        '<p class="insight-range">建议范围：' + escapeHtml(p.range) + '</p>';
      btn.onclick = () => runInsight(p);
      row.appendChild(btn);
    }
    grid.appendChild(row);
  }
}

async function loadInsightScope() {
  const q = new URLSearchParams();
  if (insightState.scope.days) q.set('days', String(insightState.scope.days));
  if (insightState.scope.tag) q.set('tag', insightState.scope.tag);
  const data = await api('/api/insights?' + q.toString());
  insightState.perspectives = data.perspectives;
  insightState.summary = data.summary;
  renderInsightPicker();
}

async function openInsight(memoId = null) {
  insightState.target = memoId;
  $('#insight-picker').hidden = false;
  $('#insight-result').hidden = true;
  $('#insight-history').hidden = true;
  $('#scope-editor').hidden = true;
  const sel = $('#scope-tag');
  sel.innerHTML = '<option value="">不限标签</option>' +
    state.tags.map((t) => '<option value="' + escapeHtml(t.name) + '">#' + escapeHtml(t.name) + '</option>').join('');
  sel.value = insightState.scope.tag || '';
  $('#scope-days').value = String(insightState.scope.days || 0);
  dlgInsight.showModal();
  try { await loadInsightScope(); }
  catch (e) { toast('读取洞察视角失败：' + e.message); }
}

$('#nav-insight').onclick = (e) => { e.preventDefault(); openInsight(); };
$('#btn-insight-close').onclick = () => dlgInsight.close();
$('#btn-insight-scope').onclick = (e) => { e.preventDefault(); $('#scope-editor').hidden = !$('#scope-editor').hidden; };
$('#btn-scope-apply').onclick = async () => {
  insightState.scope = { days: Number($('#scope-days').value) || 0, tag: $('#scope-tag').value || '' };
  insightState.custom = true;
  $('#scope-editor').hidden = true;
  await loadInsightScope();
};

async function runInsight(p) {
  if (insightState.running) return;
  if (!state.llm.hasKey) { toast('先到设置里填模型 API Key'); $('#btn-settings').click(); return; }
  insightState.running = true;
  insightState.current = p;
  insightState.text = '';
  const scope = { ...insightState.scope };
  if (!insightState.custom && !scope.tag && p.days) scope.days = p.days;

  $('#insight-picker').hidden = true;
  $('#insight-history').hidden = true;
  $('#insight-result').hidden = false;
  $('#insight-result-title').textContent = p.name;
  $('#insight-result-sub').textContent = p.single ? '这条笔记' : (!insightState.custom && p.days ? '建议范围：' + p.range : insightScopeText());
  const body = $('#insight-result-body');
  const paint = makeMdPainter(body);
  body.textContent = '正在读你的笔记…';
  $('#btn-insight-save').hidden = true;

  const payload = p.single ? { memoId: p.memoId || insightState.target, insightSingle: true } : { perspective: p.id, scope };
  try {
    const res = await fetch('/api/ai/insight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'HTTP ' + res.status);
    }
    body.textContent = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\u000a\u000a');
      buf = parts.pop() || '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const json = JSON.parse(line.slice(5).trim());
        if (json.error) throw new Error(json.error);
        if (json.delta) {
          insightState.text += json.delta;
          paint(insightState.text);
        }
      }
    }
    paint(insightState.text, true);
    $('#btn-insight-save').hidden = !insightState.text;
  } catch (e) {
    body.textContent = '生成失败：' + e.message;
  } finally {
    insightState.running = false;
  }
}

$('#btn-insight-back').onclick = () => { $('#insight-result').hidden = true; $('#insight-picker').hidden = false; };
$('#btn-insight-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(insightState.text); toast('已复制'); }
  catch { toast('复制失败，请手动选中'); }
};
$('#btn-insight-save').onclick = async () => {
  if (!insightState.text) return;
  const title = '#AI洞察/' + (insightState.current ? insightState.current.name : '洞察');
  await api('/api/memos', { method: 'POST', body: { content: title + '\u000a' + insightState.text } });
  await refreshBootstrap();
  await loadMemos();
  toast('已存为笔记');
  $('#btn-insight-save').hidden = true;
};

$('#btn-insight-history').onclick = async () => {
  $('#insight-picker').hidden = true;
  $('#insight-result').hidden = true;
  $('#insight-history').hidden = false;
  const box = $('#history-list');
  box.innerHTML = '<p class="muted small">读取中…</p>';
  try {
    const { notes } = await api('/api/insights/history?limit=30');
    box.innerHTML = '';
    if (!notes.length) { box.innerHTML = '<p class="muted small">还没有洞察记录。选一个视角试着生成一次。</p>'; return; }
    for (const n of notes) {
      const name = String(n.kind).startsWith('insights/') ? String(n.kind).slice(9) : 'insight';
      const p = insightState.perspectives.find((x) => x.id === name);
      const el = document.createElement('button');
      el.className = 'history-item';
      el.innerHTML =
        '<div class="hi-top"><span class="hi-name">' + escapeHtml(p ? p.name : name) + '</span><span>' + new Date(n.created_at).toLocaleString() + '</span></div>' +
        '<p>' + escapeHtml(String(n.content).replace(/\s+/g, ' ').slice(0, 90)) + '</p>';
      el.onclick = () => {
        insightState.text = n.content;
        insightState.current = p || { name };
        $('#insight-history').hidden = true;
        $('#insight-result').hidden = false;
        $('#insight-result-title').textContent = (p ? p.name : name) + ' · 历史';
        $('#insight-result-sub').textContent = '';
        $('#insight-result-body').innerHTML = renderMarkdown(n.content);
        $('#btn-insight-save').hidden = false;
      };
      box.appendChild(el);
    }
  } catch (e) { box.innerHTML = '<p class="muted small">读取失败：' + escapeHtml(e.message) + '</p>'; }
};
$('#btn-insight-back2').onclick = () => { $('#insight-history').hidden = true; $('#insight-picker').hidden = false; };

$('#btn-insight-more').onclick = () => {
  $('#insight-picker').hidden = true;
  $('#insight-result').hidden = false;
  $('#insight-result-title').textContent = '自定义视角';
  $('#btn-insight-save').hidden = true;
  $('#insight-result-body').textContent =
    '视角就是一个提示词文件，一个文件一张卡片：\n\n  prompts/insights/<id>.md\n\n文件头写 name / author / category / range / days / icon / description / system，正文里可以用：\n\n  {{memos}}   选中的笔记正文（带日期）\n  {{count}}   笔记条数\n  {{tags}}    涉及的标签数\n  {{range}}   范围描述\n\n存盘后重开这个窗口就能看到新卡片。';
};

/* ---------------- 桌面壳（Electron）：窗口按钮由页面驱动 ---------------- */
const shellBridge = (() => {
  if (window.__shell) {
    return {
      post: (a) => { try { window.__shell.post(a); } catch (e) { /* 忽略 */ } },
      onState: (fn) => { try { window.__shell.onState((s) => fn(!!(s && s.max))); } catch (e) { /* 忽略 */ } },
    };
  }
  if (window.chrome && window.chrome.webview) {
    return {
      post: (a) => { try { window.chrome.webview.postMessage({ type: 'win', action: a }); } catch (e) { /* 忽略 */ } },
      onState: (fn) => window.chrome.webview.addEventListener('message', (e) => {
        const d = e.data || {};
        if (d.type === 'shell') fn(!!d.max);
      }),
    };
  }
  return null;
})();

if (shellBridge) {
  document.body.classList.add('shell');
  const ICON_MAX = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.6" y="3.6" width="8.8" height="8.8" rx="2"/></svg>';
  const ICON_RESTORE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="5.2" width="8.2" height="8.2" rx="1.8"/><path d="M5.2 5.2V4a1.5 1.5 0 0 1 1.5-1.5h4.6A1.5 1.5 0 0 1 12.8 4v4.6a1.5 1.5 0 0 1-1.5 1.5h-1.1"/></svg>';
  const applyMaxGlyph = (v) => {
    const b = document.querySelector('[data-win="max"]');
    if (b) b.innerHTML = v ? ICON_RESTORE : ICON_MAX;
    document.body.classList.toggle('is-max', !!v);
  };
  const box = $('#win-controls');
  if (box) {
    box.hidden = false;
    box.querySelector('[data-win="min"]').onclick = () => shellBridge.post('minimize');
    box.querySelector('[data-win="max"]').onclick = () => shellBridge.post('maximize');
    box.querySelector('[data-win="close"]').onclick = () => shellBridge.post('close');
  }
  // 拖动 / 双击最大化 / 缩放 / 光标全部由壳（-webkit-app-region + 系统窗口）处理
  shellBridge.onState(applyMaxGlyph);
}
/* ---------------- 启动时自动检查更新 ---------------- */
const UPDATE_SKIP_KEY = 'notidea.skipVer';

async function promptUpdate(r) {
  const dlg = $('#update-prompt');
  if (!dlg) return;
  $('#up-ver').textContent = 'v' + r.latest;
  const notes = $('#up-notes');
  notes.innerHTML = r.notes ? renderMarkdown(r.notes) : '<p class="muted small">（这个版本没有写更新说明）</p>';
  $('#up-status').textContent = '当前版本 v' + r.current;
  const skip = $('#up-skip');
  const later = $('#up-later');
  const now = $('#up-now');
  skip.onclick = () => {
    try { localStorage.setItem(UPDATE_SKIP_KEY, r.latest); } catch (e) { /* 忽略 */ }
    dlg.close();
  };
  later.onclick = () => dlg.close();
  now.onclick = async () => {
    dlg.close();
    try { $('#settings').showModal(); } catch (e) { /* 忽略 */ }
    await installUpdate($('#up-status'), now);
  };
  dlg.addEventListener('close', () => { now.disabled = false; }, { once: true });
  dlg.showModal();
}

async function autoCheckUpdate() {
  try {
    const skipped = localStorage.getItem(UPDATE_SKIP_KEY) || '';
    const r = await api('/api/update/check');
    if (!r || r.error || !r.hasUpdate) return;
    if (skipped && skipped === r.latest) return;   // 用户选了「跳过此版本」
    await promptUpdate(r);
  } catch (e) { /* 离线/接口异常都不打扰用户 */ }
}
/* ---------------- 启动 ---------------- */
(async function boot() {
  await refreshBootstrap();
  await loadMemos();
  await openFromQuery();
  updateHint();
  if (!state.stats.total) draft.focus();
  if (window.innerWidth < 1180) closeRail();
  setTimeout(autoCheckUpdate, 1500);
  activateRailTab(state.aiSkill);
})();

/* ---------------- 笔记菜单（⋯） ---------------- */
let menuCard = null;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function downloadFile(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function ensureMemoMenu() {
  let el = document.getElementById('memo-menu');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'memo-menu';
  el.className = 'memo-menu';
  el.hidden = true;
  el.innerHTML =
    '<button data-menu="share">分享</button>' +
    '<button data-menu="edit">编辑</button>' +
    '<button data-menu="copy">复制</button>' +
    '<div class="menu-sep"></div>' +
    '<button data-menu="pin">置顶</button>' +
    '<button data-menu="insight">AI 洞察</button>' +
    '<button data-menu="related">相关笔记</button>' +
    '<button data-menu="comment">批注</button>' +
    '<button data-menu="more" class="menu-more">更多<span class="chev">›</span></button>' +
    '<div class="menu-sub" hidden>' +
      '<button data-menu="quote">复制引用 [[链接]]</button>' +
      '<button data-menu="export-md">导出 Markdown</button>' +
      '<button data-menu="copy-json">复制 JSON</button>' +
    '</div>' +
    '<div class="menu-sep"></div>' +
    '<button data-menu="del" class="danger">删除</button>' +
    '<div class="menu-foot" id="memo-menu-foot"></div>';

  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-menu]');
    if (!b) return;
    const act = b.dataset.menu;
    if (act === 'more') {
      const sub = el.querySelector('.menu-sub');
      sub.hidden = !sub.hidden;
      return;
    }
    hideMemoMenu();
    if (menuCard) memoAction(act, menuCard);
  });

  document.body.appendChild(el);
  document.addEventListener('click', (ev) => {
    if (el.hidden) return;
    if (ev.target.closest('#memo-menu') || ev.target.closest('[data-act="menu"]')) return;
    hideMemoMenu();
  }, true);
  window.addEventListener('resize', hideMemoMenu);
  document.addEventListener('scroll', (ev) => {
    if (el.hidden) return;
    if (ev.target && ev.target.closest && ev.target.closest('#memo-menu')) return;
    hideMemoMenu();
  }, true);
  return el;
}

function openMemoMenu(card, btn) {
  const menu = ensureMemoMenu();
  menuCard = card;
  const memo = state.memos.find((m) => m.id === Number(card.dataset.id));
  if (!memo) return;
  menu.querySelector('[data-menu="pin"]').textContent = memo.pinned ? '取消置顶' : '置顶';
  menu.querySelector('[data-menu="comment"]').textContent = memo.comments ? '批注（' + memo.comments + '）' : '批注';
  const words = (memo.content || '').replace(/\s+/g, '').length;
  const edited = memo.updated_at && memo.updated_at - memo.created_at > 60000;
  menu.querySelector('.menu-sub').hidden = true;
  document.getElementById('memo-menu-foot').textContent = words + ' 字 · ' + (edited ? '编辑于 ' : '写于 ') + fmtTime(edited ? memo.updated_at : memo.created_at);
  menu.hidden = false;

  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 320;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 12);
  if (left < 12) left = 12;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.focus();
}

function hideMemoMenu() {
  const el = document.getElementById('memo-menu');
  if (el) el.hidden = true;
}

/* ---------------- 批注 ---------------- */
async function toggleCommentBox(card, forceOpen) {
  const box = card.querySelector('.comment-box');
  if (!box) return;
  if (!forceOpen && !box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  await loadComments(card);
  const input = box.querySelector('input');
  if (input) input.focus();
}

async function loadComments(card) {
  const id = Number(card.dataset.id);
  const box = card.querySelector('.comment-box');
  const list = box.querySelector('.comment-list');
  try {
    const { comments } = await api('/api/memos/' + id + '/comments');
    renderComments(list, comments);
  } catch (e) {
    list.innerHTML = '<span class="muted small">' + escapeHtml(e.message) + '</span>';
  }
}

function renderComments(list, comments) {
  if (!comments.length) { list.innerHTML = '<span class="muted small">还没有批注</span>'; return; }
  list.innerHTML = comments.map((c) => {
    const when = c.remind_at && !c.done
      ? '<span class="comment-remind" title="提醒时间">⏰ ' + escapeHtml(fmtRemind(c.remind_at)) + '</span>'
      : (c.remind_at && c.done ? '<span class="comment-remind done">⏰ 已完成</span>' : '');
    return '<div class="comment-item" data-cid="' + c.id + '">' +
      when +
      '<span class="comment-text">' + escapeHtml(c.content) + '</span>' +
      '<span class="comment-time muted small">' + fmtTime(c.created_at) + '</span>' +
      '<button class="comment-del" title="删除批注">✕</button>' +
    '</div>';
  }).join('');
  list.querySelectorAll('.comment-del').forEach((b) => {
    b.onclick = async (ev) => {
      const item = ev.target.closest('.comment-item');
      await api('/api/comments/' + item.dataset.cid, { method: 'DELETE' });
      await loadComments(list.closest('.memo'));
      await refreshBootstrap();
    };
  });
}

async function sendComment(card) {
  const id = Number(card.dataset.id);
  const box = card.querySelector('.comment-box');
  const input = box.querySelector('input');
  const text = input.value.trim();
  if (!text) return;
  const { comment, memo } = await api('/api/memos/' + id + '/comments', { method: 'POST', body: { content: text } });
  input.value = '';
  if (memo) {
    const cur = state.memos.find((m) => m.id === id);
    if (cur) cur.comments = memo.comments;
  }
  await loadComments(card);
  toast('批注已保存');
}

/* ---------------- 单条笔记模式（?memo=id / ?memo=id&float=1） ---------------- */
async function openFromQuery() {
  const q = new URLSearchParams(location.search);
  const id = Number(q.get('memo') || 0);
  if (!id) return;
  document.body.classList.add('single-mode');
  if (q.get('float') === '1') document.body.classList.add('float-mode');
  try {
    const { memo } = await api('/api/memos/' + id);
    if (memo) {
      try {
        const links = await api('/api/memos/' + id + '/links');
        memo.backlinks = (links.backlinks || []).length;
      } catch (e) { /* 忽略 */ }
    }
    if (!memo) { toast('笔记不存在'); document.body.classList.remove('single-mode', 'float-mode'); return; }
    state.memos = [memo];
    renderList();
    $('#list-title').textContent = '单条笔记';
    const back = document.createElement('a');
    back.href = '/';
    back.className = 'single-back';
    back.textContent = '← 回到全部笔记';
    document.querySelector('.topbar').prepend(back);
    document.title = '一条笔记 · 拾念';
  } catch (e) {
    toast('打开失败：' + e.message);
  }
}

/* ---------------- 分享长图（纯 canvas，本地生成） ---------------- */
const SHARE_W = 1080;
const SHARE_H = 1440;

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  const paras = String(text || '').split(/\r?\n/);
  for (const para of paras) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const ch of para) {
      const next = line + ch;
      if (ctx.measureText(next).width > maxWidth && line) {
        out.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function openShare(memo) {
  const dlg = $('#share');
  const canvas = $('#share-canvas');
  const measure = document.createElement('canvas').getContext('2d');
  const FONT_BODY = '40px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  const LINE_H = 62;

  measure.font = FONT_BODY;
  const lines = wrapLines(measure, memo.content, SHARE_W - 2 * 96);

  const imgMeta = (memo.files || []).find((f) => (f.mime || '').startsWith('image/'));
  let img = null;
  let imgW = 0;
  let imgH = 0;
  if (imgMeta) {
    try {
      img = await loadImage(imgMeta.url);
      const maxW = SHARE_W - 2 * 96;
      const maxH = 520;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      imgW = Math.round(img.width * scale);
      imgH = Math.round(img.height * scale);
    } catch (e) { img = null; imgW = 0; imgH = 0; }
  }

  const headerH = 190;
  const bodyH = lines.length * LINE_H + 40;
  const imgBlock = img ? imgH + 54 : 0;
  const tagsH = (memo.tags && memo.tags.length) ? 90 : 40;
  const footerH = 120;
  const height = Math.max(1080, Math.min(1600, headerH + imgBlock + bodyH + tagsH + footerH));
  canvas.width = SHARE_W;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f7f4ee';
  ctx.fillRect(0, 0, SHARE_W, height);
  ctx.strokeStyle = 'rgba(35,32,28,0.10)';
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, SHARE_W - 56, height - 56);

  const d = new Date(memo.created_at);
  ctx.fillStyle = '#1f6f4a';
  ctx.beginPath(); ctx.arc(96, 108, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f7f4ee';
  ctx.font = 'bold 26px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.fillText('f', 96, 118);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#23201c';
  ctx.font = '600 30px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('拾念', 134, 118);

  ctx.fillStyle = '#8b8580';
  ctx.font = '26px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  const pad2 = (n) => String(n).padStart(2, '0');
  const dateText = d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  ctx.textAlign = 'right';
  ctx.fillText(dateText, SHARE_W - 96, 118);
  ctx.textAlign = 'left';

  let y = headerH;
  if (img) {
    ctx.save();
    roundRect(ctx, 96, y, imgW, imgH, 18);
    ctx.clip();
    ctx.drawImage(img, 96, y, imgW, imgH);
    ctx.restore();
    y += imgH + 54;
  }

  ctx.fillStyle = '#23201c';
  ctx.font = FONT_BODY;
  let ty = y + 46;
  const maxLines = Math.max(1, Math.floor((height - footerH - 40 - ty) / LINE_H));
  const shown = lines.slice(0, maxLines);
  if (lines.length > shown.length && shown.length) {
    shown[shown.length - 1] = shown[shown.length - 1].replace(/.{2}$/, '') + '…';
  }
  for (const line of shown) {
    ctx.fillText(line, 96, ty);
    ty += LINE_H;
  }

  const tags = memo.tags || [];
  if (tags.length) {
    let tx = 96;
    const tagY = height - 150;
    ctx.font = '28px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    for (const t of tags.slice(0, 6)) {
      const label = '#' + t;
      const w = ctx.measureText(label).width + 34;
      if (tx + w > SHARE_W - 96) break;
      ctx.fillStyle = 'rgba(31,111,74,0.10)';
      roundRect(ctx, tx, tagY - 34, w, 48, 24);
      ctx.fill();
      ctx.fillStyle = '#1f6f4a';
      ctx.fillText(label, tx + 17, tagY);
      tx += w + 14;
    }
  }

  ctx.fillStyle = '#8b8580';
  ctx.font = '24px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('写于 拾念 · 数据都在自己电脑里', 96, height - 84);

  $('#share-hint').textContent = '长图适合发朋友圈；图片只在本机生成，不会上传。';
  dlg.showModal();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图片加载失败'));
    im.src = src;
  });
}

async function canvasBlob() {
  const canvas = $('#share-canvas');
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

document.addEventListener('DOMContentLoaded', () => {
  const dlg = $('#share');
  if (!dlg) return;
  $('#btn-share-close').onclick = () => dlg.close();
  $('#btn-share-save').onclick = async () => {
    const blob = await canvasBlob();
    if (!blob) return toast('生成失败');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'notidea-' + Date.now() + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已保存');
  };
  $('#btn-share-copy').onclick = async () => {
    try {
      const blob = await canvasBlob();
      if (!blob) throw new Error('生成失败');
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('浏览器不支持复制图片');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('图片已复制');
    } catch (e) {
      toast('这个环境不能复制图片，请用「保存图片」');
    }
  };
});

/* 动效：主按钮涟漪 + 卡片鼠标光斑 */
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.primary-btn, .new-btn');
  if (!btn || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + (e.clientX - r.left - size / 2) + 'px;top:' + (e.clientY - r.top - size / 2) + 'px';
  btn.appendChild(s);
  s.addEventListener('animationend', () => s.remove());
});
document.addEventListener('pointermove', (e) => {
  const card = e.target.closest && e.target.closest('.memo');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  card.style.setProperty('--my', (e.clientY - r.top) + 'px');
}, { passive: true });

/* ================= 顶栏视图菜单 / 搜索 / 筛选 / 工具栏 / 多选 ================= */
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function popOpen(el) {
  if (!el) return;
  el.classList.remove('closing');
  el.hidden = false;
  replayClass(el, 'opening');
}
function popClose(el) {
  if (!el || el.hidden || el.classList.contains('closing')) return;
  if (reduceMotion()) { el.hidden = true; return; }
  el.classList.add('closing');
  setTimeout(() => { if (el.classList.contains('closing')) { el.hidden = true; el.classList.remove('closing'); } }, 170);
}
const POPS = ['#view-pop', '#search-pop', '#filter-pop', '#mention-pop'];
function closePopsExcept(keep) { POPS.forEach((s) => { if (s !== keep) popClose($(s)); }); }

/* 折叠区：高度动画 */
function toggleAcc(root, key, force) {
  const body = root.querySelector('[data-acc-body="' + key + '"]');
  const head = root.querySelector('[data-acc="' + key + '"]');
  if (!body) return;
  const open = force !== undefined ? force : !body.classList.contains('open');
  body.classList.toggle('open', open);
  if (head) head.classList.toggle('open', open);
}

/* ---- 视图菜单：排序 / 来源 / 多选 / 导出 ---- */
const ORDER_LABEL = { '': '创建时间，从新到旧', created_asc: '创建时间，从旧到新', updated_desc: '最近编辑' };
const SOURCE_LABEL = { '': '全部', local: '本地记录', ai: 'AI 生成', import: '导入' };
function syncViewPop() {
  $('#sort-label').textContent = ORDER_LABEL[state.view.order] || ORDER_LABEL[''];
  $('#source-label').textContent = SOURCE_LABEL[state.view.source] || '全部';
  document.querySelectorAll('#view-pop [data-order]').forEach((b) => b.classList.toggle('on', b.dataset.order === state.view.order));
  document.querySelectorAll('#view-pop [data-source]').forEach((b) => b.classList.toggle('on', b.dataset.source === state.view.source));
}
$('#btn-view').onclick = (e) => {
  e.stopPropagation();
  const pop = $('#view-pop');
  if (!pop.hidden && !pop.classList.contains('closing')) { popClose(pop); $('#btn-view').classList.remove('open'); return; }
  closePopsExcept('#view-pop');
  syncViewPop();
  popOpen(pop);
  $('#btn-view').classList.add('open');
};
$('#view-pop').addEventListener('click', (e) => {
  e.stopPropagation();
  const acc = e.target.closest('[data-acc]');
  if (acc) { toggleAcc($('#view-pop'), acc.dataset.acc); return; }
  const ord = e.target.closest('[data-order]');
  if (ord) { state.view.order = ord.dataset.order; syncViewPop(); loadMemos(); return; }
  const src = e.target.closest('[data-source]');
  if (src) { state.view.source = src.dataset.source; syncViewPop(); syncFilterPop(); loadMemos(); return; }
  if (e.target.closest('#btn-multi')) { popClose($('#view-pop')); $('#btn-view').classList.remove('open'); enterSelect(); return; }
  if (e.target.closest('#btn-view-export')) { popClose($('#view-pop')); $('#btn-view').classList.remove('open'); window.location.href = '/api/export'; }
});

/* ---- 搜索框：快捷搜索 + 最近搜索 + 关键词 / AI 模式 ---- */
state.searchMode = 'kw';
const RECENT_KEY = 'recentSearch';
const getRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; } };
function pushRecent(q) {
  if (!q) return;
  const list = [q, ...getRecent().filter((x) => x !== q)].slice(0, 6);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}
function renderRecent() {
  const list = getRecent();
  $('#recent-cap').hidden = !list.length;
  $('#recent-list').innerHTML = list.map((q) => '<button class="opt" data-recent="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>').join('');
}
function setSearchMode(mode) {
  state.searchMode = mode;
  document.querySelectorAll('#search-mode [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#search-wrap').classList.toggle('ai-mode', mode === 'ai');
  $('#search').placeholder = mode === 'ai' ? '问一个只有笔记知道的问题，回车提问' : 'Ctrl+K';
}
$('#search').addEventListener('focus', () => {
  $('#search-wrap').classList.add('focus');
  closePopsExcept('#search-pop');
  renderRecent();
  if (!$('#search').value) popOpen($('#search-pop'));
});
$('#search').addEventListener('blur', () => {
  setTimeout(() => {
    if (!$('#search-wrap').contains(document.activeElement)) { $('#search-wrap').classList.remove('focus'); popClose($('#search-pop')); }
  }, 120);
});
$('#search').addEventListener('input', () => { if ($('#search').value) popClose($('#search-pop')); else popOpen($('#search-pop')); }, true);
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); setSearchMode(state.searchMode === 'kw' ? 'ai' : 'kw'); return; }
  if (e.key === 'Enter') {
    const q = $('#search').value.trim();
    if (!q) return;
    pushRecent(q);
    if (state.searchMode === 'ai') {
      e.preventDefault();
      const chip = document.querySelector('#rail-tabs [data-ai="ask"]');
      if (chip) chip.click();
      $('#ask-input').value = q;
      openRail();
      runAi('ask', { question: q });
    }
  }
});
$('#search-mode').addEventListener('mousedown', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  e.preventDefault();
  setSearchMode(b.dataset.mode);
});
$('#search-pop').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const quick = e.target.closest('[data-quick]');
  if (quick) {
    const k = quick.dataset.quick;
    $('#search').blur();
    if (k === 'onthisday') { state.view.onThisDay = true; state.filter = { type: 'all' }; state.has = ''; loadMemos(); }
    else setFilter({ type: k });
    return;
  }
  const rec = e.target.closest('[data-recent]');
  if (rec) {
    $('#search').value = rec.dataset.recent;
    $('#search').dispatchEvent(new Event('input', { bubbles: true }));
  }
});

/* ---- 筛选面板 ---- */
function fillFilterTags() {
  const sel = $('#flt-tag');
  const cur = state.view.tag;
  sel.innerHTML = '<option value="">选择标签…</option>' + state.tags.map((t) => '<option value="' + escapeHtml(t.name) + '">#' + escapeHtml(t.name) + '</option>').join('');
  sel.value = cur;
}
const toDateInput = (ms) => { if (!ms) return ''; const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
function syncFilterPop() {
  const v = state.view;
  document.querySelectorAll('#filter-pop [data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === v.range));
  document.querySelectorAll('#filter-pop [data-tagmode]').forEach((b) => b.classList.toggle('on', b.dataset.tagmode === v.tagMode));
  document.querySelectorAll('#filter-pop [data-fhas]').forEach((b) => b.classList.toggle('on', v.fhas.includes(b.dataset.fhas)));
  document.querySelectorAll('#filter-pop [data-fsource]').forEach((b) => b.classList.toggle('on', b.dataset.fsource === v.source));
  $('#flt-tag').hidden = !(v.tagMode === 'include' || v.tagMode === 'exclude');
  if (v.range !== 'custom') { $('#flt-since').value = toDateInput(v.since); $('#flt-until').value = toDateInput(v.until ? v.until - 86400000 : 0); }
  const active = !!(v.range || v.tagMode || v.fhas.length || v.source || v.onThisDay);
  $('#btn-filter').classList.toggle('active', active);
  $('#list-sub').dataset.filter = active ? '1' : '';
}
function rangeOf(key) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const end = now.getTime() + 86400000;
  if (key === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end];
  if (key === 'lastmonth') return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()];
  const n = Number(key);
  return [end - n * 86400000, end];
}
$('#btn-filter').onclick = (e) => {
  e.stopPropagation();
  const pop = $('#filter-pop');
  if (!pop.hidden && !pop.classList.contains('closing')) { popClose(pop); return; }
  closePopsExcept('#filter-pop');
  fillFilterTags();
  syncFilterPop();
  popOpen(pop);
};
$('#filter-pop').addEventListener('click', (e) => {
  e.stopPropagation();
  const v = state.view;
  const acc = e.target.closest('[data-acc]');
  if (acc) { toggleAcc($('#filter-pop'), acc.dataset.acc); return; }
  const r = e.target.closest('[data-range]');
  if (r) {
    if (v.range === r.dataset.range) { v.range = ''; v.since = 0; v.until = 0; }
    else { v.range = r.dataset.range; [v.since, v.until] = rangeOf(v.range); }
  }
  const tm = e.target.closest('[data-tagmode]');
  if (tm) {
    v.tagMode = v.tagMode === tm.dataset.tagmode ? '' : tm.dataset.tagmode;
    if (v.tagMode === 'notags' || !v.tagMode) v.tag = '';
    syncFilterPop();
    if (v.tagMode === 'include' || v.tagMode === 'exclude') { $('#flt-tag').focus(); if (!v.tag) return; }
  }
  const fh = e.target.closest('[data-fhas]');
  if (fh) { const k = fh.dataset.fhas; v.fhas = v.fhas.includes(k) ? v.fhas.filter((x) => x !== k) : [...v.fhas, k]; }
  const fs = e.target.closest('[data-fsource]');
  if (fs) v.source = v.source === fs.dataset.fsource ? '' : fs.dataset.fsource;
  if (e.target.closest('#btn-filter-clear')) {
    Object.assign(v, { source: '', since: 0, until: 0, range: '', tagMode: '', tag: '', fhas: [], onThisDay: false });
  }
  if (r || fh || fs || e.target.closest('#btn-filter-clear')) { syncFilterPop(); syncViewPop(); loadMemos(); }
});
$('#flt-tag').onchange = () => { state.view.tag = $('#flt-tag').value; loadMemos(); };
['#flt-since', '#flt-until'].forEach((s) => $(s).addEventListener('change', () => {
  const a = $('#flt-since').value, b = $('#flt-until').value;
  const v = state.view;
  v.range = (a || b) ? 'custom' : '';
  v.since = a ? new Date(a + 'T00:00:00').getTime() : 0;
  v.until = b ? new Date(b + 'T00:00:00').getTime() + 86400000 : 0;
  syncFilterPop();
  loadMemos();
}));

/* 点外部关闭所有弹层 */
document.addEventListener('click', (e) => {
  if (e.target.closest('.pop') || e.target.closest('#btn-view') || e.target.closest('#btn-filter') || e.target.closest('[data-tool="mention"]')) return;
  closePopsExcept(null);
  $('#btn-view').classList.remove('open');
});

/* ---- 输入框工具栏 ---- */
function wrapSel(before, after = '', placeholder = '') {
  const s = draft.selectionStart, t = draft.selectionEnd;
  const sel = draft.value.slice(s, t) || placeholder;
  draft.setRangeText(before + sel + after, s, t, 'end');
  if (!draft.value.slice(s, t).length && placeholder) {
    draft.selectionStart = s + before.length;
    draft.selectionEnd = s + before.length + sel.length;
  }
  draft.focus();
  updateHint();
}
function prefixLines(fn) {
  const v = draft.value;
  let s = v.lastIndexOf('\n', draft.selectionStart - 1) + 1;
  let t = v.indexOf('\n', draft.selectionEnd); if (t === -1) t = v.length;
  const lines = v.slice(s, t).split('\n').map((l, i) => fn(l, i));
  draft.setRangeText(lines.join('\n'), s, t, 'end');
  draft.focus();
  updateHint();
}
$('#composer-tools').addEventListener('mousedown', (e) => { if (e.target.closest('[data-tool]')) e.preventDefault(); });
$('#composer-tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (!b) return;
  replayClass(b, 'tap');
  const tool = b.dataset.tool;
  if (tool === 'tag') wrapSel('#', '');
  if (tool === 'bold') wrapSel('**', '**', '加粗');
  if (tool === 'ul') prefixLines((l) => (/^- /.test(l) ? l.slice(2) : '- ' + l));
  if (tool === 'ol') prefixLines((l, i) => (/^\d+\. /.test(l) ? l.replace(/^\d+\. /, '') : (i + 1) + '. ' + l));
  if (tool === 'mention') openMention();
});

/* ---- @ 引用笔记 ---- */
let mentionTimer, mentionFromAt = false;
async function fillMention(q) {
  const qs = new URLSearchParams({ limit: 8 });
  if (q) qs.set('search', q);
  let memos = [];
  try { memos = (await api('/api/memos?' + qs.toString())).memos; } catch (e) { /* 忽略 */ }
  const box = $('#mention-list');
  if (!memos.length) { box.innerHTML = '<div class="muted small mention-empty">没有匹配的笔记</div>'; return; }
  box.innerHTML = memos.map((m, i) => '<button class="opt mention-item' + (i === 0 ? ' on' : '') + '" data-slug="' + escapeHtml(m.slug) + '" style="--d:' + i + '">' +
    '<span>' + escapeHtml(String(m.content).replace(/\s+/g, ' ').slice(0, 60)) + '</span><small>' + dayLabel(m.created_at) + '</small></button>').join('');
}
function openMention(fromAt = false) {
  mentionFromAt = fromAt;
  closePopsExcept('#mention-pop');
  $('#mention-q').value = '';
  popOpen($('#mention-pop'));
  fillMention('');
  setTimeout(() => $('#mention-q').focus(), 30);
}
function pickMention(slug) {
  popClose($('#mention-pop'));
  draft.focus();
  if (mentionFromAt) {
    const p = draft.selectionStart;
    if (draft.value[p - 1] === '@') draft.setRangeText('', p - 1, p, 'end');
  }
  wrapSel('[[' + slug + ']] ');
}
$('#mention-q').addEventListener('input', () => { clearTimeout(mentionTimer); mentionTimer = setTimeout(() => fillMention($('#mention-q').value.trim()), 160); });
$('#mention-q').addEventListener('keydown', (e) => {
  const items = [...document.querySelectorAll('#mention-list .mention-item')];
  const idx = items.findIndex((x) => x.classList.contains('on'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    const next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((x, i) => x.classList.toggle('on', i === next));
    items[next].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (items[idx]) pickMention(items[idx].dataset.slug);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    popClose($('#mention-pop')); draft.focus();
  }
});
$('#mention-list').addEventListener('click', (e) => { const b = e.target.closest('.mention-item'); if (b) pickMention(b.dataset.slug); });
draft.addEventListener('input', (e) => { if (e.data === '@') openMention(true); });

/* ---- 多选笔记 ---- */
state.selected = new Set();
function syncSelectBar() {
  $('#select-count').textContent = '已选 ' + state.selected.size + ' 条';
  document.querySelectorAll('.memo').forEach((c) => c.classList.toggle('selected', state.selected.has(Number(c.dataset.id))));
}
function enterSelect() {
  state.selected.clear();
  document.body.classList.add('select-mode');
  popOpen($('#select-bar'));
  syncSelectBar();
}
function exitSelect() {
  document.body.classList.remove('select-mode');
  state.selected.clear();
  syncSelectBar();
  popClose($('#select-bar'));
}
$('#memo-list').addEventListener('click', (e) => {
  if (!document.body.classList.contains('select-mode')) return;
  const card = e.target.closest('.memo');
  if (!card) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const id = Number(card.dataset.id);
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  replayClass(card, 'tick');
  syncSelectBar();
}, true);
$('#sel-all').onclick = () => {
  const all = state.memos.map((m) => m.id);
  if (state.selected.size === all.length) state.selected.clear(); else all.forEach((id) => state.selected.add(id));
  syncSelectBar();
};
$('#sel-pin').onclick = async () => {
  if (!state.selected.size) return toast('先选几条笔记');
  for (const id of state.selected) await api('/api/memos/' + id, { method: 'PUT', body: { pinned: true } });
  toast('已置顶 ' + state.selected.size + ' 条');
  exitSelect(); await loadMemos();
};
$('#sel-export').onclick = () => {
  if (!state.selected.size) return toast('先选几条笔记');
  const md = state.memos.filter((m) => state.selected.has(m.id)).map((m) => {
    const d = new Date(m.created_at);
    return '## ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + fmtTime(m.created_at) + '\n\n' + m.content + '\n';
  }).join('\n---\n\n');
  downloadFile('notidea-' + state.selected.size + '-notes.md', md, 'text/markdown;charset=utf-8');
};
$('#sel-del').onclick = async () => {
  if (!state.selected.size) return toast('先选几条笔记');
  if (!confirm('删除选中的 ' + state.selected.size + ' 条笔记？（不可恢复）')) return;
  const ids = [...state.selected];
  ids.forEach((id) => { const c = document.querySelector('.memo[data-id="' + id + '"]'); if (c) c.classList.add('leaving'); });
  if (!reduceMotion()) await new Promise((r) => setTimeout(r, 360));
  for (const id of ids) await api('/api/memos/' + id, { method: 'DELETE' });
  toast('已删除 ' + ids.length + ' 条');
  exitSelect(); await refreshBootstrap(); await loadMemos();
};
$('#sel-done').onclick = exitSelect;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('select-mode')) exitSelect();
});

/* ---------------- 写笔记时设提醒 ---------------- */
let draftRemind = { at: 0, calendar: false };
function toLocalInput(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function setDraftRemind(at, calendar) {
  draftRemind = { at: Number(at) || 0, calendar: !!calendar };
  const chip = $('#remind-chip');
  if (!chip) return;
  chip.hidden = !draftRemind.at;
  $('#btn-remind').classList.toggle('on', !!draftRemind.at);
  if (draftRemind.at) {
    $('#remind-chip-text').textContent = '⏰ ' + fmtRemind(draftRemind.at) + (draftRemind.calendar ? ' · 日历' : '');
    replayClass(chip, 'pop-in');
  }
}
async function refreshReminderCount() {
  try { const d = await api('/api/reminders'); $('#stat-reminders').textContent = d.count || 0; } catch (e) { /* 忽略 */ }
}
function quickRemind(k) {
  const d = new Date();
  if (k === 'tonight') { d.setHours(20, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); }
  else if (k === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  else if (k === 'nextweek') { const delta = ((1 - d.getDay()) + 7) % 7 || 7; d.setDate(d.getDate() + delta); d.setHours(9, 0, 0, 0); }
  return d.getTime();
}
if (!POPS.includes('#remind-pop')) POPS.push('#remind-pop');
$('#btn-remind').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#remind-pop');
  if (!pop.hidden && !pop.classList.contains('closing')) { popClose(pop); return; }
  closePopsExcept('#remind-pop');
  const base = draftRemind.at || quickRemind('tomorrow');
  $('#remind-at').value = toLocalInput(base);
  $('#remind-cal').checked = draftRemind.at ? draftRemind.calendar : false;
  popOpen(pop);
});
$('#remind-pop').addEventListener('click', (e) => {
  e.stopPropagation();
  const q = e.target.closest('[data-rq]');
  if (q) {
    $('#remind-at').value = toLocalInput(quickRemind(q.dataset.rq));
    document.querySelectorAll('#remind-pop [data-rq]').forEach((b) => b.classList.toggle('on', b === q));
    return;
  }
  if (e.target.closest('#remind-ok')) {
    const v = $('#remind-at').value;
    const at = v ? new Date(v).getTime() : 0;
    if (!at) { toast('选一个时间'); return; }
    if (at <= Date.now()) { toast('提醒时间要晚于现在'); return; }
    setDraftRemind(at, $('#remind-cal').checked);
    popClose($('#remind-pop'));
    draft.focus();
  }
});
$('#remind-chip-x').addEventListener('click', (e) => { e.stopPropagation(); setDraftRemind(0, false); toast('已取消提醒'); });

/* 弹窗「取消」：显式关闭，不依赖表单校验 */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-close-dialog]');
  if (!b) return;
  e.preventDefault();
  const d = b.closest('dialog');
  if (d && d.open) d.close();
});

/* 点对话框外面的遮罩就关掉（AI 洞察除外：生成中误点会中断请求） */
document.querySelectorAll('dialog.dialog').forEach((d) => {
  if (d.id === 'insight') return;
  let armed = false;
  d.addEventListener('mousedown', (e) => {
    armed = e.target === d;   // 只在遮罩上按下才算，避免框内选字拖到外面松开时误关
  });
  d.addEventListener('click', (e) => {
    if (armed && e.target === d) d.close();
    armed = false;
  });
});

/* 热力图气泡挂到 body 下：侧栏的 backdrop-filter 会把 fixed 元素困在侧栏里被裁切 */
(() => { const t = document.getElementById('heat-tip'); if (t && t.parentElement !== document.body) document.body.appendChild(t); })();
