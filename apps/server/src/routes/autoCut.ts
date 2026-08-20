import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { nanoid } from "nanoid";
import { paths, repoRoot } from "../config.js";
import * as db from "../db.js";
import { broadcast } from "../events.js";
import {
  AUTO_CUT_ASPECTS,
  AUTO_CUT_BACKGROUNDS,
  AUTO_CUT_LAYOUTS,
  AUTO_CUT_MODES,
  autoCutDirOf,
  briefOfAutoCut,
  readAutoCut,
  scanAutoCuts,
  writeAutoCut,
  type AutoCutAspect,
  type AutoCutBackground,
  type AutoCutLayout,
  type AutoCutMeta,
  type AutoCutMode,
  type AutoCutOutput,
  type AutoCutParams,
  type AutoCutSegment,
  type AutoCutSource,
} from "../autoCutMeta.js";
import { applyBriefPatch, defaultBrief, type Brief } from "../meta.js";
import { queue } from "../queue.js";
import { styleExists } from "../styles.js";
import {
  HttpError,
  execFileCaptureAll,
  fileKind,
  listFilesRecursive,
  nowIso,
  toKebabAscii,
  toRepoRel,
} from "../util.js";

/**
 * Auto cut videos - tab cắt video dài thành nhiều video ngắn, mỗi đoạn tự thành
 * một Videos Project. Mount tại /api/auto-cut (xem index.ts).
 *
 * Vòng đời một phiên cắt (đĩa là nguồn sự thật, xem autoCutMeta.ts):
 *   POST /            -> draft   (đo nguồn bằng ffprobe, chốt tham số)
 *   POST /:id/plan    -> job step "plan"  -> planned (có segments để duyệt)
 *   PATCH /:id        -> sửa segments/tham số trước khi cắt
 *   POST /:id/cut     -> job step "cut"   -> done
 *
 * Route CHỈ validate + ghi meta + đẩy job vào hàng đợi. Mọi chuyển trạng thái
 * nặng (planning/cutting/done/failed) do job runner (jobs/autoCut.ts) ghi -
 * backend là nguồn sự thật duy nhất về trạng thái job, route không đoán trước.
 */

const router = Router();

// ------------------------------------------------------------------ Tiện ích

/** Số hữu hạn hoặc ném 400 - dùng cho mọi tham số số người dùng gửi lên */
function toNumber(raw: unknown, what: string, code = "INVALID_PARAMS"): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (typeof raw === "boolean" || raw === null || raw === "" || !Number.isFinite(n)) {
    throw new HttpError(400, code, `${what} phải là số`);
  }
  return n;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Làm tròn 2 chữ số - giây trong meta không cần chính xác hơn 10ms */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function parseBool(raw: unknown, fallback: boolean, what: string): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") {
    throw new HttpError(400, "INVALID_BODY", `${what} phải là boolean`);
  }
  return raw;
}

/**
 * Đường dẫn do người dùng/agent gửi lên -> tuyệt đối, CHẶN thoát khỏi repo.
 * `path.resolve` tự nuốt "../" nên phải kiểm tra lại tiền tố sau khi resolve;
 * chuỗi kiểu "../../Windows/System32/..." hay đường dẫn tuyệt đối ổ khác đều bị chặn.
 */
function resolveInRepo(rel: string, what: string): string {
  const abs = path.resolve(repoRoot, rel);
  if (abs !== repoRoot && !abs.startsWith(path.resolve(repoRoot) + path.sep)) {
    throw new HttpError(400, "PATH_OUTSIDE_REPO", `${what} "${rel}" nằm ngoài repo`);
  }
  return abs;
}

/**
 * Validate patch Brief gửi từ UI. Dùng đúng `applyBriefPatch` của Videos Project
 * nên hai nơi không bao giờ lệch luật; `styleId` bỏ qua ở đây vì phiên cắt lấy
 * style từ `output.styleId` (một nguồn sự thật duy nhất).
 */
function parseBriefPatch(raw: unknown, base: Brief): Brief {
  if (raw === undefined || raw === null) return base;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "INVALID_BRIEF", "brief phải là object");
  }
  const { styleId: _ignored, ...rest } = raw as Record<string, unknown>;
  return applyBriefPatch(base, rest);
}

