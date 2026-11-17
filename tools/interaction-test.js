'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8').replace(/\r\n/g, '\n');
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness(code, extras = {}) {
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, close() { this.closed = true; }, classList: { add() {}, remove() {}, contains() { return false; } } }); return elements.get(id); };
  const ctx = vm.createContext({ $, URLSearchParams, AbortController, TextDecoder, Set, console, toast() {}, ...extras });
  vm.runInContext(code, ctx);
  return { ctx, $, run: (s) => vm.runInContext(s, ctx) };
}
test('memo save locks duplicate POST and preserves new text/files/reminder', async () => {
  const request = deferred(); let calls = 0;
  const h = harness(part('let memoSaving = false;', "$('#btn-save').onclick"), {
    api: () => { calls++; return request.promise; }, draft: { value: 'old' }, state: { pendingFiles: [{ name: 'old' }] }, draftRemind: { at: 1 },
    setDraftRemind() {}, refreshReminderCount() {}, renderPending() {}, updateHint() {}, applyTags() {}, loadMemos: async () => {}, replayClass() {}, bornMemoId: null,
  });
  const first = h.run('saveMemo()'); await h.run('saveMemo()');
  h.run("draft.value = 'new'; state.pendingFiles.push({name:'new'}); draftRemind = {at:2}; state.filter = {type:'tag',value:'new'}");
  request.resolve({ memo: { id: 1 }, stats: {} }); await first;
  assert.equal(calls, 1); assert.equal(h.run('draft.value'), 'new'); assert.equal(h.run('state.pendingFiles[0].name'), 'new'); assert.equal(h.run('draftRemind.at'), 2);
  assert.equal(h.$('#btn-save').disabled, false); assert.equal(h.run('state.filter.value'), 'new');
});
test('comment save locks by memo and preserves replacement draft', async () => {
  const request = deferred(); let calls = 0; const input = { value: 'old' }, button = {};
  const card = { dataset: { id: '1' }, querySelector: () => ({ querySelector: (s) => s === 'input' ? input : button }) };
  const h = harness(part('const commentSaving = new Set();', '/* ---------------- 单条笔记模式'), { api: () => { calls++; return request.promise; }, state: { memos: [] }, loadComments: async () => {}, card });
  const first = h.run('sendComment(card)'); await h.run('sendComment(card)'); input.value = 'new'; request.resolve({}); await first;
  assert.equal(calls, 1); assert.equal(input.value, 'new'); assert.equal(button.disabled, false);
});
test('list ignores stale responses, serializes append, deduplicates IDs and advances raw offset', async () => {
  const requests = []; const h = harness(part('let memoLoadVersion = 0;', 'async function refreshBootstrap'), {
    api: (url) => { const d = deferred(); requests.push({ ...d, url }); return d.promise; },
    state: { filter: { type: 'all' }, view: { fhas: [] }, limit: 2, offset: 0, memos: [], hasMore: false }, renderList() {}, renderListTitle() {},
  });
  const old = h.run('loadMemos()'), latest = h.run('loadMemos()');
  requests[1].resolve({ memos: [{ id: 1 }, { id: 2 }] }); await latest;
  requests[0].resolve({ memos: [{ id: 99 }] }); await old;
  assert.equal(h.run('state.memos[0].id'), 1);
  const append = h.run('loadMemos({append:true})'); await h.run('loadMemos({append:true})'); assert.equal(requests.length, 3);
  requests[2].resolve({ memos: [{ id: 2 }, { id: 3 }] }); await append;
  assert.equal(h.run('state.memos.length'), 3); assert.equal(h.run('state.offset'), 4);
});
test('dialog submit prevents default synchronously and stays open on failure', async () => {
  const request = deferred(); const h = harness(part('let configSaving = false;', 'const btnExport'), { api: () => request.promise, refreshBootstrap: async () => {} });
  let prevented = false; const pending = h.$('#settings form').onsubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.$('#settings').closed, undefined);
  request.reject(new Error('offline')); await pending;
  assert.equal(h.$('#settings').closed, undefined); assert.equal(h.$('#btn-cfg-save').disabled, false);
});
test('AI superseding request aborts old stream and ignores stale completion', async () => {
  const requests = []; const h = harness(part("let currentAi = { skill: null", '/* 右侧面板默认'), {
    state: { llm: { hasKey: true } }, makeMdPainter: (el) => (text) => { el.innerHTML = text; }, escapeHtml: String,
    fetch: (url, options) => { const d = deferred(); requests.push({ ...d, options }); return d.promise; },
  });
  const old = h.run("runAi('ask')"), current = h.run("runAi('ask')");
  assert.equal(requests[0].options.signal.aborted, true);
  const response = (text) => { let read = false; return { ok: true, body: { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { value: Buffer.from('data: ' + JSON.stringify({ delta: text }) + '\n\n'), done: false }) }) } }; };
  requests[1].resolve(response('new')); await current; requests[0].resolve(response('old')); await old;
  assert.equal(h.run('currentAi.text'), 'new'); assert.equal(h.$('#rail-body').innerHTML, 'new');
});
test('tag submit blocks native close and retains failed edits', async () => {
  const request = deferred();
  const h = harness(part('let tagSaving = false;', '/* ---------------- 笔记列表'), { editingTag: { name: 'old', icon: '' }, api: () => request.promise, applyTags() {}, loadMemos: async () => {} });
  h.$('#te-name').value = 'new'; let prevented = false;
  const pending = h.$('#tag-edit form').onsubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  request.reject(new Error('offline')); await pending;
  assert.equal(h.$('#tag-edit').closed, undefined); assert.equal(h.$('#te-name').value, 'new'); assert.equal(h.$('#btn-te-save').disabled, false);
});
test('Escape consumes only the top dialog before rail or selection', () => {
  const callbacks = []; const dialog = { close() { this.closed = true; }, contains() { return false; } };
  const document = { addEventListener: (event, fn) => callbacks.push(fn), activeElement: { closest: () => dialog }, querySelectorAll: () => [], body: { classList: { contains: () => true } } };
  const h = harness(part("document.addEventListener('keydown', (e) => {", "document.querySelectorAll('.nav-item[data-filter]')"), { document, APP: () => { throw Error('must not close background rail'); } });
  let prevented = false, stopped = false;
  callbacks[0]({ key: 'Escape', preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(dialog.closed, true); assert.equal(prevented, true); assert.equal(stopped, true);
});
function searchHarness(reduced = false) {
  let now = 0, seq = 0;
  const timers = new Map(), elements = new Map(), handlers = new Map();
  const document = { activeElement: null, addEventListener: (type, fn) => handlers.set(type, fn), querySelectorAll: (s) => s.includes('.pop,') ? [$('#search-pop')] : [], body: { classList: { contains: () => false } } };
  const $ = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(), listeners = new Map();
      const el = { id: id.slice(1), value: '', hidden: true, style: { setProperty(k, v) { this[k] = v; } },
        classList: { add: (...names) => names.forEach((n) => classes.add(n)), remove: (...names) => names.forEach((n) => classes.delete(n)), contains: (n) => classes.has(n) },
        addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
        dispatchEvent(e) { e.target ||= el; for (const fn of listeners.get(e.type) || []) fn(e); },
        contains: (other) => !!other && (other === el || id === '#search-wrap' && ['search', 'quick', 'recent'].includes(other.id)),
        closest: () => null,
        focus() { if (document.activeElement === el) return; const old = document.activeElement; document.activeElement = el; if (old && $('#search-wrap').contains(old)) $('#search-wrap').dispatchEvent({ type: 'focusout', relatedTarget: el }); el.dispatchEvent({ type: 'focus' }); },
        blur() { if (document.activeElement !== el) return; document.activeElement = null; $('#search-wrap').dispatchEvent({ type: 'focusout', relatedTarget: null }); }, select() {},
      };
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const code = part('const reduceMotion =', '/* 折叠区') + part('state.searchMode =', '/* ---- 筛选面板') + part("document.addEventListener('keydown', (e) => {", "document.querySelectorAll('.nav-item[data-filter]')");
  const h = harness(code, { $, document, matchMedia: () => ({ matches: reduced }), getComputedStyle: () => ({ opacity: '0.03', transform: 'matrix(1, 0, 0, 1, 0, -9)', filter: 'none' }),
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: (id) => timers.delete(id),
    replayClass: (el, cls) => el.classList.add(cls), state: { view: {} }, localStorage: { getItem: () => null }, escapeHtml: String, setFilter() {}, loadMemos() {},
  });
  return { ...h, $, document, key: (key, extra = {}) => handlers.get('keydown')({ key, preventDefault() {}, stopImmediatePropagation() {}, ...extra }),
    tick(ms) { const end = now + ms; while (true) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); } now = end; },
  };
}
test('rapid focus/input hides immediately and stale close cannot hide a reopened pop', () => {
  const h = searchHarness(), input = h.$('#search'), pop = h.$('#search-pop');
  input.focus(); h.tick(1); input.value = 'x'; input.dispatchEvent({ type: 'input' });
  assert.equal(pop.hidden, true);
  input.value = ''; input.dispatchEvent({ type: 'input' }); assert.equal(pop.hidden, false);
  h.run("popClose($('#search-pop'))"); h.tick(100);
  h.run("popOpen($('#search-pop')); popClose($('#search-pop'))");
  h.tick(80); assert.equal(pop.hidden, false, 'first close deadline must not end second close');
  h.tick(100); assert.equal(pop.hidden, true);
  h.run("popOpen($('#search-pop')); popClose($('#search-pop'))"); h.tick(50); h.run("popOpen($('#search-pop'))"); h.tick(200);
  assert.equal(pop.hidden, false);
});
test('close animation captures current opacity instead of resetting to opaque', () => {
  const h = searchHarness(); h.$('#search').focus(); h.run("popClose($('#search-pop'))");
  assert.equal(h.$('#search-pop').style['--pop-close-opacity'], '0.03');
  const css = fs.readFileSync(require('node:path').join(__dirname, '../public/style.css'), 'utf8');
  assert.match(css, /@keyframes popClose \{ from \{ opacity: var\(--pop-close-opacity, 1\)/);
});
test('quick item click closes even when focus stays inside search wrapper', () => {
  const h = searchHarness(); h.$('#search').focus(); h.$('#quick').focus();
  h.$('#search-pop').dispatchEvent({ type: 'click', preventDefault() {}, target: { closest: (s) => s === '[data-quick]' ? { dataset: { quick: 'onthisday' } } : null } });
  assert.equal(h.$('#search-pop').hidden, true); assert.equal(h.run('state.view.onThisDay'), true);
});
test('Escape restores search focus without reopening; Ctrl+K and subsequent focus still work', () => {
  const h = searchHarness(); h.$('#search').focus(); h.$('#quick').focus(); h.key('Escape');
  assert.equal(h.document.activeElement, h.$('#search')); assert.equal(h.$('#search-pop').hidden, true);
  h.$('#search').blur(); h.key('k', { ctrlKey: true }); assert.equal(h.$('#search-pop').hidden, false);
  h.$('#quick').focus(); h.$('#outside').focus(); h.tick(180); assert.equal(h.$('#search-pop').hidden, true);
});
test('reduced motion close and immediate close cancel pending animation timers', () => {
  const h = searchHarness(true); h.$('#search').focus(); h.run("popClose($('#search-pop'))"); assert.equal(h.$('#search-pop').hidden, true);
  const animated = searchHarness(); animated.$('#search').focus(); animated.run("popClose($('#search-pop'))"); animated.tick(50);
  animated.run("popClose($('#search-pop'), true); popOpen($('#search-pop'))"); animated.tick(200); assert.equal(animated.$('#search-pop').hidden, false);
});
test('click inside search wrapper is not treated as an outside click', () => {
  let closeCount = 0; let handler;
  const h = harness(part('/* 点外部关闭所有弹层 */', '/* ---- 输入框工具栏'), {
    document: { addEventListener(type, fn) { handler = fn; } }, closePopsExcept() { closeCount++; },
  });
  handler({ target: { closest: (selector) => selector === '#search-wrap' ? {} : null } });
  assert.equal(closeCount, 0);
  handler({ target: { closest: () => null } });
  assert.equal(closeCount, 1);
});
test('active all-notes navigation does not reload but resets applied filters', async () => {
  let loads = 0;
  const h = harness(part('async function setFilter(f)', '/* ---------------- 事件：列表'), {
    state: { filter: {type:'all'}, has:'', search:'', view:{fhas:[]} }, searchTimer: null,
    clearTimeout() {}, loadMemos: async () => { loads++; }, syncFilterPop() {}, syncViewPop() {},
  });
  await h.run("setFilter({type:'all'})"); assert.equal(loads, 0);
  h.run("state.search='query'"); await h.run("setFilter({type:'all'})");
  assert.equal(loads, 1); assert.equal(h.run('state.search'), '');
});
test('keyboard and filter regressions remain guarded', () => {
  assert.ok(!source.includes("if (e.key === 'Tab') { e.preventDefault()"));
  assert.ok(source.includes('if (r || tm || fh || fs'));
  const handlers = source.split("addEventListener('keydown', (e) => {").slice(1);
  assert.ok(handlers.length >= 5);
  for (const handler of handlers) assert.match(handler, /^\n\s*if \(e\.isComposing \|\| e\.keyCode === 229 \|\| e\.defaultPrevented\) return;/);
  assert.ok(source.includes("$('#tag-edit form').onsubmit = async (e) => {\n  e.preventDefault();"));
});
