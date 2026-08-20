import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { geminiApiKey } from "./gemini.js";
import { paths } from "./config.js";
import { ensureDir, HttpError } from "./util.js";

export const OMNI_VIDEO_MODEL = "gemini-omni-flash-preview";
export type OmniVideoTask = "text_to_video" | "image_to_video" | "reference_to_video" | "edit";
export type OmniAspect = "16:9" | "9:16";

interface GenerateOmniVideoInput {
  prompt: string;
  task: OmniVideoTask;
  aspect: OmniAspect;
  sourcePath?: string | null;
  sourceMime?: string | null;
  previousInteractionId?: string | null;
}

export interface OmniVideoResult {
  id: string;
  interactionId: string | null;
  file: string;
  relPath: string;
  mediaUrl: string;
  model: string;
  task: OmniVideoTask;
  aspect: OmniAspect;
}

type JsonRecord = Record<string, unknown>;

function contentBlocks(data: JsonRecord): JsonRecord[] {
  const direct = data.output_video;
  const out: JsonRecord[] = [];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    out.push(direct as JsonRecord);
  }
  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      const content = (step as JsonRecord).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === "object" && !Array.isArray(block)) {
          const b = block as JsonRecord;
          if (b.type === "video" || b.mime_type === "video/mp4") out.push(b);
        }
      }
    }
  }
  return out;
}

function googleError(status: number, raw: string): HttpError {
  let message = raw.replace(/\s+/g, " ").slice(0, 1000);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Giữ body thô đã rút gọn.
  }
  return new HttpError(status, "GEMINI_OMNI_ERROR", `Gemini Omni: ${message || `HTTP ${status}`}`);
}