/** Id kebab-case duy nhất, không trùng thư mục có sẵn trong auto-cut/ */
function newAutoCutId(name: string): string {
  const base = toKebabAscii(name) || "auto-cut";
  let id = base;
  for (let n = 2; fs.existsSync(autoCutDirOf(id)); n++) id = `${base}-${n}`;
  return id;
}

// ------------------------------------------------------------------ ffprobe

/** "30000/1001" -> 29.97 */
function parseRate(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const [a, b] = v.split("/");
  const num = parseFloat(a);
  const den = b === undefined ? 1 : parseFloat(b);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return fps > 0 ? fps : null;
}

function maybeNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Đo video nguồn: kích thước THẬT SAU KHI GIẢI MÃ, fps, thời lượng, cờ xoay.
 *
 * Vì sao phải đọc rotation: video quay dọc bằng điện thoại được lưu ngang kèm
 * side-data `rotation` (hoặc tag `rotate` với file cũ). ffprobe trả kích thước
 * luồng THÔ - đã kiểm chứng với `video-projects/dd/assets/20260731-164133.mp4`:
 * ffprobe báo 3840x2160 nhưng side_data rotation = -90, khung giải mã thật là
 * 2160x3840. Không hoán đổi thì mọi video điện thoại bị hiểu nhầm là video
 * ngang, kéo theo chọn sai layout crop/fit và sai toàn bộ phép tính tỉ lệ.
 */
