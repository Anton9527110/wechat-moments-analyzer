#!/usr/bin/env node
/**
 * 阿里云轻量 Ubuntu 中转（与 Cloudflare Worker 同能力）
 * 环境变量见 .env.example；由 systemd EnvironmentFile 注入。
 * Key 只在服务端；浏览器走 Nginx /api → 本进程。
 */
'use strict';

const http = require('http');
const { URL } = require('url');

const UPSTREAM = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // 只听本机，由 Nginx 反代
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
  if (!origin) return true; // 同源 / 无 Origin 的健康检查
  for (const o of allowedOrigins()) {
    if (o === origin) return true;
    if (o === '*') return true;
  }
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    // 允许公网 IP 作为 Origin（未备案用 IP 访问时）
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return true;
  } catch (_) {}
  return false;
}

function corsHeaders(origin) {
  const allow = !origin
    ? allowedOrigins()[0] || '*'
    : isOriginAllowed(origin)
      ? origin
      : allowedOrigins()[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(res, status, obj, origin, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(origin),
    ...extra,
  });
  res.end(body);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
}

function checkLimit(key, limit, windowMs) {
  if (limit <= 0) return { ok: true };
  const now = Date.now();
  let arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000)),
    };
  }
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 5000) {
    for (const [k, times] of buckets) {
      const kept = times.filter((t) => now - t < 86400000);
      if (kept.length) buckets.set(k, kept);
      else buckets.delete(k);
    }
  }
  return { ok: true };
}

function allowedModels() {
  const raw =
    process.env.ALLOWED_MODELS ||
    'qwen3-vl-flash-2025-10-15,qwen3-vl-flash,qwen3-vl-plus,qwen-vl-plus,qwen2.5-vl-72b-instruct';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const origin = req.headers.origin || '';
  const method = (req.method || 'GET').toUpperCase();
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/\/$/, '') || '/';
  } catch (_) {}

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    return res.end();
  }

  if (method === 'GET' && (pathname === '/' || pathname === '/health')) {
    return json(res, 200, {
      ok: true,
      service: 'wechat-moments-ubuntu-proxy',
      hint: 'POST / 或 /chat/completions；Key 由服务端注入。',
    }, origin);
  }

  if (method !== 'POST') {
    return json(res, 405, { error: { message: '仅支持 POST /chat/completions' } }, origin);
  }

  if (pathname !== '/' && pathname !== '/chat/completions') {
    return json(res, 404, { error: { message: '路径不存在，请 POST / 或 /chat/completions' } }, origin);
  }

  if (origin && !isOriginAllowed(origin)) {
    return json(res, 403, { error: { message: '来源不被允许' } }, origin);
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return json(res, 500, { error: { message: '服务端未配置 DASHSCOPE_API_KEY' } }, origin);
  }

  const maxRpm = envNum('MAX_RPM', 6);
  const maxRpd = envNum('MAX_RPD', 30);
  const maxGlobalRpd = envNum('MAX_GLOBAL_RPD', 300);
  const ip = clientIp(req);

  let hit = checkLimit(`rpm:${ip}`, maxRpm, 60 * 1000);
  if (!hit.ok) {
    return json(
      res,
      429,
      { error: { message: `请求过于频繁：每分钟最多 ${maxRpm} 次，请稍后再试（约 ${hit.retryAfterSec} 秒）。` } },
      origin,
      { 'Retry-After': String(hit.retryAfterSec) }
    );
  }
  hit = checkLimit(`rpd:${ip}`, maxRpd, 24 * 60 * 60 * 1000);
  if (!hit.ok) {
    return json(
      res,
      429,
      { error: { message: `今日调用已达上限：每个访客每天最多 ${maxRpd} 次，请明天再试或联系熙雅。` } },
      origin,
      { 'Retry-After': String(hit.retryAfterSec) }
    );
  }
  hit = checkLimit('global:rpd', maxGlobalRpd, 24 * 60 * 60 * 1000);
  if (!hit.ok) {
    return json(
      res,
      429,
      { error: { message: `全站今日调用已满（${maxGlobalRpd} 次），请稍后再试或联系熙雅。` } },
      origin,
      { 'Retry-After': String(hit.retryAfterSec) }
    );
  }

  let raw;
  try {
    raw = await readBody(req, envNum('MAX_BODY_BYTES', 25 * 1024 * 1024));
  } catch (e) {
    if (e.code === 'BODY_TOO_LARGE') {
      return json(res, 413, { error: { message: '图片总大小过大，请减少张数或再压缩后重试。' } }, origin);
    }
    return json(res, 400, { error: { message: '读取请求失败' } }, origin);
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (_) {
    return json(res, 400, { error: { message: '请求体必须是 JSON' } }, origin);
  }

  const models = allowedModels();
  if (!body.model || !models.has(body.model)) {
    return json(
      res,
      400,
      { error: { message: `不允许的模型「${body.model || ''}」。仅开放：${[...models].join(', ')}` } },
      origin
    );
  }

  // 忽略客户端 Authorization
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return json(res, 502, { error: { message: '上游接口连接失败：' + (e.message || e) } }, origin);
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    ...corsHeaders(origin),
  });
  res.end(text);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[proxy]', e && e.message ? e.message : e);
    try {
      json(res, 500, { error: { message: '服务内部错误' } }, req.headers.origin || '');
    } catch (_) {}
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[wechat-moments-proxy] listening on http://${HOST}:${PORT}`);
});
