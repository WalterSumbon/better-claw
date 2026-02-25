#!/bin/bash
# Better-Claw 启动脚本（带自动重启）。
# 进程退出后自动重新拉起，配合 /restart 命令和 restart MCP tool 使用。

cd "$(dirname "$0")"

while true; do
  echo "[$(date)] Starting Better-Claw..."
  npx tsx src/index.ts
  EXIT_CODE=$?
  echo "[$(date)] Process exited with code $EXIT_CODE, restarting in 2s..."
  sleep 2
done
