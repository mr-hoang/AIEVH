import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { hasCodexCli, hasCodexSubscription, paths, repoRoot } from "../config.js";
import { generateBackground } from "../gemini.js";
import { generateSubscriptionImage } from "../subscriptionImage.js";
import {
  briefOf,
  listProjectAssets,
  normOutput,
  projectDirOf,
  projectExists,
  readMeta,
  writeMeta,
} from "../meta.js";
import { remotionGlArgs } from "../renderSettings.js";
import { getStyle, styleExists } from "../styles.js";
import { HttpError, ensureDir, execFileCapture, remotionCli } from "../util.js";
import type { ImageAspect } from "../imageMeta.js";

/**
 * Tạo THUMBNAIL cho video project - chạy ĐỒNG BỘ (~1 phút), pipeline:
 * 1) ffmpeg cắt một frame từ video (mặc định output final của meta,
 *    fallback video asset đầu tiên) tại giây `frameAt`
 * 2) Codex hoặc Antigravity Subscription vẽ nền theo Style Design; API key
 *    chỉ được gọi dự phòng
 * 3) stage nền + frame + logo + font bằng hardlink → props.json →
 *    `npx remotion still Thumbnail` → video-projects/<id>/thumbnail.png
 * Style resolve: body.styleId → brief.styleId → default (như /api/illustrations).
 * Đăng ký trong index.ts dưới prefix /api/projects (sau projectsRouter).
 */

const router = Router();

async function generateOpenAiBackground(input: {
  prompt: string;
  aspect: ImageAspect;
  outFile: string;
}): Promise<void> {
  const prompt = `${input.prompt}. Create in ${input.aspect} aspect ratio. Clean video thumbnail background, no text, no logo, strong subject separation.`;
  let subscriptionError: string | null = null;
  if (hasCodexSubscription() && hasCodexCli()) {
    try {
      await generateSubscriptionImage({
        provider: "openai",
        prompt,
        outFile: input.outFile,
      });
      return;
    } catch (err) {
      subscriptionError = err instanceof Error ? err.message : String(err);
    }
  }
  const key = (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || "").trim();
  if (!key) {
    throw new HttpError(
      400,
      "OPENAI_CONNECTION_REQUIRED",
      subscriptionError
        ? `ChatGPT Subscription không tạo được ảnh: ${subscriptionError}. Không có OPENAI_API_KEY dự phòng.`
        : "Chưa có phiên ChatGPT Subscription dùng được qua Codex CLI và chưa có OPENAI_API_KEY dự phòng.",
    );
  }
  const size = input.aspect === "9:16" ? "1024x1536" : "1536x1024";
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      size,
      quality: "medium",
      output_format: "png",
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await response.json()) as { data?: Array<{ b64_json?: string }>; error?: { message?: string } };
  if (!response.ok || !json.data?.[0]?.b64_json) {
    throw new HttpError(response.status || 502, "OPENAI_IMAGE_FAILED", json.error?.message || "OpenAI không trả về ảnh thumbnail");
  }
  fs.writeFileSync(input.outFile, Buffer.from(json.data[0].b64_json, "base64"));
}

