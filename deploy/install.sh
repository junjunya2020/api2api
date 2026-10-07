#!/usr/bin/env bash
# api2api 部署���本 —— 在 219 上执行
# 用法：bash deploy/install.sh
set -euo pipefail

APP_DIR="/opt/api2api"
SERVICE="/etc/systemd/system/api2api.service"
PORT=3210

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

green "=== api2api 部署 ==="

# 1. 检查 node
if ! command -v node >/dev/null 2>&1; then
  red "未找到 node，请先安装 Node.js >= 22.5（需要 node:sqlite）"
  exit 1
fi
NODE_VER=$(node -v)
green "node 版本: $NODE_VER"
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  red "Node 版本过低（需要 >= 22.5，node:sqlite 才可用）"
  exit 1
fi

# 2. 检查 node:sqlite 可用
if ! node --no-warnings -e "require('node:sqlite')" >/dev/null 2>&1; then
  red "node:sqlite 不可用，请升级 Node 到 22.5+"
  exit 1
fi
green "node:sqlite 可用"

# 3. 端口检查
if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
  red "端口 ${PORT} 已被占用："
  ss -tlnp 2>/dev/null | grep ":${PORT} " || true
  exit 1
fi
green "端口 ${PORT} 空闲"

# 4. 创建数据目录与主密钥
mkdir -p "$APP_DIR/data"
chmod 700 "$APP_DIR/data"

if [ ! -f "$APP_DIR/data/master.key" ]; then
  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" > "$APP_DIR/data/master.key"
  chmod 600 "$APP_DIR/data/master.key"
  green "已生成主密钥 data/master.key"
else
  yellow "主密钥已存在，保留"
fi

# 5. 安装 systemd unit
if [ -f "$APP_DIR/deploy/api2api.service" ]; then
  cp "$APP_DIR/deploy/api2api.service" "$SERVICE"
else
  yellow "未找到 deploy/api2api.service，跳过 unit 安装"
fi

# 6. 重启服务
systemctl daemon-reload
systemctl enable api2api >/dev/null 2>&1 || true
systemctl restart api2api
sleep 2

if systemctl is-active --quiet api2api; then
  green "服务已启动"
else
  red "服务启动失败，查看日志："
  journalctl -u api2api -n 30 --no-pager
  exit 1
fi

# 7. 健康检查
if curl -s --max-time 5 "http://127.0.0.1:${PORT}/healthz" | grep -q '"ok":true'; then
  green "健康检查通过"
else
  red "健康检查失败"
  journalctl -u api2api -n 30 --no-pager
  exit 1
fi

echo
green "=== 部署完成 ==="
echo
echo "初始 token（管理员，请妥善保存）："
if [ -f "$APP_DIR/data/admin_token" ]; then
  echo "  $(cat "$APP_DIR/data/admin_token")"
else
  yellow "  未生成，检查日志：journalctl -u api2api -n 20"
fi
echo
echo "用法："
echo "  本机访问：  curl -H \"Authorization: Bearer \$(cat $APP_DIR/data/admin_token)\" http://127.0.0.1:${PORT}/api/keys"
echo "  隧道访问：  ssh -N -L ${PORT}:127.0.0.1:${PORT} root@<your-host>"
echo "             然后浏览器打开 http://127.0.0.1:${PORT}"
echo "  查看日志：  journalctl -u api2api -f"
echo "  重启：      systemctl restart api2api"
echo "  停止：      systemctl stop api2api"
