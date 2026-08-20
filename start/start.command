#!/usr/bin/env bash
# macOS: double-click file này trong Finder là chạy (tương đương start.bat bên Windows)
cd "$(dirname "$0")/.." && exec bash start/start.sh