// POST /api/projects/:id/thumbnail
// { title, frameAt?: number (giây, default 1), sourceRel?, bgPrompt?, styleId? }
// → 201 { file: "thumbnail.png", relPath }
router.post("/:id/thumbnail", async (req, res) => {
  const id = req.params.id;
  if (!projectExists(id)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy video project "${id}"`);
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    throw new HttpError(400, "TITLE_REQUIRED", "Thiếu title cho thumbnail");
  }
  const frameAt =
    typeof body.frameAt === "number" && Number.isFinite(body.frameAt) && body.frameAt >= 0
      ? body.frameAt
      : 1;
  const bgPrompt = typeof body.bgPrompt === "string" ? body.bgPrompt.trim() : "";
  const imageProvider = body.imageProvider === "openai" ? "openai" : "gemini";
  if ("styleId" in body && body.styleId !== null && typeof body.styleId !== "string") {
    throw new HttpError(400, "INVALID_STYLE_ID", "styleId phải là string hoặc null");
  }
  const styleId = typeof body.styleId === "string" ? body.styleId.trim() : "";
  if (styleId && !styleExists(styleId)) {
    throw new HttpError(404, "STYLE_NOT_FOUND", `Không tìm thấy style "${styleId}"`);
  }

  const meta = readMeta(id);
  const projectDir = projectDirOf(id);

  // Đường dẫn do người dùng/agent cung cấp - chặn thoát khỏi repo
  const resolveInRepo = (rel: string, what: string): string => {
    const abs = path.resolve(repoRoot, rel);
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) {
      throw new HttpError(400, "PATH_OUTSIDE_REPO", `${what} "${rel}" nằm ngoài repo`);
    }
    return abs;
  };

  // ---- Video nguồn để cắt frame: sourceRel → output final → video asset đầu
  let videoAbs: string | null = null;
  const sourceRel = typeof body.sourceRel === "string" ? body.sourceRel.trim() : "";
  if (sourceRel) {
    const abs = resolveInRepo(sourceRel, "sourceRel");
    if (!fs.existsSync(abs)) {
      throw new HttpError(404, "SOURCE_NOT_FOUND", `Không thấy video nguồn "${sourceRel}"`);
    }
    videoAbs = abs;
  } else {
    const output = normOutput(meta.output);
    if (output) {
      const abs = resolveInRepo(output, "output");
      if (fs.existsSync(abs)) videoAbs = abs;
    }
    if (!videoAbs) {
      const firstVideo = listProjectAssets(id).find((f) => f.kind === "video");
      if (firstVideo) videoAbs = path.join(repoRoot, firstVideo.relPath);
    }
  }
  if (!videoAbs) {
    throw new HttpError(
      400,
      "NO_SOURCE_VIDEO",
      "Project chưa có video để cắt frame (chưa có output final lẫn video asset) - truyền sourceRel hoặc render final trước",
    );
  }

  // ---- 1) ffmpeg cắt frame ------------------------------------------------
  const rendersDir = path.join(projectDir, "renders");
  ensureDir(rendersDir);
  const frameAbs = path.join(rendersDir, "thumb-frame.png");
  try {
    await execFileCapture(
      "ffmpeg",
      ["-y", "-ss", String(frameAt), "-i", videoAbs, "-frames:v", "1", "-q:v", "2", frameAbs],
      { timeoutMs: 60_000 },
    );
  } catch (err) {
    throw new HttpError(
      500,
      "FRAME_FAILED",
      `ffmpeg không cắt được frame tại giây ${frameAt}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!fs.existsSync(frameAbs)) {
    throw new HttpError(
      500,
      "FRAME_FAILED",
      `ffmpeg chạy xong nhưng không có frame - frameAt=${frameAt}s có thể vượt quá thời lượng video`,
    );
  }

  // ---- 2) Model được chọn vẽ nền theo Style Design
  const design = getStyle(styleId || briefOf(meta).styleId || null);
  const aspect: ImageAspect = meta.height >= meta.width ? "9:16" : "16:9";
  const bgAbs = path.join(rendersDir, "thumb-bg.png");
  let hasBg = false;
  try {
    if (imageProvider === "openai") {
      await generateOpenAiBackground({
        prompt: bgPrompt || `Background for a video thumbnail about: ${title}`,
        aspect,
        outFile: bgAbs,
      });
      hasBg = true;
    } else {
      await generateBackground({
        prompt: bgPrompt || `background for a video thumbnail about: ${title}`,
        kind: "concept",
        aspect,
        design,
        allowText: false,
        outFile: bgAbs,
        usageProjectId: id,
      });
      hasBg = true;
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "THUMBNAIL_AI_FAILED", `${imageProvider === "openai" ? "OpenAI" : "Gemini"} tạo nền thất bại: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- 3) Stage bằng hardlink (như imageGen) + props + remotion still ------
  const stagingId = `thumb-${id}`;
  const stagingAbs = path.join(paths.stagingDir, stagingId);
  fs.rmSync(stagingAbs, { recursive: true, force: true });
  ensureDir(stagingAbs);

  // prefix theo vai trò để file trùng basename không đè nhau
  const stage = (srcAbs: string, prefix: string): string => {
    const resolved = path.resolve(srcAbs);
    if (!resolved.startsWith(path.resolve(repoRoot) + path.sep)) {
      throw new HttpError(400, "PATH_OUTSIDE_REPO", `Đường dẫn "${srcAbs}" nằm ngoài repo - từ chối stage`);
    }
    const name = prefix + path.basename(srcAbs);
    const dstAbs = path.join(stagingAbs, name);
    try {
      fs.linkSync(resolved, dstAbs); // hardlink - không tốn dung lượng
    } catch {
      fs.copyFileSync(resolved, dstAbs); // fallback (khác ổ đĩa / FS không hỗ trợ)
    }
    return `staging/${stagingId}/${name}`;
  };

  const stageOptional = (rel: string | null, prefix: string): string | null => {
    if (!rel) return null;
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) return null;
    return stage(abs, prefix);
  };

  const props = {
    aspect,
    background: hasBg ? stage(bgAbs, "bg-") : null,
    frame: stage(frameAbs, "frame-"),
    title,
    design: {
      colors: design.colors,
      fonts: design.fonts,
      fontFiles: {
        heading: stageOptional(design.fontFiles.heading, "font-h-"),
        body: stageOptional(design.fontFiles.body, "font-b-"),
      },
      effects: design.effects,
      logoFile: stageOptional(design.logoPath, "logo-"),
      brandName: design.name,
    },
  };
  const propsAbs = path.join(rendersDir, "thumb-props.json");
  fs.writeFileSync(propsAbs, JSON.stringify(props, null, 2) + "\n", "utf8");

  const outAbs = path.join(projectDir, "thumbnail.png");
  try {
    await execFileCapture(
      process.execPath,
      [
        remotionCli(),
        "still",
        "Thumbnail",
        `--props=${propsAbs}`,
        `--output=${outAbs}`,
        ...remotionGlArgs(),
      ],
      { cwd: paths.remotionDir, timeoutMs: 300_000 },
    );
  } catch (err) {
    throw new HttpError(
      500,
      "STILL_FAILED",
      `Remotion still Thumbnail thất bại: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!fs.existsSync(outAbs)) {
    throw new HttpError(500, "STILL_FAILED", "Remotion still xong nhưng không thấy thumbnail.png");
  }
  // Staging chỉ cần trong lúc still - dọn luôn, không tích rác
  fs.rmSync(stagingAbs, { recursive: true, force: true });

  // Chạm updatedAt (writeMeta tự set) để web bust cache thumbnail ?v=updatedAt -
  // không chạm là browser giữ ảnh cũ. Đọc lại meta vì job khác có thể đã ghi trong lúc render.
  writeMeta(id, readMeta(id));

  res.status(201).json({
    file: "thumbnail.png",
    relPath: `video-projects/${id}/thumbnail.png`,
  });
});

export default router;