async function probeSource(abs: string, rel: string): Promise<Omit<AutoCutSource, "relPath">> {
  const r = await execFileCaptureAll(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,avg_frame_rate,duration",
      "-show_entries",
      "stream_side_data=rotation",
      "-show_entries",
      "stream_tags=rotate",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      abs,
    ],
    { timeoutMs: 30_000 },
  );
  if (r.timedOut) {
    throw new HttpError(400, "PROBE_FAILED", `ffprobe quá thời gian khi đọc "${rel}"`);
  }
  if (r.code !== 0) {
    throw new HttpError(
      400,
      "PROBE_FAILED",
      `ffprobe không đọc được "${rel}" (mã ${r.code}): ${r.stderr.trim().slice(0, 200)}`,
    );
  }

  let json: {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  try {
    json = JSON.parse(r.stdout) as typeof json;
  } catch {
    throw new HttpError(400, "PROBE_FAILED", `ffprobe trả JSON không đọc được cho "${rel}"`);
  }

  const stream = Array.isArray(json.streams) ? json.streams[0] : undefined;
  if (!stream) {
    throw new HttpError(400, "INVALID_SOURCE", `File "${rel}" không có stream video`);
  }

  const rawWidth = maybeNum(stream.width);
  const rawHeight = maybeNum(stream.height);
  if (!rawWidth || !rawHeight || rawWidth <= 0 || rawHeight <= 0) {
    throw new HttpError(400, "PROBE_FAILED", `Không đọc được kích thước khung của "${rel}"`);
  }

  // rotation: ưu tiên side_data (chuẩn mới), fallback tag `rotate` (file cũ)
  const sideData = Array.isArray(stream.side_data_list)
    ? (stream.side_data_list as Array<Record<string, unknown>>)
    : [];
  let rawRotation: number | null = null;
  for (const sd of sideData) {
    const n = maybeNum(sd.rotation);
    if (n !== null) {
      rawRotation = n;
      break;
    }
  }
  if (rawRotation === null) {
    const tags = (stream.tags ?? {}) as Record<string, unknown>;
    rawRotation = maybeNum(tags.rotate);
  }
  // Chuẩn hóa về [0, 360) để phía tiêu thụ chỉ phải so 0/90/180/270 (ffprobe trả -90)
  const rotation = ((Math.round(rawRotation ?? 0) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;

  const durationSec =
    maybeNum(json.format?.duration) ?? maybeNum(stream.duration) ?? 0;
  if (!(durationSec > 0)) {
    throw new HttpError(400, "PROBE_FAILED", `Không đọc được thời lượng của "${rel}"`);
  }

  // fps 0 hoặc thiếu (một số file webm/mkv) -> 30 để phép tính frame không chia cho 0
  const fps = parseRate(stream.r_frame_rate) ?? parseRate(stream.avg_frame_rate) ?? 30;

  return {
    width: swap ? rawHeight : rawWidth,
    height: swap ? rawWidth : rawHeight,
    fps: Math.round(fps * 1000) / 1000,
    durationSec: round2(durationSec),
    rotation,
  };
}

// ------------------------------------------------------------------ Validate

function parseMode(raw: unknown): AutoCutMode {
  if (!AUTO_CUT_MODES.includes(raw as AutoCutMode)) {
    throw new HttpError(
      400,
      "INVALID_MODE",
      `mode phải là một trong: ${AUTO_CUT_MODES.join(", ")}`,
    );
  }
  return raw as AutoCutMode;
}

/** styleId: undefined = giữ nguyên, null/"" = style mặc định, string = phải tồn tại */
function parseStyleId(raw: unknown, fallback: string | null): string | null {
  if (raw === undefined) return fallback;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new HttpError(400, "INVALID_STYLE_ID", "output.styleId phải là string hoặc null");
  }
  const id = raw.trim();
  if (!id) return null;
  if (!styleExists(id)) {
    throw new HttpError(404, "STYLE_NOT_FOUND", `Không tìm thấy style "${id}"`);
  }
  return id;
}

/** fps đầu ra: null = giữ theo nguồn; số phải dương */
function parseOutFps(raw: unknown, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  if (raw === null || raw === "") return null;
  const n = toNumber(raw, "output.fps", "INVALID_FPS");
  if (n <= 0 || n > 240) {
    throw new HttpError(400, "INVALID_FPS", "output.fps phải là số dương (<= 240) hoặc null");
  }
  return Math.round(n * 1000) / 1000;
}

function parseOutput(raw: unknown, fallback: AutoCutOutput): AutoCutOutput {
  if (raw === undefined) return fallback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "INVALID_OUTPUT", "output phải là object");
  }
  const o = raw as Record<string, unknown>;

  let aspect = fallback.aspect;
  if (o.aspect !== undefined) {
    if (!AUTO_CUT_ASPECTS.includes(o.aspect as AutoCutAspect)) {
      throw new HttpError(
        400,
        "INVALID_ASPECT",
        `output.aspect phải là một trong: ${AUTO_CUT_ASPECTS.join(", ")}`,
      );
    }
    aspect = o.aspect as AutoCutAspect;
  }

  let layout = fallback.layout;
  if (o.layout !== undefined) {
    if (!AUTO_CUT_LAYOUTS.includes(o.layout as AutoCutLayout)) {
      throw new HttpError(
        400,
        "INVALID_LAYOUT",
        `output.layout phải là một trong: ${AUTO_CUT_LAYOUTS.join(", ")}`,
      );
    }
    layout = o.layout as AutoCutLayout;
  }

  let background = fallback.background;
  if (o.background !== undefined) {
    if (!AUTO_CUT_BACKGROUNDS.includes(o.background as AutoCutBackground)) {
      throw new HttpError(
        400,
        "INVALID_BACKGROUND",
        `output.background phải là một trong: ${AUTO_CUT_BACKGROUNDS.join(", ")}`,
      );
    }
    background = o.background as AutoCutBackground;
  }

  return {
    aspect,
    layout,
    background,
    styleId: parseStyleId(o.styleId, fallback.styleId),
    fps: parseOutFps(o.fps, fallback.fps),
  };
}

/**
 * params phụ thuộc mode - chỉ giữ đúng field có nghĩa với mode đang chọn để
 * meta không mang tham số rác (vd `minutes` còn sót lại khi đã đổi sang mode ai).
 */
