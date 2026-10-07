#!/usr/bin/env bash
# 已安装后的启停辅助脚本（部署完执行）
set -euo pipefail

ACTION="${1:-}"
APP_DIR="/opt/api2api"
PORT=3210

usage() {
  cat <<EOF
用法: bash deploy/api2api-ctl.sh <命令>

  status    查看服务状态与健康
  token     打印管理员 token
  logs      跟踪日志
  restart   重启服务
  stop      停止服务
  start     启动服务
  backup    备份数据库与主密钥到 /root/backups
  uninstall 停止并移除服务（保留数据）
EOF
}

case "$ACTION" in
  status)
    systemctl status api2api --no-pager -l | head -20
    echo
    echo "--- 健康检查 ---"
    curl -s --max-time 5 "http://127.0.0.1:${PORT}/healthz" || echo "无响应"
    echo
    echo "--- 端口 ---"
    ss -tlnp 2>/dev/null | grep ":${PORT} " || echo "端口未监听"
    ;;
  token)
    if [ -f "$APP_DIR/data/admin_token" ]; then
      cat "$APP_DIR/data/admin_token"; echo
    else
      echo "未找到 $APP_DIR/data/admin_token"
      exit 1
    fi
    ;;
  logs)
    journalctl -u api2api -f
    ;;
  restart)
    systemctl restart api2api
    sleep 2
    systemctl is-active api2api && echo "已重启"
    ;;
  stop)
    systemctl stop api2api
    echo "已停止"
    ;;
  start)
    systemctl start api2api
    sleep 2
    systemctl is-active api2api && echo "已启动"
    ;;
  backup)
    BK="/root/backups/api2api-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BK"
    # 先让 sqlite 落盘
    cp -a "$APP_DIR/data/api2api.db"* "$BK/" 2>/dev/null || true
    cp -a "$APP_DIR/data/master.key" "$BK/" 2>/dev/null || true
    cp -a "$APP_DIR/data/admin_token" "$BK/" 2>/dev/null || true
    chmod 700 "$BK"
    echo "已备份到 $BK"
    ls -la "$BK"
    ;;
  uninstall)
    systemctl stop api2api 2>/dev/null || true
    systemctl disable api2api 2>/dev/null || true
    rm -f /etc/systemd/system/api2api.service
    systemctl daemon-reload
    echo "服务已移除，数据保留在 $APP_DIR/data"
    ;;
  *)
    usage
    ;;
esac
