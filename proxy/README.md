# 朋友分享用：Cloudflare Worker 中转（含速率限流）

前端只请求 Worker；**百炼 API Key 只存在 Worker Secret**，绝不写进 GitHub Pages。

默认限流（适合约 **5～20 位朋友**试用）：

| 项 | 默认 | 含义 |
|----|------|------|
| `MAX_RPM` | 3 | 每个 IP 每分钟最多 3 次 |
| `MAX_RPD` | 20 | 每个 IP 每天最多 20 次 |
| `MAX_GLOBAL_RPD` | 200 | 全站每天最多 200 次 |
| `ALLOWED_MODELS` | `qwen3-vl-flash` | 只允许便宜视觉模型 |

> 限流用 Worker **内存 Map**：同一实例内有效；多实例/冷启动不共享。够用防刷；若要精确跨实例，可再绑 KV。

---

## 一、百炼控制台：业务空间 RPM + 预算（保险丝）

百炼**原生 RPM/TPM 是空间级合并**，不是「每个好友独立额度」，也**挡不住慢速刷一整天**。朋友分享必须靠本中转按 IP 限流；下面步骤是双保险。

1. **新建非默认业务空间**  
   百炼控制台 → 业务空间管理 → 创建新空间（**默认空间无法单独限流**）。
2. **只开通需要的模型**  
   全局管理 → 进入该空间 → 模型 → 仅开通 `qwen3-vl-flash`（不要开 Plus/Max/思考模式）。
3. **当前空间限流（示例）**  
   空间设置 → 限流：请求数例如 **3 / 60 秒**；Token 例如 **200000 / 60 秒**。  
   说明：这是**整个空间所有 Key 合计**，不是每好友独立。
4. **在该空间新建 API Key**  
   复制新 Key，后面塞进 Worker Secret。控制台**删除/禁用旧 Key**（尤其曾写进网页的那把）。
5. **预算管理**  
   费用用量 → [预算管理](https://help.aliyun.com/zh/model-studio/budget-management) → 给该 Key（或该空间）设月预算，例如 **30 元** → 勾选**达额即停** → 设 **80% 预警**通知。

**强调：**
- 百炼 RPM ≠ 按天金额上限；慢速刷仍可能花光预算。
- **Key 绝不能回写 Pages / 前端源码。**

---

## 二、部署 Cloudflare Worker（熙雅照做）

### 1. 准备
- 注册 [Cloudflare](https://dash.cloudflare.com/)（免费即可）
- 本机安装 Node.js 18+

### 2. 安装并登录 wrangler
```bash
cd proxy
npm i -g wrangler
# 或：npx wrangler
wrangler login
```

### 3. 写入 Secret（Key 不进文件）
```bash
wrangler secret put DASHSCOPE_API_KEY
# 粘贴「新业务空间」里创建的 Key，回车
```

### 4. 按需改 vars
编辑同目录 `wrangler.toml` 里的 `[vars]`：
- 朋友很少（≤5）：`MAX_RPD=10`，`MAX_GLOBAL_RPD=80`
- 朋友约 5～20：保持默认 `MAX_RPM=3` / `MAX_RPD=20` / `MAX_GLOBAL_RPD=200`
- `CORS_ORIGIN` 填你的 Pages 源，多个用逗号分隔

### 5. 部署
```bash
wrangler deploy
```
成功后复制输出里的 URL，形如：
`https://wechat-moments-proxy.<你的子域>.workers.dev`

### 6. 填进前端
打开 `site/index.html`，把：
```js
const DEFAULT_PROXY = '';
```
改成（**不要末尾斜杠**）：
```js
const DEFAULT_PROXY = 'https://wechat-moments-proxy.xxx.workers.dev';
```
再发布 GitHub Pages。也可用浏览器控制台临时：
```js
localStorage.setItem('wxiv_proxy', 'https://wechat-moments-proxy.xxx.workers.dev');
```

### 7. 自测
- 浏览器打开 Pages → 上传图 → 开始觉察，应能出结果。
- 1 分钟内狂点超过 3 次，应看到中文 429 提示。
- 打开网页源码，确认**没有** `sk-` 开头的 Key。

---

## 三、备选：阿里云函数计算

同目录 `aliyun-fc-index.js` 为同能力简版（环境变量名相同）。若已有阿里云 FC，可创 HTTP 函数部署；推荐优先 Cloudflare（免费、CORS/全球边缘更省事）。

---

## 四、前端请求约定

- `POST {PROXY}/chat/completions` 或 `POST {PROXY}/`  
- Body：OpenAI 兼容 JSON（含 `model`、`messages`）  
- 客户端可带或不带 `Authorization`；**Worker 一律忽略，改用服务端 Key**  
- 模型必须在 `ALLOWED_MODELS` 内，否则 400