function parseParams(mode: AutoCutMode, raw: unknown, fallback: AutoCutParams): AutoCutParams {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    throw new HttpError(400, "INVALID_PARAMS", "params phải là object");
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  /** Giá trị mới nếu có, không thì giá trị cũ, không nữa thì mặc định */
  const pick = (key: keyof AutoCutParams, def: number): number => {
    if (o[key] !== undefined) return toNumber(o[key], `params.${key}`);
    const old = fallback[key];
    return typeof old === "number" && Number.isFinite(old) ? old : def;
  };

  if (mode === "time") {
    // Kẹp 0.25-60 phút: dưới 15 giây thì clip vụn vô nghĩa, trên 60 phút thì
    // không còn là "cắt ngắn" nữa.
    const minutes = clamp(pick("minutes", 5), 0.25, 60);
    const overlapSec = clamp(pick("overlapSec", 0), 0, 60);
    return { minutes: round2(minutes), overlapSec: round2(overlapSec) };
  }

  // mode "ai" | "prompt"
  const count = Math.round(clamp(pick("count", 5), 1, 20));
  const minSec = clamp(pick("minSec", 20), 1, 3600);
  const maxSec = clamp(pick("maxSec", 60), 1, 3600);
  if (maxSec <= minSec) {
    throw new HttpError(
      400,
      "INVALID_PARAMS",
      `params.maxSec (${maxSec}) phải lớn hơn params.minSec (${minSec})`,
    );
  }

  const out: AutoCutParams = { count, minSec: round2(minSec), maxSec: round2(maxSec) };
  if (mode === "prompt") {
    const rawRequest = o.request !== undefined ? o.request : fallback.request;
    if (typeof rawRequest !== "string" || !rawRequest.trim()) {
      throw new HttpError(
        400,
        "REQUEST_REQUIRED",
        'mode "prompt" cần params.request - mô tả đoạn bạn muốn AI tìm trong video',
      );
    }
    out.request = rawRequest.trim();
  }
  return out;
}

/**
 * mode ai/prompt BẮT BUỘC transcribe (AI phải đọc lời thoại mới chọn được đoạn)
 * -> ép về true, không báo lỗi để UI không phải biết luật này.
 * mode time mặc định true nhưng tắt được (chia đều theo phút không cần transcript).
 */
function parseTranscribe(mode: AutoCutMode, raw: unknown, fallback: boolean): boolean {
  if (mode !== "time") return true;
  return parseBool(raw, fallback, "transcribe");
}

// ------------------------------------------------------------------ Segments

/**
 * Áp patch danh sách đoạn do người dùng sửa trên UI.
 *
 * Ngữ nghĩa PATCH theo `index` (index là DANH TÍNH của đoạn, không phải vị trí
 * trong mảng): phần tử không gửi lên thì giữ nguyên; muốn bỏ một đoạn thì đặt
 * `selected: false` chứ không xóa khỏi mảng - xóa sẽ làm lệch index của cả kế
 * hoạch và mất luôn liên kết tới project con đã tạo.
 * Index chưa có thì tạo đoạn mới (người dùng tự thêm đoạn thủ công) - khi đó
 * bắt buộc có cả start lẫn end.
 */
function patchSegments(meta: AutoCutMeta, raw: unknown): AutoCutSegment[] {
  if (!Array.isArray(raw)) {
    throw new HttpError(400, "INVALID_SEGMENTS", "segments phải là mảng");
  }
  const maxEnd = Math.max(0, meta.source.durationSec);
  const byIndex = new Map<number, AutoCutSegment>();
  for (const s of meta.segments) byIndex.set(s.index, { ...s });
  const seen = new Set<number>();

  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "INVALID_SEGMENTS", "Mỗi phần tử segments phải là object");
    }
    const o = item as Record<string, unknown>;
    const index = toNumber(o.index, "segments[].index", "INVALID_SEGMENTS");
    if (!Number.isInteger(index) || index < 0) {
      throw new HttpError(400, "INVALID_SEGMENTS", "segments[].index phải là số nguyên >= 0");
    }
    if (seen.has(index)) {
      throw new HttpError(400, "INVALID_SEGMENTS", `segments[].index bị trùng: ${index}`);
    }
    seen.add(index);

    const current = byIndex.get(index);
    if (!current && (o.start === undefined || o.end === undefined)) {
      throw new HttpError(
        400,
        "INVALID_SEGMENTS",
        `Đoạn index ${index} chưa có trong kế hoạch - thêm mới phải kèm cả start và end`,
      );
    }

    // Kẹp trong [0, durationSec] rồi mới kiểm start < end: người dùng kéo tay
    // trên timeline dễ vượt biên vài chục ms, kẹp im lặng dễ chịu hơn báo lỗi.
    const start =
      o.start === undefined
        ? (current as AutoCutSegment).start
        : clamp(toNumber(o.start, "segments[].start", "INVALID_SEGMENTS"), 0, maxEnd);
    const end =
      o.end === undefined
        ? (current as AutoCutSegment).end
        : clamp(toNumber(o.end, "segments[].end", "INVALID_SEGMENTS"), 0, maxEnd);
    if (!(start < end)) {
      throw new HttpError(
        400,
        "INVALID_SEGMENTS",
        `Đoạn index ${index}: start (${start}) phải nhỏ hơn end (${end})`,
      );
    }

    if (o.title !== undefined && typeof o.title !== "string") {
      throw new HttpError(400, "INVALID_SEGMENTS", "segments[].title phải là string");
    }
    if (o.selected !== undefined && typeof o.selected !== "boolean") {
      throw new HttpError(400, "INVALID_SEGMENTS", "segments[].selected phải là boolean");
    }

    byIndex.set(index, {
      ...(current ?? { index, selected: true, title: `Đoạn ${index + 1}` }),
      index,
      start: round2(start),
      end: round2(end),
      title: o.title !== undefined ? (o.title as string).trim() : (current?.title ?? `Đoạn ${index + 1}`),
      selected: o.selected !== undefined ? (o.selected as boolean) : (current?.selected ?? true),
    });
  }

  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

