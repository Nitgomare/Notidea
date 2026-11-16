'use strict';
// 端到端自测：附件、筛选、双向链接、标签管理、热力图
const B = 'http://127.0.0.1:7777';
const j = async (path, opts = {}) => {
  const r = await fetch(B + path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const before = (await j('/api/bootstrap')).data.stats.total;

  // 1) 带附件建笔记
  const created = await j('/api/memos', { method: 'POST', body: { content: '带图的一条 #测试/附件', files: [{ name: 'dot.png', mime: 'image/png', dataBase64: png }] } });
  const m = created.data.memo;
  console.log('create memo', created.status, 'id', m.id, 'files', m.files.length, 'url', m.files[0].url, 'tags', m.tags.join(','));

  // 2) 附件可访问
  const fileRes = await fetch(B + m.files[0].url);
  console.log('fetch file', fileRes.status, fileRes.headers.get('content-type'), (await fileRes.arrayBuffer()).byteLength, 'bytes');

  // 3) 筛选
  console.log('has=images', (await j('/api/memos?has=images')).data.memos.length);
  console.log('has=notags', (await j('/api/memos?has=notags')).data.memos.length);
  console.log('has=links', (await j('/api/memos?has=links')).data.memos.length);

  // 4) 双向链接
  const target = (await j('/api/memos?limit=5')).data.memos.find((x) => x.id !== m.id);
  const linked = await j('/api/memos', { method: 'POST', body: { content: '这条引用了 [[' + target.slug + ']] 试试反链' } });
  const back = (await j('/api/memos/' + target.id + '/links')).data;
  console.log('backlinks', back.backlinks.length, 'forward', (await j('/api/memos/' + linked.data.memo.id + '/links')).data.forward.length);

  // 5) 标签重命名（带子标签与正文改写）
  const renamed = await j('/api/tags/rename', { method: 'POST', body: { from: '测试', to: '临时测试' } });
  console.log('rename', renamed.status, renamed.data.changed, 'tags', renamed.data.tags.map((t) => t.name).join(','));

  // 6) 置顶/图标
  const meta = await j('/api/tags/meta', { method: 'POST', body: { name: '临时测试', pinned: true, icon: '★' } });
  console.log('meta', meta.status, JSON.stringify(meta.data.tags.find((t) => t.name === '临时测试')));

  // 7) 热力图
  const hm = (await j('/api/heatmap?days=30')).data.heatmap;
  console.log('heatmap days', Object.keys(hm).length, 'today', hm[new Date().toISOString().slice(0, 10)]);

  // 8) 相关笔记（本地 TF-IDF，不联网）
  const rel = await j('/api/memos/' + m.id + '/related?limit=5');
  console.log('related', rel.status, 'hits', rel.data.related.length);

  // 9) 清理测试数据
  await j('/api/memos/' + m.id, { method: 'DELETE' });
  await j('/api/memos/' + linked.data.memo.id, { method: 'DELETE' });
  await j('/api/tags/delete', { method: 'POST', body: { name: '临时测试' } });
  const after = (await j('/api/bootstrap')).data.stats.total;
  console.log('cleanup', before, '->', after);
})();
