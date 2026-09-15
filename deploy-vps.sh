#!/usr/bin/env bash
# =====================================================================
#  类脑邀请守望者 —— Linux 服务器 / 树莓派 / NAS 部署脚本
#
#  用途：把本地那份 monitor.mjs 全自动装到一台常开的 Linux 机器上，
#        从而摆脱「电脑关机就停」的限制，且完全不依赖 Cloudflare。
#
#  用法（在服务器上执行）：
#      bash deploy-vps.sh install  /path/to/leina-invite-watch
#      bash deploy-vps.sh status
#      bash deploy-vps.sh logs
#      bash deploy-vps.sh uninstall
#
#  依赖：node（>=18）+ systemd 或 cron。脚本会自己检测并按需安装。
# =====================================================================
set -euo pipefail

SRC_DIR="${2:-$(cd "$(dirname "$0")" && pwd)}"
TARGET="/opt/leina-invite-watch"
SVC="leina-invite-watch"
INTERVAL_MIN="${INTERVAL_MIN:-2}"

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  [OK] %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  [!] %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  [X] %s\033[0m\n' "$*" >&2; exit 1; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else die "需要 root 权限（或安装 sudo）"; fi
  else
    SUDO=""
  fi
}

detect_node() {
  if command -v node >/dev/null 2>&1; then
    local v major
    v="$(node --version)"
    major="$(echo "$v" | sed 's/^v//' | cut -d. -f1)"
    [ "$major" -ge 18 ] || die "node 版本过低（$v），monitor.mjs 需要 >=18"
    ok "已安装 node $v"
    return 0
  fi
  warn "未检测到 node，尝试自动安装"
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq && $SUDO apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y nodejs
  elif command -v opkg >/dev/null 2>&1; then
    $SUDO opkg update && $SUDO opkg install node
  else
    die "无法自动安装 node，请手动安装后重跑"
  fi
  command -v node >/dev/null 2>&1 || die "安装后仍找不到 node"
  ok "node 安装完成：$(node --version)"
}

# ---------------------------------------------------------------- install
do_install() {
  need_root
  [ -f "$SRC_DIR/monitor.mjs" ] || die "在 $SRC_DIR 下找不到 monitor.mjs（用第二个参数指定目录）"
  [ -f "$SRC_DIR/monitor.config.json" ] || die "找不到 monitor.config.json"

  say "[1/5] 检查 node"
  detect_node

  say "[2/5] 复制文件到 $TARGET"
  $SUDO mkdir -p "$TARGET"
  $SUDO cp "$SRC_DIR/monitor.mjs" "$SRC_DIR/monitor.config.json" "$TARGET/"
  ok "已复制 monitor.mjs 与 monitor.config.json"

  say "[3/5] 首次运行建立基线"
  cd "$TARGET"
  node monitor.mjs --baseline-only || die "基线建立失败，看上面的报错"

  say "[4/5] 安装定时器"
  if command -v systemctl >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    $SUDO tee /etc/systemd/system/${SVC}.service >/dev/null <<EOF
[Unit]
Description=Leina Discord invite watcher (single check)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$TARGET
ExecStart=$NODE_BIN $TARGET/monitor.mjs --once
StandardOutput=append:$TARGET/watch.log
StandardError=append:$TARGET/watch.log
EOF
    $SUDO tee /etc/systemd/system/${SVC}.timer >/dev/null <<EOF
[Unit]
Description=Run Leina invite watcher every ${INTERVAL_MIN} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL_MIN}min
AccuracySec=10s
Persistent=true

[Install]
WantedBy=timers.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now ${SVC}.timer
    ok "systemd timer 已启用（每 ${INTERVAL_MIN} 分钟）"
  else
    warn "没有 systemd，改用 cron"
    NODE_BIN="$(command -v node)"
    CRON_LINE="*/${INTERVAL_MIN} * * * * cd $TARGET && $NODE_BIN $TARGET/monitor.mjs --once >> $TARGET/watch.log 2>&1"
    ( $SUDO crontab -l 2>/dev/null | grep -v 'monitor.mjs' || true; echo "$CRON_LINE" ) | $SUDO crontab -
    ok "cron 已写入（每 ${INTERVAL_MIN} 分钟）"
  fi

  say "[5/5] 核对安装结果"
  [ -f "$TARGET/monitor.mjs" ] || die "monitor.mjs 未就位"
  ok "monitor.mjs 就位"
  [ -f "$TARGET/state.json" ] && ok "基线文件 state.json 已生成" || warn "state.json 未生成（首次 --once 时会建）"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-enabled ${SVC}.timer >/dev/null 2>&1 && ok "timer 已 enable" || die "timer 未 enable"
    systemctl is-active  ${SVC}.timer >/dev/null 2>&1 && ok "timer 正在运行" || warn "timer 未 active"
  fi

  cat <<EOF

  安装完成。三点提醒：
    * 服务器没有桌面，只有 webhook 通知有效（toast/sound 会自动失效）。
      填法：编辑 $TARGET/monitor.config.json 的 notify.webhookUrl
    * 这台机器必须能访问 discord.com。境内机器需配代理，
      可把 HTTPS_PROXY 加进 /etc/systemd/system/${SVC}.service 的 Environment= 行。
    * 查看是否在跑： bash deploy-vps.sh status
EOF
}

# ---------------------------------------------------------------- status
do_status() {
  [ -d "$TARGET" ] || die "未安装（找不到 $TARGET）"
  say "安装目录：$TARGET"
  ls -l "$TARGET" || true
  echo
  if command -v systemctl >/dev/null 2>&1; then
    systemctl list-timers "$SVC.timer" --all --no-pager 2>/dev/null || true
    echo
    systemctl status "$SVC.service" --no-pager -n 10 2>/dev/null || true
  else
    say "cron 条目："
    crontab -l 2>/dev/null | grep monitor.mjs || echo "  (无)"
  fi
  echo
  say "最近日志："
  tail -n 12 "$TARGET/watch.log" 2>/dev/null || echo "  (暂无)"
}

do_logs() { tail -f "$TARGET/watch.log"; }

# ---------------------------------------------------------------- uninstall
do_uninstall() {
  need_root
  if command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl disable --now ${SVC}.timer 2>/dev/null || true
    $SUDO rm -f /etc/systemd/system/${SVC}.service /etc/systemd/system/${SVC}.timer
    $SUDO systemctl daemon-reload
    ok "systemd timer 已移除"
  else
    ( $SUDO crontab -l 2>/dev/null | grep -v 'monitor.mjs' || true ) | $SUDO crontab - || true
    ok "cron 条目已移除"
  fi
  $SUDO rm -rf "$TARGET"
  ok "已删除 $TARGET"
}

case "${1:-}" in
  install)   do_install ;;
  status)    do_status ;;
  logs)      do_logs ;;
  uninstall) do_uninstall ;;
  *) echo "用法: bash deploy-vps.sh {install|status|logs|uninstall} [源目录]"; exit 2 ;;
esac