// ------------------------------------------------------------------ Routes

/**
 * GET /api/auto-cut/sources -> { files: FileInfo[] }
 * Video trong imports/ để người dùng chọn làm nguồn cắt, mới nhất trước.
 * Upload file mới dùng POST /api/assets (scope=imports) - ở đây chỉ đọc danh sách.
 * ĐẶT TRƯỚC GET /:id, nếu không "sources" sẽ bị bắt như một id phiên cắt.
 */
router.get("/sources", (_req, res) => {
  const files = listFilesRecursive(paths.importsDir).filter((f) => f.kind === "video");
  res.json({ files });
});

// GET /api/auto-cut -> { sessions: AutoCutMeta[] } (mới cập nhật trước)
router.get("/", (_req, res) => {
  res.json({ sessions: scanAutoCuts() });
});

// GET /api/auto-cut/:id -> { session: AutoCutMeta }
router.get("/:id", (req, res) => {
  res.json({ session: readAutoCut(req.params.id) });
});

/**
 * POST /api/auto-cut -> 201 { session }
 * Body: { name?, sourceRel, mode, params?, output?, transcribe?, autoEdit? }
 */
router.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // ---- Nguồn: phải nằm trong repo, tồn tại, và là video thật
  const sourceRel = typeof body.sourceRel === "string" ? body.sourceRel.trim() : "";
  if (!sourceRel) {
    throw new HttpError(400, "SOURCE_REQUIRED", "Thiếu sourceRel (video nguồn cần cắt)");
  }
  const sourceAbs = resolveInRepo(sourceRel, "sourceRel");
  if (!fs.existsSync(sourceAbs) || !fs.statSync(sourceAbs).isFile()) {
    throw new HttpError(404, "SOURCE_NOT_FOUND", `Không thấy video nguồn "${sourceRel}"`);
  }
  if (fileKind(sourceAbs) !== "video") {
    throw new HttpError(
      400,
      "INVALID_SOURCE",
      `"${sourceRel}" không phải video (mp4/mov/webm/mkv/avi/m4v)`,
    );
  }

  // Validate toàn bộ tham số TRƯỚC khi gọi ffprobe - body sai thì trả lỗi ngay,
  // không tốn một lần spawn ffprobe (video 4K vài GB mất cả giây để mở).
  const mode = parseMode(body.mode);
  const defaultOutput: AutoCutOutput = {
    aspect: "9:16",
    layout: "auto",
    background: "gemini",
    styleId: null,
    fps: null,
  };
  const params = parseParams(mode, body.params, {});
  const output = parseOutput(body.output, defaultOutput);
  const transcribe = parseTranscribe(mode, body.transcribe, true);
  const autoEdit = parseBool(body.autoEdit, false, "autoEdit");
  // Cấu hình edit áp cho mọi project con - cùng bộ luật với PUT /projects/:id/brief
  const brief = parseBriefPatch(body.brief, defaultBrief());

  const source: AutoCutSource = {
    // Chuẩn hóa lại relPath từ đường dẫn tuyệt đối - client có thể gửi "\" hoặc "./"
    relPath: toRepoRel(sourceAbs),
    ...(await probeSource(sourceAbs, sourceRel)),
  };

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : path.basename(sourceAbs, path.extname(sourceAbs)); // mặc định lấy tên file nguồn

  const now = nowIso();
  const meta: AutoCutMeta = {
    id: newAutoCutId(name),
    name,
    status: "draft",
    source,
    mode,
    params,
    output,
    brief,
    transcribe,
    autoEdit,
    transcriptRel: null,
    segments: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  writeAutoCut(meta);
  res.status(201).json({ session: readAutoCut(meta.id) });
});

