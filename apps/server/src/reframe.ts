import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AutoCutBackground } from "./autoCutMeta.js";
import { detectHardware, readRenderSettings } from "./renderSettings.js";
import { audioCutFade, execFileCaptureAll } from "./util.js";

/** `-af <fade>` cho đoạn dài `durationSec`, hoặc [] nếu đoạn ngắn quá để fade. */
function audioFadeArgs(durationSec: number): string[] {
  const fade = audioCutFade(durationSec);
  return fade ? ["-af", fade] : [];
}

/**
 * Cắt đoạn + ĐỔI KHUNG HÌNH (reframe) - lõi kỹ thuật của "Auto cut videos".
 *
 * Ba việc tách bạch:
 *  1. `probeVideo`     - đọc kích thước THẬT (đã áp cờ xoay) + fps + thời lượng.
 *  2. `detectSubject` / `classifyFrame` - hỏi Gemini vision xem chủ thể nằm đâu,
 *     khung này là người hay là màn hình/chữ.
 *  3. `buildReframeArgs` / `runCutReframe` - dựng và chạy lệnh ffmpeg cắt + reframe.
 *
 * VÌ SAO tách khỏi job: job chỉ điều phối (đọc meta, ghi tiến độ, tạo project con),
 * còn toàn bộ tri thức về ffmpeg/vision nằm ở đây - test riêng được bằng file thật.
 */

// ------------------------------------------------------------------ Probe

export interface VideoProbe {
  /** Kích thước SAU KHI áp cờ xoay - dùng cho MỌI phép tính tỉ lệ/cắt cúp */
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Góc xoay từ side-data (đơn vị độ, thường 0 / ±90 / 180) */
  rotation: number;
  hasAudio: boolean;
}

interface FfprobeJson {
  streams?: Array<{
    index?: number;
    codec_type?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    tags?: Record<string, string>;
    side_data_list?: Array<Record<string, unknown>>;
  }>;
  format?: { duration?: string };
}

