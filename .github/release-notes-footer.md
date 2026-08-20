## How to run

**Windows** - double-click `start\start.bat`
**macOS** - double-click `start/start.command` in Finder. `.sh` files CANNOT be double-clicked on macOS, they only open in an editor. If macOS blocks it as an "unidentified developer" the first time, right-click the file → **Open** → **Open**.
**Linux** - run `./start/start.sh` in a terminal

If you downloaded the ZIP instead of cloning, grant the scripts permission to run, once:

```bash
chmod +x start/*.sh start/*.command update/*.sh update/*.command
```

| Task | Windows | macOS | Linux |
|---|---|---|---|
| Start | `start\start.bat` | `start/start.command` | `./start/start.sh` |
| Stop | `start\stop.bat` | `start/stop.command` | `./start/stop.sh` |
| Update manually | `update\update.bat` | `update/update.command` | `bash update/update.sh` |
| Open a tunnel (upload from your phone over 4G/5G) | `start\tunnel.bat` | `start/tunnel.command` | `./start/tunnel.sh` |

You normally never run the update script by hand: the update button on the dashboard does it for you.

> **The ZIP download cannot update itself.** Updating runs on git, and the source ZIP has no `.git` folder, so the dashboard's update button will report a failed check. Moving to a newer version means downloading a fresh ZIP and copying your own data across: `apps/server/data/` (the database), `video-projects/`, `assets/` and `.env`. If you plan to keep the project, `git clone` instead - then updating is one button, and the updater backs your data up before it pulls.

On the first run the script checks your environment, installs what it can, installs dependencies, builds, then opens `http://localhost:6868`.

**Requirements:** Node.js 22+, FFmpeg on PATH, Google Chrome. You need to be signed in to Claude Code on the machine, or have an `ANTHROPIC_API_KEY`; image generation additionally needs a `GEMINI_API_KEY`.

Full documentation: [English README](https://github.com/mr-hoang/AIEVH/blob/main/README.md) · [README tiếng Việt](https://github.com/mr-hoang/AIEVH/blob/main/README.vi.md)

### Hướng dẫn chạy (tiếng Việt)

Windows: nhấp đúp `start\start.bat`. macOS: nhấp đúp `start/start.command` trong Finder (file `.sh` không nhấp đúp được trên macOS; lần đầu macOS chặn "unidentified developer" thì chuột phải vào file → Open → Open). Linux: chạy `./start/start.sh`.

Tải bản ZIP thay vì `git clone` thì lần đầu cần chạy `chmod +x start/*.sh start/*.command update/*.sh update/*.command`.

Dừng bằng `start\stop.bat` / `start/stop.command` / `./start/stop.sh`. Cập nhật thủ công bằng `update\update.bat` / `update/update.command` / `bash update/update.sh`, nhưng bình thường chỉ cần bấm nút cập nhật trên dashboard. **Bản ZIP không tự cập nhật được** (không có thư mục `.git`) - dùng lâu dài thì nên `git clone`.

Yêu cầu: Node.js 22+, FFmpeg trên PATH, Google Chrome. Có thể đăng nhập OpenAI, Claude hoặc Gemini CLI; API key là dự phòng. Hướng dẫn đầy đủ: [README tiếng Việt](https://github.com/mr-hoang/AIEVH/blob/main/README.vi.md).