/**
 * PATCH /api/auto-cut/:id -> 200 { session }
 * Body: { name?, params?, output?, transcribe?, autoEdit?, segments? }
 */
router.patch("/:id", (req, res) => {
  const meta = readAutoCut(req.params.id); // ném 404 nếu không có
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Đang plan/cut thì kế hoạch và tham số đang được job đọc - chỉ cho sửa
  // name/autoEdit (thuần hiển thị + hành vi sau khi cắt xong).
  const touchesPlan =
    "params" in body || "output" in body || "transcribe" in body || "segments" in body;
  if (touchesPlan && (meta.status === "planning" || meta.status === "cutting")) {
    throw new HttpError(
      409,
      "BUSY",
      `Phiên cắt "${meta.id}" đang chạy (${meta.status}) - đợi xong rồi mới sửa được kế hoạch`,
    );
  }

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new HttpError(400, "INVALID_NAME", "name phải là string không rỗng");
    }
    meta.name = body.name.trim();
  }
  meta.autoEdit = parseBool(body.autoEdit, meta.autoEdit, "autoEdit");
  // Cấu hình edit KHÔNG làm kế hoạch cắt hết đúng (chỉ ảnh hưởng khâu dựng project
  // con) nên sửa lúc nào cũng được, không reset segments.
  if ("brief" in body) meta.brief = parseBriefPatch(body.brief, briefOfAutoCut(meta));

  // ---- Thay đổi làm KẾ HOẠCH CŨ HẾT ĐÚNG: params, transcribe, và mọi field
  // output trừ styleId (styleId chỉ ảnh hưởng khâu dựng project con, không đổi
  // ranh giới đoạn cắt nên giữ nguyên kế hoạch).
  const before = JSON.stringify([meta.params, meta.transcribe, planKeyOf(meta.output)]);
  if ("params" in body) meta.params = parseParams(meta.mode, body.params, meta.params);
  if ("output" in body) meta.output = parseOutput(body.output, meta.output);
  if ("transcribe" in body) {
    meta.transcribe = parseTranscribe(meta.mode, body.transcribe, meta.transcribe);
  }
  const after = JSON.stringify([meta.params, meta.transcribe, planKeyOf(meta.output)]);

  if (before !== after && meta.status !== "draft") {
    // Kế hoạch cũ không còn đúng với tham số mới -> về draft, buộc plan lại.
    // Kể cả phiên đã "done": segments chỉ là CÔNG THỨC cắt, các Videos Project
    // con đã tạo vẫn còn nguyên trên đĩa (xem ghi chú ở DELETE).
    meta.status = "draft";
    meta.segments = [];
    meta.error = null;
  }

  if ("segments" in body) {
    if (meta.status !== "planned" && meta.status !== "draft") {
      throw new HttpError(
        409,
        "BUSY",
        `Chỉ sửa được danh sách đoạn khi phiên ở trạng thái draft hoặc planned (hiện tại: ${meta.status})`,
      );
    }
    meta.segments = patchSegments(meta, body.segments);
    // Người dùng tự thêm đoạn khi còn draft = đã có kế hoạch thủ công, cho phép
    // bấm Cắt luôn mà không cần chạy bước plan.
    if (meta.segments.length > 0 && meta.status === "draft") meta.status = "planned";
  }

  writeAutoCut(meta);
  res.json({ session: readAutoCut(meta.id) });
});

/** Phần output ảnh hưởng tới ranh giới đoạn cắt (styleId thì không) */
function planKeyOf(output: AutoCutOutput): unknown {
  return [output.aspect, output.layout, output.background, output.fps];
}

