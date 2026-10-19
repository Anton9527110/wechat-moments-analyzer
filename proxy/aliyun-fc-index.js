/**
 * 阿里云函数计算（HTTP 触发）备选入口 — 与 Cloudflare Worker 同能力简版。
 * 环境变量：DASHSCOPE_API_KEY、ALLOWED_MODELS、MAX_RPM、MAX_RPD、MAX_GLOBAL_RPD、CORS_ORIGIN
 * 限流同样用进程内 Map（多实例不共享）。生产可改 Redis。
 *
 * 部署提示：创建 FC 3.0 Node.js HTTP 函数，入口本文件；触发器勾选 CORS 或自行回写头。
 */

const UPSTREAM = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const buckets = new Map();

function envNum(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function allowedOrigins() {
  const raw = process.env.CORS_ORIGIN || 'https://anton9527110.github.io';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isOriginAllowed(origin) {
  if (!origin) return false;
  for (const o of allowedOrigins()) {
    if (o === origin) return true;
  }
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  } catch (_) {}
  return false;
}

function cors(origin) {
  const allow = isOriginAllowed(origin) ? origin : allowedOrigins()[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

function checkLimit(key, limit, windowMs) {
  if (limit <= 0) return { ok: true };
  const now = Date.now();
  let arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)) };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true };
}

exports.handler = async (req, res) => {
  // FC HTTP：req 可能是 (event, context) 或 Express 风格；此处按 FC 3.0 HTTP 触发器适配
  const method = (req.method || req.requestContext?.http?.method || 'GET').toUpperCase();
  const headersIn = req.headers || {};
  const origin = headersIn.origin || headersIn.Origin || '';
  const set = (code, body, extra = {}) => {
    res.setStatusCode(code);
    const h = { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin), ...extra };
    Object.entries(h).forEach(([k, v]) => res.setHeader(k, v));
    res.send(typeof body === 'string' ? body : JSON.stringify(body));
  };

  if (method === 'OPTIONS') {
    res.setStatusCode(204);
    Object.entries(cors(origin)).forEach(([k, v]) => res.setHeader(k, v));
    return res.send('');
  }
  if (method !== 'POST') {
    return set(405, { error: { message: '仅支持 POST' } });
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return set(500, { error: { message: '服务端未配置 DASHSCOPE_API_KEY' } });

  const ip =
    headersIn['x-forwarded-for']?.split(',')[0]?.trim() ||
    headersIn['x-real-ip'] ||
    'unknown';
  const maxRpm = envNum('MAX_RPM', 3);
  const maxRpd = envNum('MAX_RPD', 20);
  const maxGlobal = envNum('MAX_GLOBAL_RPD', 200);

  let hit = checkLimit(`rpm:${ip}`, maxRpm, 60000);
  if (!hit.ok) return set(429, { error: { message: `请求过于频繁：每分钟最多 ${maxRpm} 次` } }, { 'Retry-After': String(hit.retryAfterSec) });
  hit = checkLimit(`rpd:${ip}`, maxRpd, 86400000);
  if (!hit.ok) return set(429, { error: { message: `今日调用已达上限：每天最多 ${maxRpd} 次` } }, { 'Retry-After': String(hit.retryAfterSec) });
  hit = checkLimit('global:rpd', maxGlobal, 86400000);
  if (!hit.ok) return set(429, { error: { message: `全站今日调用已满（${maxGlobal} 次）` } }, { 'Retry-After': String(hit.retryAfterSec) });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch (_) {
    return set(400, { error: { message: '请求体必须是 JSON' } });
  }

  const models = new Set((process.env.ALLOWED_MODELS || 'qwen3-vl-flash').split(',').map((s) => s.trim()).filter(Boolean));
  if (!body.model || !models.has(body.model)) {
    return set(400, { error: { message: `不允许的模型。仅开放：${[...models].join(', ')}` } });
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    res.setStatusCode(upstream.status);
    Object.entries(cors(origin)).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    res.send(text);
  } catch (e) {
    set(502, { error: { message: '上游接口连接失败：' + (e.message || e) } });
  }
};
