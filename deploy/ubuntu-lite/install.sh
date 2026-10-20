#!/usr/bin/env bash
# 在阿里云轻量 Ubuntu 上以 root 执行：
#   sudo bash install.sh
# 执行前请把本目录（含 public/index.html、server.js 等）放到机器上。
set -euo pipefail

APP_DIR=/opt/wechat-moments
WEB_DIR=/var/www/wechat-moments
ENV_FILE=/etc/wechat-moments-proxy.env
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 或 sudo 执行" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx curl ca-certificates

# Node 20（若已有 >=18 可跳过）
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | tr -d v | cut -d. -f1)" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

mkdir -p "$APP_DIR" "$WEB_DIR"
rsync -a --delete \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'node_modules' \
  --exclude 'public' \
  "$SRC_DIR/" "$APP_DIR/"

if [[ -d "$SRC_DIR/public" ]]; then
  rsync -a --delete "$SRC_DIR/public/" "$WEB_DIR/"
fi

cd "$APP_DIR"
# 无第三方依赖；保留 package.json 便于识别

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SRC_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE — 请编辑填入 DASHSCOPE_API_KEY 后执行："
  echo "  sudo systemctl restart wechat-moments-proxy"
fi

chown -R www-data:www-data "$APP_DIR" "$WEB_DIR"
chmod 600 "$ENV_FILE" || true

cp "$SRC_DIR/wechat-moments-proxy.service" /etc/systemd/system/wechat-moments-proxy.service
cp "$SRC_DIR/nginx-wechat-moments.conf" /etc/nginx/sites-available/wechat-moments
ln -sfn /etc/nginx/sites-available/wechat-moments /etc/nginx/sites-enabled/wechat-moments
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl daemon-reload
systemctl enable --now wechat-moments-proxy
systemctl reload nginx

IP="$(curl -sS --max-time 3 ifconfig.me || hostname -I | awk '{print $1}')"
echo
echo "=== 安装完成 ==="
echo "1) 编辑 Key: sudo nano $ENV_FILE"
echo "2) 重启中转: sudo systemctl restart wechat-moments-proxy"
echo "3) 安全组放行 TCP 80"
echo "4) 国内手机浏览器打开: http://${IP}/"
echo "5) 健康检查: curl -s http://127.0.0.1/health"
echo "验尸见同目录 AUTOPSY.md"