async function uploadVideoFile(
  filePath: string,
  mime: string,
  key: string,
): Promise<{ name: string; uri: string }> {
  const size = fs.statSync(filePath).size;
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: path.basename(filePath) } }),
  });
  if (!start.ok) throw googleError(start.status, await start.text());
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new HttpError(502, "UPLOAD_URL_MISSING", "Gemini không trả upload URL");

  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: fs.readFileSync(filePath),
  });
  const raw = await upload.text();
  if (!upload.ok) throw googleError(upload.status, raw);
  const data = JSON.parse(raw) as { file?: { name?: string; uri?: string; state?: string } };
  const name = data.file?.name;
  const uri = data.file?.uri;
  if (!name || !uri) throw new HttpError(502, "UPLOADED_FILE_MISSING", "Gemini không trả file URI");

  const deadline = Date.now() + 8 * 60_000;
  let state = data.file?.state;
  while (state === "PROCESSING" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const statusRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(key)}`,
    );
    if (!statusRes.ok) throw googleError(statusRes.status, await statusRes.text());
    const status = (await statusRes.json()) as { state?: string };
    state = status.state;
  }
  if (state === "FAILED") throw new HttpError(502, "SOURCE_PROCESSING_FAILED", "Gemini không xử lý được video nguồn");
  if (state === "PROCESSING") throw new HttpError(504, "SOURCE_PROCESSING_TIMEOUT", "Gemini xử lý video nguồn quá 8 phút");
  return { name, uri };
}

async function deleteGoogleFile(name: string, key: string): Promise<void> {
  try {
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
  } catch {
    // File tự hết hạn sau 48 giờ; cleanup không được làm hỏng kết quả chính.
  }
}

async function downloadUriVideo(uri: string, key: string): Promise<Buffer> {
  const match = uri.match(/files\/([A-Za-z0-9._-]+)/);
  if (!match) throw new HttpError(502, "INVALID_VIDEO_URI", "Gemini trả URI video không hợp lệ");
  const name = `files/${match[1]}`;
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const statusRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(key)}`,
    );
    if (!statusRes.ok) throw googleError(statusRes.status, await statusRes.text());
    const status = (await statusRes.json()) as { state?: string | { name?: string } };
    const state = typeof status.state === "string" ? status.state : status.state?.name;
    if (state === "ACTIVE") break;
    if (state === "FAILED") {
      throw new HttpError(502, "VIDEO_GENERATION_FAILED", "Gemini Omni xử lý video thất bại");
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (Date.now() >= deadline) {
    throw new HttpError(504, "VIDEO_GENERATION_TIMEOUT", "Gemini Omni xử lý video quá 8 phút");
  }
  const download = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${name}:download?alt=media&key=${encodeURIComponent(key)}`,
  );
  if (!download.ok) throw googleError(download.status, await download.text());
  return Buffer.from(await download.arrayBuffer());
}

export async function generateOmniVideo(input: GenerateOmniVideoInput): Promise<OmniVideoResult> {
  const key = geminiApiKey();
  if (!key) {
    throw new HttpError(400, "GEMINI_KEY_REQUIRED", "Cần GEMINI_API_KEY ở trang Kết nối");
  }
  const prompt = input.prompt.trim();
  if (!prompt) throw new HttpError(400, "PROMPT_REQUIRED", "Prompt không được để trống");

  let apiInput: unknown = prompt;
  let uploadedSourceName: string | null = null;
  if (input.sourcePath) {
    const mime = input.sourceMime || "application/octet-stream";
    if (mime.startsWith("video/")) {
      // Video 1 phút thường vượt giới hạn body inline; Files API hỗ trợ tới
      // 2GB. Route giới hạn 250MB để giữ mức RAM/ổ đĩa hợp lý cho app local.
      const uploaded = await uploadVideoFile(input.sourcePath, mime, key);
      uploadedSourceName = uploaded.name;
      apiInput = [
        { type: "document", uri: uploaded.uri },
        { type: "text", text: prompt },
      ];
    } else {
      const source = fs.readFileSync(input.sourcePath);
      if (source.byteLength > 25 * 1024 * 1024) {
        throw new HttpError(413, "SOURCE_TOO_LARGE", "Ảnh nguồn tối đa 25MB");
      }
      apiInput = [
        { type: "image", mime_type: mime, data: source.toString("base64") },
        { type: "text", text: prompt },
      ];
    }
  }

  const body: JsonRecord = {
    model: OMNI_VIDEO_MODEL,
    input: apiInput,
    response_format: { type: "video", aspect_ratio: input.aspect, delivery: "uri" },
    generation_config: { video_config: { task: input.task } },
  };
  if (input.previousInteractionId) body.previous_interaction_id = input.previousInteractionId;

  let data: JsonRecord;
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw googleError(response.status, raw);
    data = JSON.parse(raw) as JsonRecord;
  } finally {
    if (uploadedSourceName) await deleteGoogleFile(uploadedSourceName, key);
  }
  const blocks = contentBlocks(data);
  const block = blocks.find((b) => typeof b.data === "string" || typeof b.uri === "string");
  if (!block) {
    throw new HttpError(502, "VIDEO_MISSING", "Gemini Omni không trả về video");
  }

  const bytes =
    typeof block.data === "string"
      ? Buffer.from(block.data, "base64")
      : await downloadUriVideo(String(block.uri), key);
  if (bytes.byteLength < 1024) {
    throw new HttpError(502, "VIDEO_INVALID", "Video Gemini trả về không hợp lệ");
  }

  ensureDir(paths.outputsDir);
  const id = `omni-${Date.now()}-${nanoid(6)}`;
  const file = `${id}.mp4`;
  fs.writeFileSync(path.join(paths.outputsDir, file), bytes);
  return {
    id,
    interactionId: typeof data.id === "string" ? data.id : null,
    file,
    relPath: `outputs/${file}`,
    mediaUrl: `/media/outputs/${encodeURIComponent(file)}`,
    model: OMNI_VIDEO_MODEL,
    task: input.task,
    aspect: input.aspect,
  };
}