/** Chặn chạy chồng job trên cùng một phiên cắt (queue chạy tuần tự nhưng vẫn phải chặn ở API) */
function assertNotBusy(meta: AutoCutMeta): void {
  if (db.hasActiveJobForProject(meta.id)) {
    throw new HttpError(
      409,
      "BUSY",
      `Phiên cắt "${meta.id}" đang có job chạy/chờ trong hàng đợi`,
    );
  }
  if (meta.status === "planning" || meta.status === "cutting") {
    throw new HttpError(409, "BUSY", `Phiên cắt "${meta.id}" đang ${meta.status}`);
  }
}

/** Tạo + enqueue job auto-cut. sceneId mang step (xem db.ts JobType "auto-cut") */
function enqueueAutoCutJob(sessionId: string, step: "plan" | "cut"): db.JobApi {
  const job = db.createJob({
    id: `job_${nanoid()}`,
    projectId: sessionId,
    type: "auto-cut",
    sceneId: step,
  });
  const api = db.jobToApi(job);
  broadcast("job", api);
  queue.enqueue(job.id);
  return api;
}

// POST /api/auto-cut/:id/plan -> 202 { job } - transcribe (nếu cần) + chọn đoạn
router.post("/:id/plan", (req, res) => {
  const meta = readAutoCut(req.params.id); // ném 404 nếu không có
  assertNotBusy(meta);
  res.status(202).json({ job: enqueueAutoCutJob(meta.id, "plan") });
});

// POST /api/auto-cut/:id/cut -> 202 { job } - cắt + tạo Videos Project cho từng đoạn
router.post("/:id/cut", (req, res) => {
  const meta = readAutoCut(req.params.id); // ném 404 nếu không có
  assertNotBusy(meta);
  // Failed Ở BƯỚC CUT và vẫn còn segments = kế hoạch còn nguyên giá trị
  // (jobs/autoCut.ts ghi failed và không có gì trả về planned) - cho cắt lại
  // thay vì bắt re-plan, vì re-plan xóa mất tiêu đề user đã sửa tay.
  // PHẢI check failedStep === "cut": re-plan hỏng cũng để status failed nhưng
  // segments lúc đó là kế hoạch CŨ đã lỗi thời, không được cắt theo nó.
  const retryableFailed =
    meta.status === "failed" && meta.failedStep === "cut" && meta.segments.length > 0;
  if (meta.status !== "planned" && !retryableFailed) {
    throw new HttpError(
      409,
      "NOT_PLANNED",
      `Phiên cắt "${meta.id}" chưa có kế hoạch đã duyệt (status = ${meta.status}) - chạy bước plan trước`,
    );
  }
  if (!meta.segments.some((s) => s.selected)) {
    throw new HttpError(
      400,
      "NO_SEGMENT_SELECTED",
      "Chưa chọn đoạn nào để cắt - tích ít nhất một đoạn trong kế hoạch",
    );
  }
  res.status(202).json({ job: enqueueAutoCutJob(meta.id, "cut") });
});

/**
 * DELETE /api/auto-cut/:id?force=true -> 204
 *
 * CHỈ xóa thư mục phiên cắt (meta.json + transcript + file trung gian).
 * KHÔNG đụng tới các Videos Project con đã tạo từ phiên này: mỗi project con là
 * một sản phẩm ĐỘC LẬP, người dùng có thể đã dựng/render/đăng nó rồi - xóa phiên
 * cắt chỉ là dọn "công thức", không được phá "thành phẩm". Muốn bỏ project con
 * thì xóa riêng qua DELETE /api/projects/:id.
 */
router.delete("/:id", (req, res) => {
  // Kiểm force TRƯỚC khi đọc meta - giống DELETE /api/projects/:id, người gọi
  // quên cờ xác nhận thì báo ngay, không phụ thuộc phiên có tồn tại hay không.
  if (req.query.force !== "true") {
    throw new HttpError(400, "FORCE_REQUIRED", "Xóa phiên cắt cần ?force=true");
  }
  const meta = readAutoCut(req.params.id); // ném 404/400 nếu id sai hoặc không có
  // Job đang chạy sẽ ghi tiếp vào thư mục vừa xóa -> chặn trước cho sạch
  assertNotBusy(meta);
  fs.rmSync(autoCutDirOf(meta.id), { recursive: true, force: true });
  res.status(204).end();
});

export default router;
