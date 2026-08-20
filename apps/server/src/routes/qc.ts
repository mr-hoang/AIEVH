import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { paths, repoRoot } from "../config.js";
import { normOutput, projectDirOf, projectExists, readMeta } from "../meta.js";
import {
  isQcReportStale,
  readQcReport,
  runQc,
  writeQcReport,
  type QcReport,
} from "../qc.js";
import { HttpError } from "../util.js";

/**
 * QC tự động (đo bằng ffmpeg) trên bản draft trước khi cho render final.
 * Mount dưới prefix /api/projects (xem index.ts) - đường dẫn thật: /api/projects/:id/qc
 *
 * Chạy ĐỒNG BỘ như /thumbnail: một lượt đo mất vài chục giây tới ~2 phút tùy
 * độ dài video, ngắn hơn nhiều so với một job render nên không cần đẩy vào queue.
 */
const router = Router();

/** Video .mp4 mới nhất trong video-projects/<id>/renders/ (không có thì null) */
function newestRenderMp4(projectId: string): string | null {
  const dir = path.join(projectDirOf(projectId), "renders");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { abs: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isFile() || path.extname(e.name).toLowerCase() !== ".mp4") continue;
    const abs = path.join(dir, e.name);
    try {
      const m = fs.statSync(abs).mtimeMs;
      if (!best || m > best.mtime) best = { abs, mtime: m };
    } catch {
      /* file biến mất giữa chừng - bỏ qua */
    }
  }
  return best ? best.abs : null;
}

/**
 * Đường dẫn do client đưa vào -> tuyệt đối, BẮT BUỘC nằm trong repo.
 * Chặn path traversal (../../Windows/...) và đường dẫn tuyệt đối ổ khác.
 */
function resolveInRepo(rel: string): string {
  const abs = path.resolve(repoRoot, rel);
  if (abs !== repoRoot && !abs.startsWith(path.resolve(repoRoot) + path.sep)) {
    throw new HttpError(400, "PATH_OUTSIDE_REPO", `Đường dẫn "${rel}" nằm ngoài repo`);
  }
  return abs;
}

/**
 * Chọn file để QC khi client không chỉ định:
 * 1) outputs/<id>-draft.mp4 - bản draft chuẩn của pipeline
 * 2) .mp4 mới nhất trong video-projects/<id>/renders/ - draft đang thử
 * 3) normOutput(meta.output) - đã có final thì QC luôn final
 */
function pickDefaultFile(projectId: string): string | null {
  const draft = path.join(paths.outputsDir, `${projectId}-draft.mp4`);
  if (fs.existsSync(draft)) return draft;
  const render = newestRenderMp4(projectId);
  if (render) return render;
  const output = normOutput(readMeta(projectId).output);
  if (output) {
    const abs = path.resolve(repoRoot, output);
    if (abs.startsWith(path.resolve(repoRoot) + path.sep) && fs.existsSync(abs)) return abs;
  }
  return null;
}

// POST /api/projects/:id/qc - { file?: relPath từ repo root, platform? }
// → 200 { report }
router.post("/:id/qc", async (req, res) => {
  const id = req.params.id;
  if (!projectExists(id)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy project "${id}"`);
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  if ("file" in body && body.file !== undefined && typeof body.file !== "string") {
    throw new HttpError(400, "INVALID_FILE", "file phải là chuỗi đường dẫn tính từ repo root");
  }
  if ("platform" in body && body.platform !== undefined && typeof body.platform !== "string") {
    throw new HttpError(400, "INVALID_PLATFORM", "platform phải là chuỗi");
  }
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";

  let fileAbs: string | null;
  const rel = typeof body.file === "string" ? body.file.trim() : "";
  if (rel) {
    fileAbs = resolveInRepo(rel);
    if (!fs.existsSync(fileAbs)) {
      throw new HttpError(404, "FILE_NOT_FOUND", `Không thấy file "${rel}"`);
    }
  } else {
    fileAbs = pickDefaultFile(id);
  }
  if (!fileAbs) {
    throw new HttpError(400, "NO_VIDEO", "Chưa có video để QC - render draft trước");
  }

  // Timeout mềm cho cả lượt đo: mỗi lệnh ffmpeg đã có trần 120s riêng, nhưng
  // video rất dài + nhiều check có thể cộng dồn. 10 phút là trần an toàn để
  // request không treo vô hạn (tiến trình con tự chết theo timeout của nó).
  const report = await Promise.race([
    runQc({ projectId: id, fileAbs, platform }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new HttpError(504, "QC_TIMEOUT", "QC chạy quá 10 phút - đã dừng")),
        600_000,
      ).unref(),
    ),
  ]);
  writeQcReport(id, report);
  res.json({ report });
});

// GET /api/projects/:id/qc → { report } | { report: null }
// Kèm stale: true khi file đã render lại sau lần QC gần nhất.
router.get("/:id/qc", (req, res) => {
  const id = req.params.id;
  if (!projectExists(id)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy project "${id}"`);
  }
  const report: QcReport | null = readQcReport(id);
  if (!report) {
    res.json({ report: null });
    return;
  }
  const stale = isQcReportStale(report);
  res.json(stale ? { report, stale: true } : { report });
});

export default router;
