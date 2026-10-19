/**
 * 微信朋友圈·深度觉察 — Cloudflare Worker 中转
 *
 * 作用：前端只打本 Worker，Key 留在服务端；按 IP 限流，只允许白名单模型。
 *
 * 部署（在 proxy/ 目录）：
 *   npm i -g wrangler          # 或 npx wrangler
 *   wrangler login
 *   wrangler secret put DASHSCOPE_API_KEY   # 粘贴百炼新 Key，勿写入仓库
 *   wrangler deploy
 *
 * 可选 vars（wrangler.toml [vars] 或控制台）：
 *   ALLOWED_MODELS=qwen3-vl-flash
 *   MAX_RPM=6
 *   MAX_RPD=30
 *   MAX_GLOBAL_RPD=300
 *   CORS_ORIGIN=https://anton9527110.github.io
 *
 * 注意：下方限流用内存 Map，单 Worker 实例内有效；多实例/冷启动不共享计数。
 * 若需跨实例精确限流，可改绑 Cloudflare KV。
 */

const UPSTREAM = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

/** @type {Map<string, number[]>} */
const buckets = new Map();

function envNum(env, name, fallback) {
  const v = env && env[name];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function allowedOrigins(env) {
  const raw = (env && env.CORS_ORIGIN) || 'https://anton9527110.github.io';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isOriginAllowed(origin, env) {
  if (!origin) return false;
  const list = allowedOrigins(env);
  for (const o of list) {
    if (o === origin) return true;
    if (o.endsWith(':*') && origin.startsWith(o.slice(0, -1))) return true;
  }
  // 本地开发：任意 localhost / 127.0.0.1 端口
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  } catch (_) {}
  return false;
}

function corsHeaders(origin, env) {
  const allow = isOriginAllowed(origin, env) ? origin : allowedOrigins(env)[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonError(status, message, origin, env) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin, env),
    },
  });
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/**
 * 滑动窗口计数（内存）。key 形如 "rpm:1.2.3.4" / "rpd:1.2.3.4" / "global:rpd"
 * @returns {{ ok: boolean, retryAfterSec?: number }}
 */
function checkLimit(key, limit, windowMs) {
  if (limit <= 0) return { ok: true };
  const now = Date.now();
  let arr = buckets.get(key) || [];
  arr = arr.filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    const oldest = arr[0];
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    buckets.set(key, arr);
    return { ok: false, retryAfterSec };
  }
  arr.push(now);
  buckets.set(key, arr);
  // 偶尔清理过大 Map，避免无限增长
  if (buckets.size > 5000) {
    for (const [k, times] of buckets) {
      const kept = times.filter((t) => now - t < 86400000);
      if (kept.length) buckets.set(k, kept);
      else buckets.delete(k);
    }
  }
  return { ok: true };
}

function allowedModels(env) {
  const raw = (env && env.ALLOWED_MODELS) || 'qwen3-vl-flash,qwen3-vl-plus';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'wechat-moments-proxy',
          hint: 'POST / 或 /chat/completions，OpenAI 兼容；Key 由服务端注入。',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin, env) },
        }
      );
    }

    if (request.method !== 'POST') {
      return jsonError(405, '仅支持 POST /chat/completions', origin, env);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    if (path !== '/' && path !== '/chat/completions') {
      return jsonError(404, '路径不存在，请 POST / 或 /chat/completions', origin, env);
    }

    const apiKey = env && env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      return jsonError(500, '服务端未配置 DASHSCOPE_API_KEY', origin, env);
    }

    const maxRpm = envNum(env, 'MAX_RPM', 6);
    const maxRpd = envNum(env, 'MAX_RPD', 30);
    const maxGlobalRpd = envNum(env, 'MAX_GLOBAL_RPD', 300);
    const ip = clientIp(request);

    const rpm = checkLimit(`rpm:${ip}`, maxRpm, 60 * 1000);
    if (!rpm.ok) {
      const res = jsonError(
        429,
        `请求过于频繁：每分钟最多 ${maxRpm} 次，请稍后再试（约 ${rpm.retryAfterSec} 秒）。`,
        origin,
        env
      );
      res.headers.set('Retry-After', String(rpm.retryAfterSec));
      return res;
    }

    const rpd = checkLimit(`rpd:${ip}`, maxRpd, 24 * 60 * 60 * 1000);
    if (!rpd.ok) {
      const res = jsonError(
        429,
        `今日调用已达上限：每个访客每天最多 ${maxRpd} 次，请明天再试或联系熙雅。`,
        origin,
        env
      );
      res.headers.set('Retry-After', String(rpd.retryAfterSec));
      return res;
    }

    const global = checkLimit('global:rpd', maxGlobalRpd, 24 * 60 * 60 * 1000);
    if (!global.ok) {
      const res = jsonError(
        429,
        `全站今日调用已满（${maxGlobalRpd} 次），请稍后再试或联系熙雅。`,
        origin,
        env
      );
      res.headers.set('Retry-After', String(global.retryAfterSec));
      return res;
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return jsonError(400, '请求体必须是 JSON', origin, env);
    }

    const model = body && body.model;
    const models = allowedModels(env);
    if (!model || !models.has(model)) {
      return jsonError(
        400,
        `不允许的模型「${model || ''}」。仅开放：${[...models].join(', ')}`,
        origin,
        env
      );
    }

    // 忽略客户端 Authorization，一律用服务端 Key
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
      return jsonError(502, '上游接口连接失败：' + (e.message || e), origin, env);
    }

    const text = await upstream.text();
    const headers = {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
      ...corsHeaders(origin, env),
    };
    return new Response(text, { status: upstream.status, headers });
  },
};
