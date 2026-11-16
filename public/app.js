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
  aiSkill: 'daily-review',
  aiText: '',
  heatMonth: null,
  // 默认折叠；只有用户明确展开过（存了 '1'）才展开
  subnavOpen: localStorage.getItem('subnavOpen') === '1',
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
function renderContent(text, highlight = '') {
  let html = escapeHtml(text);

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

/* ---------------- 热力图（按月） ---------------- */
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function heatMonthStart() {
  if (!state.heatMonth) {
    const d = new Date();
    state.heatMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  }
  return state.heatMonth;
}

function showHeatTip(cell, x, y) {
  const tip = $('#heat-tip');
  tip.innerHTML = '<b>' + cell.n + '</b> 条笔记 · ' + cell.label + '<i>点击查看当天</i>';
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

function renderHeatmap() {
  const grid = $('#heat-grid');
  const weekdays = $('#heat-weekdays');
  const first = heatMonthStart();
  const y = first.getFullYear();
  const m = first.getMonth();
  $('#heat-month').textContent = y + ' 年 ' + (m + 1) + ' 月';

  weekdays.innerHTML = WEEK_LABELS.map((w) => '<span>' + w + '</span>').join('');
  grid.innerHTML = '';

  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const lead = (new Date(y, m, 1).getDay() + 6) % 7; // 周一为 0
  const todayKey = dayKey(Date.now());
  const max = Math.max(1, ...Object.values(state.heatmap));

  for (let i = 0; i < lead; i++) {
    const pad = document.createElement('div');
    pad.className = 'heat-cell blank';
    grid.appendChild(pad);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = y + '-' + pad2(m + 1) + '-' + pad2(d);
    const n = state.heatmap[key] || 0;
    const cell = document.createElement('div');
    cell.className = 'heat-cell day';
    cell.style.setProperty('--i', lead + d);
    if (n > 0) cell.classList.add('l' + Math.min(4, 1 + Math.floor((n / max) * 3.999)));
    if (key === todayKey) cell.classList.add('today');
    if (key > todayKey) cell.classList.add('future');
    cell.dataset.key = key;
    cell.dataset.n = n;
    cell.dataset.label = (m + 1) + ' 月 ' + d + ' 日';
    cell.innerHTML = '<span>' + d + '</span>';
    if (key === state.filter.value && state.filter.type === 'day') cell.classList.add('picked');
    grid.appendChild(cell);
  }
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
$('#heat').addEventListener('click', (e) => {
  const btn = e.target.closest('#heat-prev, #heat-next');
  if (btn) {
    const cur = heatMonthStart();
    const delta = btn.id === 'heat-prev' ? -1 : 1;
    state.heatMonth = new Date(cur.getFullYear(), cur.getMonth() + delta, 1);
    hideHeatTip();
    renderHeatmap();
    return;
  }
  const cell = e.target.closest('.heat-cell.day');
  if (!cell) return;
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
  el.innerHTML =
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
    '<div class="memo-foot">' +
      '<span class="memo-time" title="' + new Date(m.created_at).toLocaleString() + '">' + fmtTime(m.created_at) + '</span>' +
      '<span class="memo-tags muted small">' + (m.tags || []).map((t) => '#' + t).join(' ') + '</span>' +
      (commentCount ? '<button class="memo-comment-count" data-act="comment-toggle" title="批注">✎ ' + commentCount + '</button>' : '') +
      (backCount ? '<span class="memo-back" title="有几条笔记引用了它">↩ ' + backCount + '</span>' : '') +
      '<span class="memo-words muted small">' + words + ' 字' + (isEdited ? ' · 编辑于 ' + fmtTime(m.updated_at) : '') + '</span>' +
      '<div class="memo-actions">' +
        '<button class="memo-ai" data-act="insight" title="用 AI 看这条笔记">✧<span class="ai-label"> AI 洞察</span></button>' +
        '<button class="memo-dot" data-act="menu" title="更多">⋯</button>' +
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
  location.href = '/?memo=' + row.dataset.memo;
});

function renderListTitle() {
  const f = state.filter;
  const hasLabel = { notags: '无标签', images: '有图片', videos: '有视频', audio: '有语音', links: '有链接' }[state.has];
  const title = hasLabel ? '全部笔记 · ' + hasLabel
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
  if (state.has) q.set('has', state.has);
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
    openInsight();
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
  const { memo, stats, tags, tagTree, heatmap } = await api('/api/memos', { method: 'POST', body });
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

  // Ctrl+Shift+N 新建（和 flomo 一致）
  if (mod && e.shiftKey && key === 'n') {
    e.preventDefault();
    $('#btn-new').click();
    $('#draft').focus();
    return;
  }

  // Alt+Shift+A 唤起 AI 面板（和 flomo 一致）
  if (e.altKey && e.shiftKey && key === 'a') {
    e.preventDefault();
    document.querySelector('.app').classList.remove('rail-off');
    $('#btn-ai-run').focus();
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
  localStorage.setItem('subnavOpen', state.subnavOpen ? '1' : '0');
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
  const open = APP().classList.contains('side-open') || APP().classList.contains('rail-open');
  scrim.hidden = !open;
}
function openRail() { APP().classList.remove('rail-off'); APP().classList.add('rail-open'); syncScrim(); }
function closeRail() { APP().classList.add('rail-off'); APP().classList.remove('rail-open'); syncScrim(); }
function toggleSide() { APP().classList.toggle('side-open'); APP().classList.remove('rail-open'); syncScrim(); }
$('#btn-rail-close').onclick = closeRail;
$('#btn-ai-panel').onclick = () => {
  if (APP().classList.contains('rail-open')) closeRail();
  else { openRail(); APP().classList.remove('side-open'); }
};
$('#btn-side').onclick = toggleSide;
$('#btn-ai-mobile').onclick = () => { if (APP().classList.contains('rail-open')) closeRail(); else { openRail(); APP().classList.remove('side-open'); } };
$('#scrim').onclick = () => {
  APP().classList.remove('side-open');
  APP().classList.remove('rail-open');
  syncScrim();
};
$('#btn-collapse').onclick = () => document.querySelector('.app').classList.toggle('side-off');

let currentAi = { skill: null, text: '', payload: {} };

async function runAi(skill, payload = {}) {
  if (!state.llm.hasKey) { toast('先到设置里填模型 API Key'); $('#btn-settings').click(); return; }
  const body = $('#rail-body');
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
          body.textContent = currentAi.text;
          body.scrollTop = body.scrollHeight;
        }
      }
    }
    body.classList.remove('streaming');
    $('#btn-ai-save').hidden = !currentAi.text;
  } catch (e) {
    body.classList.remove('streaming');
    body.innerHTML = '<p class="muted small">生成失败：' + escapeHtml(e.message) + '</p>';
  }
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
  if (skill === 'ask') {
    const q = $('#ask-input').value.trim();
    if (!q) { toast('先输入问题'); return; }
    return runAi('ask', { question: q });
  }
  return runAi(skill, {});
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
};

