# 国内轻量机部署（Ubuntu）

把觉察页 + 中转都放在阿里云轻量服务器，朋友用 **公网 IP** 访问（未备案不绑国内域名）。

## 你需要准备
1. Ubuntu 轻量机公网 IP，安全组放行 **80**
2. 百炼业务空间 API Key（只写入服务器 `/etc/wechat-moments-proxy.env`）
3. 本目录整包上传到服务器（见下）

## 上传并安装
在你自己电脑（已能 SSH）或轻量「远程连接」里：

```bash
# 示例：把打包文件拷到服务器后解压
cd /tmp
# tar xzvf wechat-moments-ubuntu-lite.tgz && cd ubuntu-lite
sudo bash install.sh
sudo nano /etc/wechat-moments-proxy.env   # 填 DASHSCOPE_API_KEY
sudo systemctl restart wechat-moments-proxy
```

打开：`http://你的公网IP/`

## 结构
- `public/` 静态觉察页（同源自动走 `/api`）
- `server.js` 中转（藏 Key、限流）
- Nginx 反代 `/api` → `127.0.0.1:8787`

## 与 Cloudflare 关系
GitHub Pages 仍指向 Cloudflare Worker，作海外备份；国内主推本轻量机入口。

# 注：本机若已有服务占用 8787（如 ooori-web），中转默认用 8788。