/** "30000/1001" -> 29.97; số thường -> chính nó; hỏng -> 0 */
function parseRate(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (m) {
    const den = Number(m[2]);
    return den > 0 ? Number(m[1]) / den : 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Đọc thông số video bằng ffprobe.
 *
 * ⚠ BẰNG CHỨNG ĐÃ KIỂM CHỨNG BẰNG FILE THẬT TRONG REPO:
 * `video-projects/dd/assets/20260731-164133.mp4` được ffprobe báo
 * `width=3840 height=2160` (tưởng là video NGANG) nhưng stream có
 * `side_data_list[0].rotation = -90`, và khung GIẢI MÃ RA thực tế là 2160x3840
 * (video DỌC quay bằng điện thoại). ffmpeg bật autorotate mặc định nên filter
 * graph nhìn thấy khung ĐÃ XOAY.
 * => Nếu dùng thẳng số thô của ffprobe thì mọi video quay bằng điện thoại sẽ bị
 * hiểu nhầm là video ngang và reframe sai hoàn toàn (crop nhầm trục, fit nhầm nền).
 * Vì vậy: |rotation| = 90 hoặc 270 thì HOÁN ĐỔI width/height trước khi trả về.
 */
export async function probeVideo(fileAbs: string): Promise<VideoProbe> {
  const { code, stdout, stderr } = await execFileCaptureAll(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      // Gộp một lệnh: stream (kích thước, fps) + side_data (rotation) + tags (rotate cũ) + duration
      "stream=index,codec_type,width,height,r_frame_rate:stream_side_data=rotation:stream_tags=rotate:format=duration",
      "-of",
      "json",
      fileAbs,
    ],
    { timeoutMs: 30_000 },
  );
  if (code !== 0) {
    throw new Error(
      `ffprobe không đọc được "${path.basename(fileAbs)}": ${stderr.trim().slice(0, 300) || `mã ${code}`}`,
    );
  }

  let data: FfprobeJson;
  try {
    data = JSON.parse(stdout) as FfprobeJson;
  } catch {
    throw new Error(`ffprobe trả về JSON hỏng cho "${path.basename(fileAbs)}"`);
  }

  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) {
    throw new Error(`File "${path.basename(fileAbs)}" không có luồng video đọc được`);
  }

  // rotation lấy từ side-data (ffmpeg mới) hoặc tag `rotate` (mp4 cũ)
  let rotation = 0;
  for (const sd of video.side_data_list ?? []) {
    const r = Number((sd as { rotation?: unknown }).rotation);
    if (Number.isFinite(r) && r !== 0) rotation = r;
  }
  if (rotation === 0) {
    const tagRotate = Number(video.tags?.rotate);
    if (Number.isFinite(tagRotate) && tagRotate !== 0) rotation = tagRotate;
  }

  const swap = Math.abs(rotation) % 180 === 90;
  const rawW = Math.round(video.width);
  const rawH = Math.round(video.height);

  return {
    width: swap ? rawH : rawW,
    height: swap ? rawW : rawH,
    fps: parseRate(video.r_frame_rate) || 30,
    durationSec: Number(data.format?.duration) || 0,
    rotation,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

// ------------------------------------------------------------------ Gemini vision

const GEMINI_VISION_MODEL = "gemini-2.5-flash";
const GEMINI_VISION_URL = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_VISION_MODEL}:generateContent`;

export interface SubjectCenter {
  found: boolean;
  /** Toạ độ tâm chủ thể, chuẩn hoá 0-1 theo khung ĐÃ áp cờ xoay */
  centerX: number;
  centerY: number;
}

/** Tâm mặc định khi không dò được - giữa khung, an toàn nhất */
const CENTER_FALLBACK: SubjectCenter = { found: false, centerX: 0.5, centerY: 0.5 };

/** Trích 1 frame ra JPEG nhỏ (scale 640) - đủ cho vision, nhẹ cho request */
async function grabFrameJpeg(videoAbs: string, atSec: number): Promise<string | null> {
  const tmp = path.join(os.tmpdir(), `aiev-frame-${randomBytes(6).toString("hex")}.jpg`);
  const { code } = await execFileCaptureAll(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-accurate_seek",
      "-ss",
      formatSec(Math.max(0, atSec)),
      "-i",
      videoAbs,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      "-q:v",
      "4",
      tmp,
    ],
    { timeoutMs: 60_000 },
  );
  if (code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* file tạm - xóa không được thì thôi */
    }
    return null;
  }
  return tmp;
}

/** Gọi Gemini vision với 1 ảnh + 1 prompt, trả text thô. null nếu lỗi bất kỳ. */
async function askGeminiVision(
  jpegAbs: string,
  prompt: string,
  apiKey: string,
): Promise<string | null> {
  let base64: string;
  try {
    base64 = fs.readFileSync(jpegAbs).toString("base64");
  } catch {
    return null;
  }
  const body = {
    contents: [
      {
        parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64 } }],
      },
    ],
  };
  try {
    const res = await fetch(GEMINI_VISION_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    return text || null;
  } catch {
    // Không có mạng / timeout / key sai - người gọi tự rơi về mặc định
    return null;
  }
}

/** Lấy object JSON đầu tiên trong text (chịu được fence ```json và lời dẫn thừa) */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const i = cleaned.indexOf("{");
  const j = cleaned.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(i, j + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const SUBJECT_PROMPT = [
  "You are a video reframing assistant.",
  "Find the MAIN SUBJECT of this video frame: the person who is speaking / on camera.",
  "If there is no person, use the most important visual element instead (the screen, slide, product or text block).",
  "Answer with ONLY one JSON object, no markdown, no explanation:",
  '{"found":true,"box":[ymin,xmin,ymax,xmax]}',
  "The box is the bounding box of that subject, coordinates normalized to 0-1000",
  "(ymin/ymax vertical from the top, xmin/xmax horizontal from the left).",
  'If you cannot identify any subject answer {"found":false,"box":[0,0,1000,1000]}.',
].join(" ");

/**
 * Định vị chủ thể trong MỘT frame bằng Gemini vision.
 *
 * Công thức đã chạy thật và đúng (sai số ~1% so với vị trí thật): model trả
 * `{"found": true, "box": [ymin, xmin, ymax, xmax]}` theo thang 0-1000, lấy tâm
 * bằng trung điểm hộp rồi chia 1000.
 *
 * KHÔNG BAO GIỜ ném lỗi: thiếu key / lỗi mạng / parse hỏng đều trả
 * `{found:false, 0.5, 0.5}` - một lần dò hỏng không được phép làm chết cả job cắt.
 */
export async function detectSubject(input: {
  videoAbs: string;
  atSec: number;
  apiKey: string | null;
}): Promise<SubjectCenter> {
  if (!input.apiKey) return { ...CENTER_FALLBACK };
  const jpeg = await grabFrameJpeg(input.videoAbs, input.atSec);
  if (!jpeg) return { ...CENTER_FALLBACK };
  try {
    const text = await askGeminiVision(jpeg, SUBJECT_PROMPT, input.apiKey);
    if (!text) return { ...CENTER_FALLBACK };
    const obj = firstJsonObject(text);
    if (!obj) return { ...CENTER_FALLBACK };
    if (obj.found === false) return { ...CENTER_FALLBACK };
    const box = obj.box;
    if (!Array.isArray(box) || box.length < 4) return { ...CENTER_FALLBACK };
    const [ymin, xmin, ymax, xmax] = box.map((v) => Number(v));
    if (![ymin, xmin, ymax, xmax].every((v) => Number.isFinite(v))) return { ...CENTER_FALLBACK };
    const centerX = clamp01(((xmin + xmax) / 2) / 1000);
    const centerY = clamp01(((ymin + ymax) / 2) / 1000);
    return { found: true, centerX, centerY };
  } finally {
    try {
      fs.rmSync(jpeg, { force: true });
    } catch {
      /* file tạm */
    }
  }
}

/**
 * Tâm chủ thể của cả MỘT ĐOẠN: lấy mẫu 3 mốc rải đều rồi lấy TRUNG VỊ.
 * VÌ SAO trung vị: người nói có thể quay đi/khuất tay ở một frame, và model
 * thỉnh thoảng bắt nhầm vật thể phụ - trung vị làm một mẫu lỗi không kéo lệch
 * khung cắt của cả đoạn (trung bình thì bị kéo).
 */
export async function detectSubjectOverRange(input: {
  videoAbs: string;
  start: number;
  end: number;
  apiKey: string | null;
  onLog?: (line: string) => void;
}): Promise<SubjectCenter> {
  const { start, end } = input;
  const span = Math.max(0, end - start);
  const marks = [0.25, 0.5, 0.75].map((f) => start + span * f);
  const found: SubjectCenter[] = [];
  for (const at of marks) {
    const one = await detectSubject({ videoAbs: input.videoAbs, atSec: at, apiKey: input.apiKey });
    input.onLog?.(
      `[subject] ${at.toFixed(1)}s -> ${
        one.found ? `x=${one.centerX.toFixed(3)} y=${one.centerY.toFixed(3)}` : "không dò được"
      }`,
    );
    if (one.found) found.push(one);
  }
  if (found.length === 0) return { ...CENTER_FALLBACK };
  return {
    found: true,
    centerX: median(found.map((f) => f.centerX)),
    centerY: median(found.map((f) => f.centerY)),
  };
}

export type FrameKind = "person" | "screen";

const CLASSIFY_PROMPT = [
  "Look at this video frame and decide what it mostly shows.",
  'Answer with ONLY one JSON object, no markdown: {"kind":"person"} or {"kind":"screen"}.',
  '"person" = a talking head / people filmed by a camera (the face is the point of the shot).',
  '"screen" = a screen recording, slide, chart, document, code, product UI or any frame where text/graphics carry the information.',
].join(" ");

/**
 * Khung này chủ yếu là NGƯỜI hay MÀN HÌNH/CHỮ? Dùng cho layout "auto":
 * person -> crop (cúp bám mặt, chủ thể to), screen -> fit (giữ trọn khung, không mất chữ).
 * Lỗi bất kỳ -> "screen" vì fit KHÔNG mất thông tin, còn crop nhầm là mất chữ vĩnh viễn.
 */
export async function classifyFrame(input: {
  videoAbs: string;
  atSec: number;
  apiKey: string | null;
}): Promise<FrameKind> {
  if (!input.apiKey) return "screen";
  const jpeg = await grabFrameJpeg(input.videoAbs, input.atSec);
  if (!jpeg) return "screen";
  try {
    const text = await askGeminiVision(jpeg, CLASSIFY_PROMPT, input.apiKey);
    if (!text) return "screen";
    const obj = firstJsonObject(text);
    const kind = typeof obj?.kind === "string" ? obj.kind.toLowerCase() : "";
    if (kind === "person") return "person";
    if (kind === "screen") return "screen";
    // Model trả chữ tự do - vẫn cứu được bằng cách dò từ khóa
    return /person|people|face|talking/i.test(text) ? "person" : "screen";
  } finally {
    try {
      fs.rmSync(jpeg, { force: true });
    } catch {
      /* file tạm */
    }
  }
}

// ------------------------------------------------------------------ Dựng lệnh ffmpeg

export type ReframeEncoder = "nvenc" | "x264";

/**
 * Cách đưa khung nguồn vào khung đích (đã bỏ "auto" - job phải quyết định trước):
 * - "crop": cắt cúp bám chủ thể. Hình ĐẦY khung, chủ thể TO, đổi lại MẤT phần rìa.
 * - "fit" : thu nhỏ giữ trọn khung nguồn, lấp trống bằng nền. KHÔNG mất thông tin
 *           nhưng chủ thể NHỎ - đã dựng thử thật: nguồn 16:9 fit vào 9:16 thì
 *           nhân vật chỉ chiếm ~1/3 chiều cao khung, xem trên điện thoại rất bé.
 * Chính vì hai nhược điểm đối lập đó mà mặc định của hệ thống là "auto"
 * (hỏi Gemini người hay màn hình rồi tự chọn), không cố định một kiểu.
 */
export type ReframeLayout = "crop" | "fit";

export interface ReframeSpec {
  srcAbs: string;
  outAbs: string;
  /** Giây tuyệt đối trong video nguồn */
  start: number;
  end: number;
  /** Kích thước nguồn ĐÃ áp cờ xoay (probeVideo trả về) */
  source: { width: number; height: number };
  target: { width: number; height: number };
  layout: ReframeLayout;
  /** Tâm chủ thể 0-1 - chỉ layout "crop" dùng; thiếu = giữa khung */
  center?: { x: number; y: number } | null;
  /** Nền lấp phần trống của layout "fit" */
  backgroundKind?: AutoCutBackground;
  /** Ảnh nền (backgroundKind = "gemini") - thiếu file thì người gọi phải đổi sang "blur" */
  backgroundAbs?: string | null;
  /** Màu nền của Style Design (backgroundKind = "style"), dạng "#101113" */
  backgroundColor?: string | null;
  encoder: ReframeEncoder;
  /** fps đầu ra - dùng luôn làm nhịp cho nền ảnh/nền màu */
  fps: number;
}

/** Khung cắt (crop) bám tâm chủ thể, đã kẹp trong biên khung nguồn */
export interface CropBox {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Tính khung cắt theo tỉ lệ ĐÍCH, đặt tâm tại chủ thể rồi KẸP trong biên nguồn.
 * Kẹp là bắt buộc: chủ thể sát mép (đã gặp: tâm x=0.26) sẽ đẩy khung lòi ra
 * ngoài ảnh, ffmpeg báo lỗi "Invalid too big or non positive size for width..."
 * hoặc cho ra viền đen.
 */
export function computeCropBox(
  source: { width: number; height: number },
  target: { width: number; height: number },
  center?: { x: number; y: number } | null,
): CropBox {
  const srcAr = source.width / source.height;
  const dstAr = target.width / target.height;

  let cw: number;
  let ch: number;
  if (srcAr > dstAr) {
    // Nguồn rộng hơn đích: giữ trọn chiều cao, cắt bớt hai bên
    ch = source.height;
    cw = Math.round(ch * dstAr);
  } else {
    // Nguồn cao hơn đích: giữ trọn chiều rộng, cắt bớt trên dưới
    cw = source.width;
    ch = Math.round(cw / dstAr);
  }
  cw = evenClamp(cw, 2, source.width);
  ch = evenClamp(ch, 2, source.height);

  const cx = clamp(
    Math.round(clamp01(center?.x ?? 0.5) * source.width - cw / 2),
    0,
    source.width - cw,
  );
  const cy = clamp(
    Math.round(clamp01(center?.y ?? 0.5) * source.height - ch / 2),
    0,
    source.height - ch,
  );
  return { width: cw, height: ch, x: cx, y: cy };
}

/** Argv encoder video - GPU (NVENC) hoặc CPU (libx264) */
function encoderArgs(encoder: ReframeEncoder): string[] {
  return encoder === "nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "23", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"];
}

/**
 * Argv ĐẦY ĐỦ cho ffmpeg: cắt đoạn [start, end] và đưa khung nguồn vào khung đích.
 *
 * Ghi chú đã kiểm chứng:
 * - `-ss <start> -to <end>` đặt TRƯỚC `-i` (seek nhanh, không giải mã phần bỏ đi),
 *   kèm `-accurate_seek` để không lệch sang keyframe gần nhất. Đã đo thật: `-to`
 *   tính theo mốc TUYỆT ĐỐI trong file (không phải "thêm bao nhiêu giây sau -ss").
 * - Nền ảnh/nền màu phải có NHỊP (framerate) bằng fps đích, vì trong overlay nó
 *   là input CHÍNH và quyết định fps đầu ra; kèm `shortest=1` để dừng đúng lúc
 *   video hết (ảnh loop là vô hạn).
 * - Giữ audio bằng `-map 0:a?` (dấu ? = không có audio thì bỏ qua, không lỗi).
 */
export function buildReframeArgs(spec: ReframeSpec): string[] {
  const W = evenClamp(spec.target.width, 2, 8192);
  const H = evenClamp(spec.target.height, 2, 8192);
  const fps = Number.isFinite(spec.fps) && spec.fps > 0 ? Math.round(spec.fps * 1000) / 1000 : 30;

  const ssSec = Math.max(0, spec.start);
  const toSec = Math.max(spec.start + 0.04, spec.end);
  const inputs: string[] = [
    "-accurate_seek",
    "-ss",
    formatSec(ssSec),
    "-to",
    formatSec(toSec),
    "-i",
    spec.srcAbs,
  ];

  const useImageBg =
    spec.layout === "fit" &&
    spec.backgroundKind === "gemini" &&
    !!spec.backgroundAbs &&
    fs.existsSync(spec.backgroundAbs);

  if (useImageBg) {
    // Ảnh tĩnh: loop vô hạn + framerate = fps đích, overlay dùng shortest=1 để dừng
    inputs.push("-loop", "1", "-framerate", String(fps), "-i", spec.backgroundAbs as string);
  }

  let filter: string;
  if (spec.layout === "crop") {
    const box = computeCropBox(spec.source, { width: W, height: H }, spec.center);
    filter =
      `[0:v]crop=${box.width}:${box.height}:${box.x}:${box.y},` +
      `scale=${W}:${H},setsar=1[v]`;
  } else {
    // Foreground: thu nhỏ vừa khung, ép chiều chẵn (overlay lên nền yuv420 không lệch chroma)
    const fg = `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`;
    if (useImageBg) {
      filter =
        `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[bg];` +
        `[0:v]${fg}[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v]`;
    } else if (spec.backgroundKind === "style") {
      filter =
        `color=c=${ffColor(spec.backgroundColor)}:s=${W}x${H}:r=${fps}[bg];` +
        `[0:v]${fg}[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v]`;
    } else {
      // Nền mờ từ chính video (mặc định + fallback khi không có ảnh Gemini):
      // phóng to phủ khung, làm mờ mạnh và tối đi để chủ thể ở giữa vẫn nổi bật.
      filter =
        `[0:v]split=2[bgsrc][fgsrc];` +
        `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:2,eq=brightness=-0.15[bg];` +
        `[fgsrc]${fg}[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`;
    }
  }

  return [
    "-y",
    "-hide_banner",
    ...inputs,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "0:a?",
    // Đoạn cắt ra gần như luôn bắt đầu và kết thúc giữa chừng tiếng nói hoặc
    // tiếng nền, nên hai mép là hai bậc nhảy biên độ - xem audioCutFade().
    // `-af` bám luồng audio đầu ra; nguồn không có tiếng thì `0:a?` không map
    // gì và ffmpeg bỏ qua tùy chọn này, không lỗi (đã thử với file câm).
    ...audioFadeArgs(toSec - ssSec),
    ...encoderArgs(spec.encoder),
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    spec.outAbs,
  ];
}

/**
 * Encoder nên dùng cho bước cắt: bật "GPU cho bản final" trong tab Tăng tốc VÀ
 * máy có NVENC thật thì mới dùng GPU. Cắt đoạn là bản dùng luôn cho project con
 * (không phải bản nháp) nên bám cờ `gpuEncodeFinal`.
 */
export async function chooseEncoder(): Promise<ReframeEncoder> {
  if (!readRenderSettings().gpuEncodeFinal) return "x264";
  try {
    const hw = await detectHardware();
    return hw.nvenc ? "nvenc" : "x264";
  } catch {
    return "x264";
  }
}

/**
 * Chạy lệnh cắt + reframe. NVENC lỗi (driver cũ, hết session encode, codec không
 * hỗ trợ kích thước) thì chạy lại bằng libx264 - chậm hơn nhưng luôn xong việc.
 * Trả về encoder thực sự đã dùng.
 */
export async function runCutReframe(
  spec: ReframeSpec,
  runner: {
    exec: (file: string, args: string[]) => Promise<void>;
    log?: (line: string) => void;
  },
): Promise<ReframeEncoder> {
  try {
    await runner.exec("ffmpeg", buildReframeArgs(spec));
    return spec.encoder;
  } catch (err) {
    if (spec.encoder !== "nvenc") throw err;
    const message = err instanceof Error ? err.message : String(err);
    runner.log?.(`[warn] Encode bằng NVENC thất bại (${message}) - chạy lại bằng libx264 (CPU).`);
    await runner.exec("ffmpeg", buildReframeArgs({ ...spec, encoder: "x264" }));
    return "x264";
  }
}

// ------------------------------------------------------------------ Tiện ích nhỏ

/** Tỉ lệ nguồn và đích coi như TRÙNG nhau (lệch < 1%) - khỏi reframe, chỉ cắt */
export function sameAspect(
  a: { width: number; height: number },
  b: { width: number; height: number },
  tolerance = 0.01,
): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / rb < tolerance;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0.5;
}

/** Ép về số CHẴN trong [min, max] - H.264 yêu cầu chiều chia hết cho 2 */
function evenClamp(v: number, min: number, max: number): number {
  const even = Math.floor(clamp(Math.round(v), min, max) / 2) * 2;
  return Math.max(min, even);
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Giây -> chuỗi ffmpeg (3 số lẻ, không dùng ký hiệu mũ cho số rất nhỏ) */
function formatSec(sec: number): string {
  return (Math.round(sec * 1000) / 1000).toFixed(3);
}

/** "#101113" -> "0x101113" (dạng ffmpeg chắc chắn hiểu); rỗng/hỏng -> đen */
function ffColor(hex?: string | null): string {
  const m = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec((hex ?? "").trim());
  return m ? `0x${m[1].toLowerCase()}` : "0x000000";
}
