#!/usr/bin/env bash
# NWW-V14 全局服务重启器
#
# 对齐 NWW-V12 的使用习惯（launchd / deploy_web.sh 的「一条命令 + 自检」），
# 但 V14 是「内核 + 网关 + 前端」三进程开发态，故用本脚本统一管理，不套 KeepAlive
# launchd（vite dev 与 ts-node-dev 自带热重载，KeepAlive 会在端口冲突时反复拉起）。
#
# 用法：
#   ./restart.sh               # = restart
#   ./restart.sh start         # 启动 kernel(8210) + server(3100) + client(5180)
#   ./restart.sh stop          # 停止上述三进程（含 pnpm/concurrently/ts-node-dev 编排根）
#   ./restart.sh restart       # 先 stop 再 start
#   ./restart.sh status        # 端口 / PID / 健康状态
#   ./restart.sh check         # 仅健康自检，不启停
#   ./restart.sh logs [name]   # 跟踪日志，name ∈ kernel|server|client（默认全部）
#
# 端口可用环境变量覆盖（与仓库默认一致：server 默认 3100；3111 是验收联调端口）：
#   NWW_KERNEL_PORT=8210  NWW_SERVER_PORT=3100  NWW_CLIENT_PORT=5180
#
# 安全边界：只处理 8210 / 3100 / 5180 与 V14 自有进程；
#           绝不触碰 V12 生产 8010 / 5173 / 8200。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="${ROOT}/.runtime"
LOGS="${RUNTIME}/logs"
PIDS="${RUNTIME}/pids"
mkdir -p "${LOGS}" "${PIDS}"

KERNEL_PORT="${NWW_KERNEL_PORT:-8210}"
SERVER_PORT="${NWW_SERVER_PORT:-3100}"
CLIENT_PORT="${NWW_CLIENT_PORT:-5180}"

# 内核 start.sh 里是裸 uvicorn：不前置 V14 自有 venv 会解析到 /opt/miniconda3/bin/uvicorn
export PATH="${ROOT}/.venv/bin:${PATH}"
export NO_PROXY="*"
export no_proxy="*"

C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s%s%s\n' "${C_OK}" "$*" "${C_OFF}"; }
bad()  { printf '%s%s%s\n' "${C_BAD}" "$*" "${C_OFF}"; }
warn() { printf '%s%s%s\n' "${C_WARN}" "$*" "${C_OFF}"; }
dim()  { printf '%s%s%s\n' "${C_DIM}" "$*" "${C_OFF}"; }

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

pids_on_port() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u
}

http_ok() { # url [timeout_sec]
  curl -fsS --max-time "${2:-3}" "$1" >/dev/null 2>&1
}

wait_http() { # url name timeout_sec
  local url="$1" name="$2" timeout="${3:-60}" i=0
  while (( i < timeout )); do
    if http_ok "${url}" 2; then
      ok "  ✓ ${name} 就绪：${url}"
      return 0
    fi
    sleep 1
    (( i++ ))
  done
  bad "  ✗ ${name} 在 ${timeout}s 内未就绪：${url}"
  return 1
}

# 收集 V14 自有进程（含编排根），仅用于 stop；绝不包含 V12 路径
v14_pids() {
  # 1) 命令里直接带 V14 绝对路径的进程
  # 2) 向上追溯最多 4 层父进程，纳入 pnpm / concurrently / node 编排根
  local seeds ancestors p cmd
  # 只认 V14 服务自身的入口/依赖路径，避免误伤引用了 V14 的 IDE / 语言服务
  seeds="$(ps -axo pid=,command= | awk -v root="${ROOT}" '
    index($0, root "/client/node_modules") ||
    index($0, root "/server/node_modules") ||
    index($0, root "/node_modules") ||
    index($0, root "/nww-kernel/web/backend") { print $1 }')"
  ancestors=""
  for p in ${seeds}; do
    cmd="${p}"
    for _ in 1 2 3 4; do
      local ppid
      ppid="$(ps -o ppid= -p "${cmd}" 2>/dev/null | tr -d ' ')"
      [[ -z "${ppid}" || "${ppid}" == "0" || "${ppid}" == "1" ]] && break
      local pcmd
      pcmd="$(ps -o command= -p "${ppid}" 2>/dev/null)"
      case "${pcmd}" in
        *pnpm*|*concurrently*|*"npm"*|*node*)
          ancestors="${ancestors} ${ppid}"
          cmd="${ppid}"
          ;;
        *) break ;;
      esac
    done
  done
  { echo "${seeds}"; echo ${ancestors}; } | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u
}

kill_pids() { # signal pids...
  local sig="$1"; shift
  local pid
  for pid in "$@"; do
    kill "-${sig}" "${pid}" 2>/dev/null || true
  done
}

# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------

# 三端口当前监听者 + V14 编排根（一次取全，避免逐个端口停时相互牵连）
stop_targets() {
  {
    pids_on_port "${CLIENT_PORT}"
    pids_on_port "${SERVER_PORT}"
    pids_on_port "${KERNEL_PORT}"
    v14_pids
  } | grep -E '^[0-9]+$' | sort -u
}