$('#btn-check-update').onclick = async () => {
  const note = $('#update-note');
  note.textContent = '正在检查…';
  $('#btn-do-update').hidden = true;
  try {
    const r = await api('/api/update/check?force=1');
    if (r.error) { note.textContent = '检查失败：' + r.error + '（离线也能正常用）'; return; }
    if (r.hasUpdate) {
      note.textContent = '发现新版本 v' + r.latest + (r.notes ? '：' + r.notes : '');
      $('#btn-do-update').hidden = false;
      $('#btn-do-update').textContent = '下载并安装 v' + r.latest;
    } else {
      note.textContent = '已是最新版本（v' + r.current + '）';
    }
  } catch (e) {
    note.textContent = '检查失败：' + e.message;
  }
};

$('#btn-do-update').onclick = async () => {
  const note = $('#update-note');
  const btn = $('#btn-do-update');
  btn.disabled = true;
  note.textContent = '正在下载并安装…装好后窗口会自动刷新，请不要关掉它';
  try {
    const r = await api('/api/update/apply', { method: 'POST' });
    if (r.error) { note.textContent = '更新失败：' + r.error; btn.disabled = false; return; }
    note.textContent = '已下载 v' + r.latest + '（' + Math.round((r.size || 0) / 1024) + ' KB），正在重启服务…';
    // 等服务重启后自己刷新
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
      } catch (e) { /* 服务正在重启 */ }
      if (tries > 90) {
        clearInterval(timer);
        note.textContent = '服务没有自己起来，请手动关掉窗口后重新双击 start-desktop.cmd（数据没动）';
        btn.disabled = false;
      }
    }, 1000);
  } catch (e) {
    note.textContent = '更新失败：' + e.message;
    btn.disabled = false;
  }
};

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
$('#btn-export').onclick = () => { window.location.href = '/api/export'; };
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
  body.textContent = '正在读你的笔记…';
  $('#btn-insight-save').hidden = true;

  const payload = p.single ? { memoId: insightState.target, insightSingle: true } : { perspective: p.id, scope };
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
          body.textContent = insightState.text;
          body.scrollTop = body.scrollHeight;
        }
      }
    }
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
        $('#insight-result-body').textContent = n.content;
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

/* ---------------- 启动 ---------------- */
(async function boot() {
  await refreshBootstrap();
  await loadMemos();
  await openFromQuery();
  updateHint();
  if (!state.stats.total) draft.focus();
  if (window.innerWidth < 1180) closeRail();
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
    '<button data-menu="open-window">新窗口打开</button>' +
    '<button data-menu="pin">置顶</button>' +
    '<button data-menu="float">加入浮窗</button>' +
    '<button data-menu="insight">AI 洞察</button>' +
    '<button data-menu="related">相关笔记</button>' +
    '<button data-menu="copy-link">复制链接</button>' +
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
    document.title = '一条笔记 · flomo local';
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
  ctx.fillText('flomo local', 134, 118);

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
  ctx.fillText('写于 flomo local · 数据都在自己电脑里', 96, height - 84);

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
    a.download = 'flomo-local-' + Date.now() + '.png';
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
