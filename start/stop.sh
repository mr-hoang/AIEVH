#!/usr/bin/env bash
# AIEV - Mr Hoàng - dừng hệ thống (macOS / Linux)
set -u

echo "  Đang dừng AI Edit Video..."
STOPPED=false
for port in 6868 6869; do
  PIDS="$(lsof -ti tcp:$port 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
    echo "  [OK] Đã dừng process trên port $port"
    STOPPED=true
  fi
done
# Xóa dấu vết "đang chạy" - để lại thì lần chạy start sau tưởng hệ thống vẫn sống.
rm -f "$(cd "$(dirname "$0")/.." && pwd)/.aiev/run.json"

$STOPPED || echo "  Không có gì đang chạy trên port 6868/6869."
