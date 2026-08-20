import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Router, type Request, type Response } from "express";
import { repoRoot } from "../config.js";
import { HttpError } from "../util.js";

/**
 * POST /api/reveal { relPath } → 204
 * Mở đúng file được chọn trong trình quản lý file của MÁY CHẠY SERVER
 * (Explorer/Finder). Server chạy trên máy người dùng (localhost) nên đây là
 * thao tác hợp lệ - tương đương "Reveal in Explorer" của editor.
 *
 * An toàn: chặn path traversal (đường dẫn resolve phải nằm trong repo root)
 * và CHỈ cho phép dưới whitelist thư mục như /media.
 */
const ALLOWED_TOP = new Set([
  "video-projects",
  "image-projects",
  "assets",
  "outputs",
  "imports",
]);

const router = Router();

router.post("/", (req: Request, res: Response) => {
  const relPath = (req.body as { relPath?: unknown } | undefined)?.relPath;
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new HttpError(
      400,
      "INVALID_RELPATH",
      "Thiếu relPath (chuỗi, đường dẫn tính từ repo root)",
    );
  }

  const abs = path.resolve(
    repoRoot,
    relPath.replace(/\\/g, "/").replace(/^\/+/, ""),
  );
  // Chặn traversal: sau khi resolve phải còn nằm TRONG repo root
  if (!abs.startsWith(repoRoot + path.sep)) {
    throw new HttpError(
      400,
      "INVALID_RELPATH",
      "relPath không hợp lệ (vượt ra ngoài repo)",
    );
  }
  // Whitelist thư mục gốc - đồng bộ với /media
  const top = path.relative(repoRoot, abs).split(path.sep)[0];
  if (!ALLOWED_TOP.has(top)) {
    throw new HttpError(
      403,
      "FORBIDDEN_PATH",
      "Chỉ mở được file dưới video-projects/, image-projects/, assets/, outputs/, imports/",
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new HttpError(404, "FILE_NOT_FOUND", `Không tìm thấy file: ${relPath}`);
  }
  if (!stat.isFile()) {
    throw new HttpError(404, "FILE_NOT_FOUND", `Không phải file: ${relPath}`);
  }

  let cmd: string;
  let args: string[];
  if (process.platform === "win32") {
    // Explorer cần "/select," DÍNH LIỀN đường dẫn trong cùng một argument -
    // tách "/select," và path thành 2 arg thì Explorer không select đúng file.
    cmd = "explorer.exe";
    args = [`/select,${abs}`];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = ["-R", abs];
  } else {
    // Linux: xdg-open không select được file - mở thư mục chứa
    cmd = "xdg-open";
    args = [path.dirname(abs)];
  }
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    /* thiếu lệnh trên máy - không làm rơi server, người dùng vẫn nhận 204 */
  });
  child.unref();

  res.status(204).end();
});

export default router;
