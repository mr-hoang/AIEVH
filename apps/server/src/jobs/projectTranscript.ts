import fs from "node:fs";
import path from "node:path";
import { repoRoot, paths } from "../config.js";
import * as db from "../db.js";
import {
  listProjectAssets,
  normOutput,
  projectAssetsDirOf,
  readMeta,
} from "../meta.js";
import type { JobCtx } from "../queue.js";
import { transcribeVideo } from "../transcribe.js";
import { readProjectTranscript } from "../transcript.js";
import { HttpError } from "../util.js";

const REPO_PREFIX = path.resolve(repoRoot) + path.sep;

function safeRepoFile(rel: string | null): string | null {
  if (!rel) return null;
  const abs = path.resolve(repoRoot, rel);
  if (!abs.startsWith(REPO_PREFIX)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * Nguồn bóc lời cho project cũ, theo đúng thứ tự người dùng mong đợi:
 * final đã xuất -> draft toàn bài -> video asset lớn nhất.
 */
function sourceVideoOf(projectId: string): { abs: string; label: string } {
  const output = safeRepoFile(normOutput(readMeta(projectId).output));
  if (output) return { abs: output, label: "video final" };

  const draft = path.join(paths.outputsDir, `${projectId}-draft.mp4`);
  if (fs.existsSync(draft) && fs.statSync(draft).isFile()) {
    return { abs: draft, label: "video draft" };
  }

  const asset = listProjectAssets(projectId)
    .filter((f) => f.kind === "video")
    .sort((a, b) => b.size - a.size)[0];
  const assetAbs = asset ? safeRepoFile(asset.relPath) : null;
  if (asset && assetAbs) return { abs: assetAbs, label: `video nguồn ${asset.name}` };

  throw new HttpError(
    400,
    "NO_SOURCE_VIDEO",
    "Project chưa có video final, draft hoặc video nguồn để tạo transcript",
  );
}

/** Chỉ bóc lời; tuyệt đối không sửa scene, brief, render hay meta.output. */
export async function runProjectTranscript(ctx: JobCtx): Promise<void> {
  const projectId = ctx.job.projectId;
  const existing = readProjectTranscript(projectId);
  if (existing) {
    ctx.log(`[transcript] Đã có ${existing.relPath} - giữ nguyên, không bóc lại.`);
    db.updateJob(ctx.job.id, { outputPath: existing.relPath });
    return;
  }

  const source = sourceVideoOf(projectId);
  const outJsonAbs = path.join(projectAssetsDirOf(projectId), "transcript.json");
  ctx.progress(5, `Chuẩn bị bóc lời từ ${source.label}`);
  ctx.log(`[transcript] Nguồn: ${source.abs}`);
  ctx.log("[transcript] Không thay đổi scene, Brief hoặc video đã dựng.");

  const result = await transcribeVideo({
    videoAbs: source.abs,
    outJsonAbs,
    language: "auto",
    isCanceled: ctx.isCanceled,
    onLog: (line) => {
      ctx.log(line);
      const match = line.match(/\[whisper\]\s+([\d.]+)s\/([\d.]+)s/i);
      if (!match) return;
      const current = Number(match[1]);
      const total = Number(match[2]);
      if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
        ctx.progress(15 + (current / total) * 80, `Đang bóc lời ${Math.round((current / total) * 100)}%`);
      }
    },
  });

  db.updateJob(ctx.job.id, { outputPath: result.relPath });
  ctx.progress(98, `Đã tạo ${result.segments} đoạn transcript`);
  ctx.log(
    `[transcript] Hoàn thành: ${result.segments} đoạn, ${result.durationSec}s, ngôn ngữ ${result.language}.`,
  );
}
