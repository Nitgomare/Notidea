'use strict';
// llm.js — 只依赖用户自备的大模型 API（OpenAI 兼容 /chat/completions），零 SDK
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'llm.json');
const PROMPT_DIR = path.join(__dirname, 'prompts');

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 1200,
};

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

const publicConfig = () => {
  const c = readConfig();
  return { baseUrl: c.baseUrl, model: c.model, temperature: c.temperature, hasKey: !!c.apiKey, keyHint: c.apiKey ? c.apiKey.slice(0, 4) + '****' + c.apiKey.slice(-4) : '' };
};

/** 读取 prompts/<kind>.md，解析 `---` 头部的 name/description 与正文模板 */
function loadPrompt(kind) {
  const file = path.join(PROMPT_DIR, `${kind}.md`);
  if (!fs.existsSync(file)) throw new Error(`未找到提示词模板: prompts/${kind}.md`);
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  // CRLF / LF 都要认：Windows 上 git 的 autocrlf 会把 .md 转成 CRLF，只认 \n 会让 front-matter 解析失败
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    body = m[2];
  }
  return { meta, body: body.trim() };
}

function fill(template, vars) {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));
}

function listPrompts() {
  return fs.readdirSync(PROMPT_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const kind = f.replace(/\.md$/, '');
    const { meta } = loadPrompt(kind);
    return { kind, name: meta.name || kind, description: meta.description || '' };
  });
}

const INSIGHT_DIR = path.join(PROMPT_DIR, 'insights');

/** AI 洞察的"视角"：prompts/insights/*.md，一个文件就是一个视角 */
function listInsights() {
  if (!fs.existsSync(INSIGHT_DIR)) return [];
  return fs.readdirSync(INSIGHT_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const id = f.replace(/\.md$/, '');
      const { meta } = loadPrompt('insights/' + id);
      return {
        id,
        name: meta.name || id,
        author: meta.author || '',
        category: meta.category || '其它',
        range: meta.range || '全部笔记',
        days: Number(meta.days || 0),
        icon: meta.icon || '✧',
        order: Number(meta.order || 999),
        badge: meta.badge || '',
        description: meta.description || '',
        file: path.join('prompts', 'insights', f),
      };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/**
 * 流式对话。yield 文本增量。
 * @param {{messages: Array<{role:string,content:string}>, stream?: boolean}} opts
 */
async function* chat(opts) {
  const cfg = readConfig();
  if (!cfg.apiKey) throw new Error('尚未配置大模型 API Key，请在设置里填写');
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: opts.messages,
      temperature: opts.temperature ?? cfg.temperature,
      max_tokens: opts.maxTokens ?? cfg.maxTokens,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型接口返回 ${res.status}: ${t.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* 忽略心跳/半包 */ }
    }
  }
}

/** 构造某类 skill 的 messages */
function buildMessages(kind, vars) {
  const { meta, body } = loadPrompt(kind);
  const system = meta.system || '你是一个克制、具体的笔记助手，输出中文，不说套话。';
  const user = fill(body, vars);
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

module.exports = { chat, buildMessages, loadPrompt, listPrompts, listInsights, readConfig, writeConfig, publicConfig, fill };
