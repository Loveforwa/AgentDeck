#!/usr/bin/env bash
# F7 tmux 试验入口。只用 AgentDeck 自己的实例（tmux -L agentdeck），不碰默认的 tmux 服务。
#
#   trial.sh start <id> [--cwd DIR] -- <命令...>   用 tmux.conf 起一个会话（设 AGENTDECK_TERM=<id>）
#   trial.sh attach <id>                           在当前终端里 attach（给人工检查用；没有前缀键，
#                                                  在另一个终端执行 trial.sh detach <id> 断开）
#   trial.sh detach <id>                           断开这个会话的所有客户端
#   trial.sh timing [--n 20] [--session ID --marker TEXT]
#                                                  量 attach 到首屏、detach 的时间（中位数）
#   trial.sh keys                                  按键、粘贴、鼠标、焦点、颜色透传（探针）
#   trial.sh commands                              capture-pane / pipe-pane / display-message /
#                                                  list-sessions / 钩子 / 退出码
#   trial.sh agent claude|codex                    真实 agent：直接跑和经过 tmux 对比
#   trial.sh all                                   keys、commands、timing、两个 agent，然后 cleanup
#   trial.sh cleanup                               tmux -L agentdeck kill-server
#
# node 依赖（node-pty、@xterm/headless）装在 $AGENTDECK_TRIAL_DEPS，
# 默认 ~/.cache/agentdeck/trial-deps，不进仓库。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
CONF="$PKG/tmux.conf"
TMUX_BIN="${AGENTDECK_TMUX:-tmux}"
export AGENTDECK_TMUX_CONF="$CONF"
export AGENTDECK_TRIAL_DEPS="${AGENTDECK_TRIAL_DEPS:-${XDG_CACHE_HOME:-$HOME/.cache}/agentdeck/trial-deps}"

# 干净环境：tmux 服务的全局环境取自第一次启动它的进程，不能把调用者的环境带进去。
clean_env() {
  env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/sh}" \
    PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" LANG="${AGENTDECK_TRIAL_LANG:-en_US.UTF-8}" \
    "$@"
}

t() { clean_env "$TMUX_BIN" -L agentdeck -f "$CONF" "$@"; }

check_tmux() {
  local v
  v="$("$TMUX_BIN" -V | awk '{print $2}')"
  # 最低 3.5（见 AGENTS.md）。按 主.次 比较，忽略 a/b 后缀。
  local major="${v%%.*}" minor="${v#*.}"
  minor="${minor%%[!0-9]*}"
  if (( major < 3 || (major == 3 && minor < 5) )); then
    echo "tmux $v is too old; AgentDeck needs tmux >= 3.5" >&2
    exit 1
  fi
}

ensure_deps() {
  if [[ ! -d "$AGENTDECK_TRIAL_DEPS/node_modules/node-pty" || ! -d "$AGENTDECK_TRIAL_DEPS/node_modules/@xterm/headless" ]]; then
    echo "installing node-pty and @xterm/headless into $AGENTDECK_TRIAL_DEPS" >&2
    mkdir -p "$AGENTDECK_TRIAL_DEPS"
    (cd "$AGENTDECK_TRIAL_DEPS" && { [[ -f package.json ]] || echo '{"private":true}' > package.json; } \
      && npm install --no-audit --no-fund node-pty@1.1.0 @xterm/headless@6.0.0 >&2)
  fi
  # node-pty 1.1.0 的预编译包里 spawn-helper 没有执行权限，不改会报 posix_spawnp failed。
  chmod +x "$AGENTDECK_TRIAL_DEPS"/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
}

cmd_start() {
  local id="$1"; shift
  local cwd="$PWD"
  if [[ "${1:-}" == "--cwd" ]]; then cwd="$2"; shift 2; fi
  [[ "${1:-}" == "--" ]] && shift
  t new-session -d -s "$id" -x 120 -y 32 -c "$cwd" -e "AGENTDECK_TERM=$id" -- "$@"
  echo "started $id: $(t display-message -p -t "=$id:" '#{pane_pid} #{pane_current_command} #{pane_current_path}')"
}

case "${1:-}" in
  start) shift; check_tmux; cmd_start "$@" ;;
  # 人工检查用：不加 -T，让 tmux 自己认出你用的终端（iTerm2、Ghostty 会被认成支持真彩色）。
  attach) check_tmux; exec "$TMUX_BIN" -L agentdeck -f "$CONF" -u attach-session -t "=$2" ;;
  detach) t detach-client -s "=$2" ;;
  timing) shift; check_tmux; ensure_deps; node "$HERE/timing.mjs" "$@" ;;
  keys) shift; check_tmux; ensure_deps; node "$HERE/keys.mjs" "$@" ;;
  commands) shift; check_tmux; ensure_deps; node "$HERE/commands.mjs" "$@" ;;
  agent) shift; check_tmux; ensure_deps; node "$HERE/agent.mjs" "$@" ;;
  all)
    check_tmux; ensure_deps
    node "$HERE/keys.mjs"
    node "$HERE/commands.mjs"
    node "$HERE/timing.mjs"
    node "$HERE/agent.mjs" claude
    node "$HERE/agent.mjs" codex
    t kill-server 2>/dev/null || true
    ;;
  cleanup) t kill-server 2>/dev/null || true ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
