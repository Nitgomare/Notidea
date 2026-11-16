'use strict';
// flomo-api.js — 本地客户端用的 API 封装（逆向产物，签名算法与官方客户端等价）
// 依赖：仅 Node 内置模块（crypto / fetch）
const crypto = require('crypto');

const SALT = 'dbbc3dd73364b4084c3a69346e0ce2b2';
const API_KEY = 'flomo_web';
const APP_VERSION = '5.26.111';
const BASE_V1 = 'https://flomoapp.com/api/v1';
const BASE_V2 = 'https://flomoapp.com/api/v2';

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

function ksort(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// 与客户端 _getSign 等价：键排序 → k=v&；数组先 localeCompare 排序再 k[]=v&；去尾 & 后加盐 md5
function signString(params) {
  const parts = [];
  for (const k of Object.keys(ksort(params))) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.map(String).sort((a, b) => a.localeCompare(b)).forEach((x) => parts.push(`${k}[]=${x}`));
    } else {
      parts.push(`${k}=${v}`);
    }
  }
  return parts.join('&');
}

const sign = (params) => md5(signString(params) + SALT);
const unix = () => Math.floor(Date.now() / 1000);

// 时区偏移（分钟，东八区 = 480），与客户端 getTz() 对齐
const tzOffset = () => -new Date().getTimezoneOffset();

function compact(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (v === '') continue;              // flomo 对空串参数返回 -100 sign 错误
    out[k] = v;
  }
  return out;
}

function prepareParams(params = {}, { platform = 'windows', apiKey = API_KEY, appVersion = APP_VERSION } = {}) {
  const p = compact(params);
  p.timestamp = unix();
  p.api_key = apiKey;
  p.app_version = appVersion;
  p.platform = platform;
  p.supports_video = 1;
  p.sign = sign({ ...p });
  return p;
}

function buildQuery(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => usp.append(k + '[]', String(x)));
    else usp.append(k, String(v));
  }
  return usp.toString();
}

function buildForm(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => usp.append(k + '[]', String(x)));
    else usp.append(k, String(v));
  }
  return usp;
}

/**
 * 统一请求入口。
 * @param {object} opts
 * @param {'GET'|'POST'|'PUT'|'DELETE'} opts.method
 * @param {string} opts.path      相对路径，如 '/memo/updated/'
 * @param {object} opts.params    业务参数（会自动补签名参数）
 * @param {object} opts.ctx       { token, deviceId, platform, v2 }
 * @param {'query'|'form'|'json'} opts.bodyType
 */
async function request({ method, path, params = {}, ctx, bodyType = 'form', platform, v2: forceV2 }) {
  if (!ctx || !ctx.token) throw new Error('缺少 access_token');
  const v2 = !!(forceV2 || ctx.v2);
  const base = v2 ? BASE_V2 : BASE_V1;
  const plat = platform || ctx.platform || 'windows';
  const signed = prepareParams(params, { platform: plat });
  const headers = {
    Authorization: 'Bearer ' + ctx.token,
    platform: plat,
    'device-model': plat === 'mac' ? 'Mac' : 'Windows',
    'device-id': ctx.deviceId || '',
    'User-Agent': `flomo/${APP_VERSION}`,
    Accept: 'application/json',
  };
  let url = base + path;
  const init = { method, headers };
  if (method === 'GET' || bodyType === 'query') {
    url += (url.includes('?') ? '&' : '?') + buildQuery(signed);
  } else if (bodyType === 'json') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(signed);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = buildForm(signed).toString();
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (data.code !== 0) {
    const err = new Error(data.message || `API 错误 code=${data.code}`);
    err.code = data.code;
    err.httpStatus = res.status;
    throw err;
  }
  return data.data;
}

const api = {
  me: (ctx) => request({ method: 'GET', path: '/user/me', ctx, bodyType: 'query' }),
  tags: (ctx) => request({ method: 'GET', path: '/tag/tree', ctx, bodyType: 'query' }),
  memos: (ctx, { limit = 30, latestUpdatedAt = '', latestSlug = '', tz = tzOffset() } = {}) =>
    request({
      method: 'GET', path: '/memo/updated/', ctx, bodyType: 'query',
      params: { limit, latest_updated_at: latestUpdatedAt, latest_slug: latestSlug, tz },
    }),
  createMemo: (ctx, { content, createdAt = 0, source = 'web', memoFrom = 'web', fileIds = [], pin = 0 }) =>
    request({
      method: 'POST', path: '/memo', ctx, v2: true, bodyType: 'form',
      params: { content, created_at: createdAt, source, memo_from: memoFrom, file_ids: fileIds, tz: tzOffset(), pin },
    }),
  updateMemo: (ctx, slug, { content, createdAt = 0, source = 'web', memoFrom = 'web', fileIds = [], pin = 0 }) =>
    request({
      method: 'PUT', path: `/memo/${slug}`, ctx, v2: true, bodyType: 'form',
      params: { content, created_at: createdAt, local_updated_at: Date.now(), source, memo_from: memoFrom, file_ids: fileIds, tz: tzOffset(), pin },
    }),
  deleteMemo: (ctx, slug) =>
    request({ method: 'DELETE', path: `/memo/${slug}`, ctx, v2: true, bodyType: 'form', params: {} }),
};

module.exports = { api, request, prepareParams, sign, signString, md5, tzOffset, SALT, API_KEY, BASE_V1, BASE_V2 };
