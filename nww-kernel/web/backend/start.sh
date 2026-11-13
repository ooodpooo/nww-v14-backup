#!/bin/bash
# NWW-V14 内核（V12 后端能力副本）启动脚本
#
# 与 V12 生产完全隔离（2026-11-07，见 plan.md 的 C-KERNEL-START@1）：
#   端口   ：8210（V12 生产为 8010/8000，V14 旧内核为 8200）
#   书库根 ：<V14>/nww-kernel/projects（与 V12 生产书库完全分离，不共用）
#   运行态 ：<V14>/nww-kernel/runtime（模型配置、agent 任务队列均在副本内）
# 所有路径都相对 _REPO_ROOT 解析，脚本内不出现任何 V12 绝对路径。
#
# 代码热载策略（沿用 V12 语义）：默认关闭 --reload。uvicorn 的 reload 会监视
# app/ 下的 *.py，任何保存都会 terminate 后端子进程，从而中断正在运行的写作/
# 重写任务（daemon 线程随进程死）。需要开发调试时显式设置 NWW_RELOAD=1，或使用
# ./start_dev_reload.sh。

set -e

# 绕过本地代理，确保 localhost 请求直达后端
export NO_PROXY='*'
export no_proxy='*'

# 仓库根定位：start.sh 位于 <V14>/nww-kernel/web/backend/，上两级即 <V14>/nww-kernel
_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

PORT="${PORT:-8210}"
HOST="${HOST:-127.0.0.1}"

# 数据根与运行态根：锁定在 V14 内核副本内，禁止回落到 V12 生产目录
export NWW_PROJECTS_ROOT="${NWW_PROJECTS_ROOT:-$_REPO_ROOT/projects}"
export NWW_LOCAL_SINGLE_USER="${NWW_LOCAL_SINGLE_USER:-v14-local}"
export NWW_MODEL_CONFIG_FILE="${NWW_MODEL_CONFIG_FILE:-$_REPO_ROOT/runtime/config/model_config.json}"

# 必须设置的环境变量
export NWW_DEV_WEAK_SECRET="${NWW_DEV_WEAK_SECRET:-1}"
export NWW_DATA_PLANE="${NWW_DATA_PLANE:-1}"
# V14 不跑 MCP：mcp 包未纳入依赖，置 1 会在 main.py 顶层 import 失败（plan.md O-3）
export NWW_MCP_ENABLED="${NWW_MCP_ENABLED:-0}"
# 功能开关（默认开启，按需置 0 关闭）
export NWW_MODEL_CONFIG_ENABLED="${NWW_MODEL_CONFIG_ENABLED:-1}"
export NWW_MVP_ENABLED="${NWW_MVP_ENABLED:-1}"
export NWW_AGENT_ENABLED="${NWW_AGENT_ENABLED:-1}"
export NWW_AGENTS_ENABLED="${NWW_AGENTS_ENABLED:-1}"
# 流水线监督器：目标驱动自动派单 + 收件箱督促（NWW_SUPERVISOR_INTERVAL 可调 tick 秒数）
export NWW_SUPERVISOR_ENABLED="${NWW_SUPERVISOR_ENABLED:-1}"
# 整体规划硬约束（NRL）：shadow=注入节奏规划但不阻断；enforce=阻断
export NWW_NRL_MODE="${NWW_NRL_MODE:-shadow}"
# 代码热载开关：默认 0（关闭），置 1 恢复旧的热载调试行为
export NWW_RELOAD="${NWW_RELOAD:-0}"

# 质量审计器（均为 advisory，只写审计记录，不改正文/不阻断提交）：
#   NWW_TAIL_GATE=1   章尾动力类型轮换审计（防套路化/追读疲劳），零 LLM、秒级
#   NWW_CAUSAL_AUDIT=0 跨章因果审计仍是半成品（无 CLI + 硬编码示例数据），勿默认开
export NWW_TAIL_GATE="${NWW_TAIL_GATE:-1}"
export NWW_CAUSAL_AUDIT="${NWW_CAUSAL_AUDIT:-0}"

cd "$(dirname "$0")"

echo "启动 NWW-V14 内核（V12 后端能力副本）..."
echo "  地址: http://${HOST}:${PORT}"
echo "  NWW_PROJECTS_ROOT=${NWW_PROJECTS_ROOT}"
echo "  NWW_MODEL_CONFIG_FILE=${NWW_MODEL_CONFIG_FILE}"
echo "  NWW_LOCAL_SINGLE_USER=${NWW_LOCAL_SINGLE_USER}"
echo "  NWW_DATA_PLANE=${NWW_DATA_PLANE}"
echo "  NWW_MCP_ENABLED=${NWW_MCP_ENABLED}"
echo "  NO_PROXY=${NO_PROXY}"
echo "  NWW_RELOAD=${NWW_RELOAD}"

# 安全告警：NWW_LOCAL_SINGLE_USER 是 fail-open 的本地单机放行开关，只应在回环地址使用
case "$HOST" in
  127.0.0.1|localhost|::1)
    ;;
  *)
    echo "⚠️ 警告：当前为单用户放行 + 非回环监听（HOST=${HOST}），任意来源请求都会被放行为管理员；请勿在不受信任的网络中这样启动。" >&2
    ;;
esac

# 开发模式：显式开启热载，且只监视 app/ 单一目录
if [ "$NWW_RELOAD" = "1" ]; then
  echo "⚠️ 开发模式：热载已开启（监视 app/）。写作任务运行期间保存 .py 会重启后端并中断任务。"
  exec uvicorn app.main:app --host "$HOST" --port "$PORT" --reload --reload-dir app
fi

# 生产/日常模式：不启用热载
exec uvicorn app.main:app --host "$HOST" --port "$PORT"