cmd_stop() {
  say ""
  say "停止 NWW-V14 服务（kernel:${KERNEL_PORT} / server:${SERVER_PORT} / client:${CLIENT_PORT}）"

  local targets
  targets="$(stop_targets)"
  if [[ -z "${targets}" ]]; then
    dim "  · 三个端口均空闲，无需停止"
    rm -f "${PIDS}"/*.pid 2>/dev/null
    return 0
  fi

  # 先停 pidfile 记录的编排根（pnpm start.sh / pnpm dev）
  local pidfile pid
  for pidfile in "${PIDS}"/*.pid; do
    [[ -f "${pidfile}" ]] || continue
    pid="$(cat "${pidfile}" 2>/dev/null || true)"
    [[ -n "${pid}" ]] && kill_pids TERM "${pid}"
  done

  dim "  · 发送 TERM：$(echo ${targets} | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill_pids TERM ${targets}

  # 等最多 5s 让 uvicorn / ts-node-dev / vite 退出
  local i=0 left
  while (( i < 5 )); do
    left="$(
      { pids_on_port "${CLIENT_PORT}"; pids_on_port "${SERVER_PORT}"; pids_on_port "${KERNEL_PORT}"; } \
        | grep -E '^[0-9]+$' | sort -u
    )"
    [[ -z "${left}" ]] && break
    sleep 1
    (( i++ ))
  done

  left="$(
    { pids_on_port "${CLIENT_PORT}"; pids_on_port "${SERVER_PORT}"; pids_on_port "${KERNEL_PORT}"; } \
      | grep -E '^[0-9]+$' | sort -u
  )"
  if [[ -n "${left}" ]]; then
    warn "  · 仍在监听，强制结束：$(echo ${left} | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill_pids KILL ${left}
    sleep 1
  fi

  rm -f "${PIDS}"/*.pid 2>/dev/null

  local rc=0 nm pt pair
  for pair in "client:${CLIENT_PORT}" "server:${SERVER_PORT}" "kernel:${KERNEL_PORT}"; do
    nm="${pair%%:*}"
    pt="${pair##*:}"
    if [[ -z "$(pids_on_port "${pt}")" ]]; then
      ok "  ✓ ${nm} 已停止（端口 ${pt} 空闲）"
    else
      bad "  ✗ ${nm} 未能停止（端口 ${pt} 仍被占用：$(pids_on_port "${pt}" | tr '\n' ' ')）"
      rc=1
    fi
  done
  return ${rc}
}

# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

ensure_shared() {
  if [[ ! -d "${ROOT}/shared/dist" ]]; then
    warn "  · shared/dist 不存在，先构建 @ai-novel/shared…"
    ( cd "${ROOT}" && pnpm --filter @ai-novel/shared build ) || {
      bad "  ✗ shared 构建失败，终止启动"
      return 1
    }
  fi
  return 0
}

spawn() { # name dir cmd...
  local name="$1" dir="$2"; shift 2
  local logfile="${LOGS}/${name}.log" pidfile="${PIDS}/${name}.pid"
  # 用 bash -c 包一层：stdin 接 /dev/null、stdout/stderr 落日志，
  # 再 disown 脱离 job table，保证本脚本立即返回、不被子进程挂住。
  nohup bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "${dir}" "$@" \
    >"${logfile}" 2>&1 </dev/null &
  local pid=$!
  echo "${pid}" >"${pidfile}"
  disown "${pid}" 2>/dev/null || true
}

cmd_start() {
  say ""
  say "启动 NWW-V14 服务（kernel:${KERNEL_PORT} / server:${SERVER_PORT} / client:${CLIENT_PORT}）"

  ensure_shared || return 1

  # 前置检查：端口是否已被占用
  local p
  for p in "${KERNEL_PORT}" "${SERVER_PORT}" "${CLIENT_PORT}"; do
    if [[ -n "$(pids_on_port "${p}")" ]]; then
      bad "  ✗ 端口 ${p} 已被占用（PID $(pids_on_port "${p}" | tr '\n' ' ')），请先执行 ./restart.sh stop"
      return 1
    fi
  done

  # 1) 内核 8210
  dim "  · 启动内核…"
  spawn kernel "${ROOT}/nww-kernel/web/backend" env PORT="${KERNEL_PORT}" HOST=127.0.0.1 bash start.sh
  wait_http "http://127.0.0.1:${KERNEL_PORT}/api/health" "kernel" 90 || {
    bad "  kernel 启动失败，日志尾部："
    tail -n 20 "${LOGS}/kernel.log" 2>/dev/null
    return 1
  }

  # 2) 网关（PORT 同时决定前端 Vite 的 /api 代理目标）
  dim "  · 启动网关…"
  spawn server "${ROOT}" env PORT="${SERVER_PORT}" pnpm --filter @ai-novel/server dev
  wait_http "http://127.0.0.1:${SERVER_PORT}/api/health" "server" 90 || {
    bad "  server 启动失败，日志尾部："
    tail -n 20 "${LOGS}/server.log" 2>/dev/null
    return 1
  }

  # 3) 前端 5180（PORT 注入给 vite 的代理 target）
  dim "  · 启动前端…"
  spawn client "${ROOT}" env PORT="${SERVER_PORT}" pnpm --filter @ai-novel/client dev
  wait_http "http://127.0.0.1:${CLIENT_PORT}/" "client" 90 || {
    bad "  client 启动失败，日志尾部："
    tail -n 20 "${LOGS}/client.log" 2>/dev/null
    return 1
  }

  say ""
  ok "全部服务已启动："
  say "  前端  http://localhost:${CLIENT_PORT}/"
  say "  网关  http://127.0.0.1:${SERVER_PORT}/api/health"
  say "  内核  http://127.0.0.1:${KERNEL_PORT}/api/health"
  say "  日志  ${LOGS}/"
}

# ---------------------------------------------------------------------------
# status / check
# ---------------------------------------------------------------------------

show_svc() { # name port url
  local name="$1" port="$2" url="$3" pids pidfile pid
  pids="$(pids_on_port "${port}")"
  pidfile="${PIDS}/${name}.pid"
  pid="$( [[ -f "${pidfile}" ]] && cat "${pidfile}" 2>/dev/null || true )"

  if [[ -z "${pids}" ]]; then
    bad "  ✗ ${name}  端口 ${port}  未运行"
    return 1
  fi
  if http_ok "${url}"; then
    ok "  ✓ ${name}  端口 ${port}  PID $(echo "${pids}" | tr '\n' ' ')  ${url}"
  else
    warn "  ! ${name}  端口 ${port}  PID $(echo "${pids}" | tr '\n' ' ')  已监听但健康检查失败"
    return 1
  fi
}

cmd_status() {
  say ""
  say "NWW-V14 状态（仓库：${ROOT}）"
  local rc=0
  show_svc kernel "${KERNEL_PORT}" "http://127.0.0.1:${KERNEL_PORT}/api/health" || rc=1
  show_svc server "${SERVER_PORT}" "http://127.0.0.1:${SERVER_PORT}/api/health" || rc=1
  show_svc client "${CLIENT_PORT}" "http://127.0.0.1:${CLIENT_PORT}/" || rc=1
  say ""
  dim "  V12 生产端口（本脚本绝不触碰）：8010=$(pids_on_port 8010 | tr '\n' ' ')  5173=$(pids_on_port 5173 | tr '\n' ' ')"
  return ${rc}
}

cmd_check() {
  say ""
  say "NWW-V14 健康自检"
  local rc=0

  if http_ok "http://127.0.0.1:${KERNEL_PORT}/api/health"; then
    ok "  ✓ kernel /api/health"
  else
    bad "  ✗ kernel /api/health"
    rc=1
  fi

  if http_ok "http://127.0.0.1:${SERVER_PORT}/api/health"; then
    ok "  ✓ server /api/health"
  else
    bad "  ✗ server /api/health"
    rc=1
  fi

  if http_ok "http://127.0.0.1:${SERVER_PORT}/api/nww/health"; then
    ok "  ✓ server /api/nww/health（桥接链路通）"
  else
    bad "  ✗ server /api/nww/health（内核不可达或桥接异常）"
    rc=1
  fi

  if http_ok "http://127.0.0.1:${CLIENT_PORT}/"; then
    ok "  ✓ client 首页"
  else
    bad "  ✗ client 首页"
    rc=1
  fi

  say ""
  if (( rc == 0 )); then
    ok "自检通过（全部服务可用）"
  else
    bad "自检未通过（见上方 ✗ 项）"
  fi
  return ${rc}
}

# ---------------------------------------------------------------------------
# logs
# ---------------------------------------------------------------------------

cmd_logs() {
  local which="${1:-all}"
  case "${which}" in
    kernel) exec tail -n 50 -f "${LOGS}/kernel.log" ;;
    server) exec tail -n 50 -f "${LOGS}/server.log" ;;
    client) exec tail -n 50 -f "${LOGS}/client.log" ;;
    all)
      tail -n 20 "${LOGS}/kernel.log" "${LOGS}/server.log" "${LOGS}/client.log" 2>/dev/null
      dim "提示：./restart.sh logs kernel|server|client 可跟踪单个服务"
      ;;
    *) bad "未知服务：${which}（可选 kernel|server|client|all）"; return 2 ;;
  esac
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

cmd="${1:-restart}"

case "${cmd}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart)
    cmd_stop || { bad "停止阶段有残留进程，已中止启动。"; exit 1; }
    cmd_start
    ;;
  status)  cmd_status ;;
  check)   cmd_check ;;
  logs)    shift || true; cmd_logs "${1:-all}" ;;
  -h|--help|help) usage ;;
  *) bad "未知子命令：${cmd}"; say ""; usage; exit 2 ;;
esac