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
test('keyboard and filter regressions remain guarded', () => {
  assert.ok(!source.includes("if (e.key === 'Tab') { e.preventDefault()"));
  assert.ok(source.includes('if (r || tm || fh || fs'));
  const handlers = source.split("addEventListener('keydown', (e) => {").slice(1);
  assert.ok(handlers.length >= 5);
  for (const handler of handlers) assert.match(handler, /^\n\s*if \(e\.isComposing \|\| e\.keyCode === 229 \|\| e\.defaultPrevented\) return;/);
  assert.ok(source.includes("$('#tag-edit form').onsubmit = async (e) => {\n  e.preventDefault();"));
});
