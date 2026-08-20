import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { HttpError, ensureDir, isKebabCase, nowIso, toKebabAscii } from "./util.js";

/**
 * Image project - tạo ảnh AI (Gemini nền + Remotion hoàn thiện).
 * Nguồn sự thật: image-projects/<id>/meta.json (shape ImageProject trong docs/API.md).
 */

export const IMAGE_KINDS = [
  "background",
  "3d",
  "character",
  "texture",
  "product",
  "concept",
] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const IMAGE_ASPECTS = ["9:16", "16:9", "1:1", "4:5"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

export type ImageStatus = "draft" | "generating" | "done" | "error";

/** Bước của job "image-gen" - lưu trong cột sceneId của job */
export const IMAGE_GEN_STEPS = ["all", "background", "compose"] as const;
export type ImageGenStep = (typeof IMAGE_GEN_STEPS)[number];

export interface ImageStat {
  label: string;
  value: string;
}

/**
 * Vị trí khối chữ trong ảnh - lưới 3x3 (dọc-ngang).
 * "auto" = để Poster tự chọn theo tỉ lệ khung, đúng như trước khi có tùy chọn
 * này: ngang → giữa-trái, vuông → đáy-giữa, dọc → đáy-trái. Giữ "auto" làm mặc
 * định để project cũ render lại vẫn ra y hệt.
 */
export const IMAGE_TEXT_POSITIONS = [
  "auto",
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export type ImageTextPosition = (typeof IMAGE_TEXT_POSITIONS)[number];

export interface ImageOverlay {
  title: string;
  subtitle: string;
  stats: ImageStat[];
  cta: string;
  showLogo: boolean;
  /** Vị trí khối chữ trong khung - xem IMAGE_TEXT_POSITIONS */
  position: ImageTextPosition;
}

export interface ImageProject {
  id: string;
  name: string;
  prompt: string;
  kind: ImageKind;
  aspect: ImageAspect;
  status: ImageStatus;
  /** Model Gemini tạo nền (IMAGE_MODELS trong gemini.ts) - null = mặc định Nano Banana 2 */
  model: string | null;
  /** Style Design áp dụng khi generate (id trong assets/styles/styles.json) - null = style default */
  styleId: string | null;
  overlay: ImageOverlay;
  /** Tên file nền trong image-projects/<id>/ (vd "background.png") - null = chưa có */
  background: string | null;
  /** Tên file ảnh hoàn thiện (vd "final.png") - null = chưa compose */
  final: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function imageDirOf(id: string): string {
  return path.join(paths.imageProjectsDir, id);
}

export function imageMetaPathOf(id: string): string {
  return path.join(imageDirOf(id), "meta.json");
}

export function imageProjectExists(id: string): boolean {
  return isKebabCase(id) && fs.existsSync(imageMetaPathOf(id));
}

export function defaultOverlay(): ImageOverlay {
  return { title: "", subtitle: "", stats: [], cta: "", showLogo: true, position: "auto" };
}

/** Merge overlay partial (không tin dữ liệu ngoài) lên base - field thiếu/sai kiểu giữ base */
export function normOverlay(raw: unknown, base: ImageOverlay = defaultOverlay()): ImageOverlay {
  const out: ImageOverlay = { ...base, stats: [...base.stats] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  if (typeof o.title === "string") out.title = o.title;
  if (typeof o.subtitle === "string") out.subtitle = o.subtitle;
  if (typeof o.cta === "string") out.cta = o.cta;
  if (typeof o.showLogo === "boolean") out.showLogo = o.showLogo;
  // Giá trị lạ (client cũ, meta.json sửa tay) → giữ base thay vì nhận bừa
  if (IMAGE_TEXT_POSITIONS.includes(o.position as ImageTextPosition)) {
    out.position = o.position as ImageTextPosition;
  }
  if (Array.isArray(o.stats)) {
    out.stats = o.stats
      .filter(
        (s): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s),
      )
      .map((s) => ({
        label: typeof s.label === "string" ? s.label : "",
        value: typeof s.value === "string" ? s.value : String(s.value ?? ""),
      }));
  }
  return out;
}

function normStatus(s: unknown): ImageStatus {
  return s === "generating" || s === "done" || s === "error" ? s : "draft";
}

/** Chuẩn hóa meta đọc từ đĩa về đúng shape ImageProject (dữ liệu đĩa không tin kiểu) */
function normImageMeta(id: string, raw: unknown, mtimeIso: string): ImageProject {
  const m = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    id,
    name: typeof m.name === "string" && m.name ? m.name : id,
    prompt: typeof m.prompt === "string" ? m.prompt : "",
    kind: IMAGE_KINDS.includes(m.kind as ImageKind) ? (m.kind as ImageKind) : "background",
    aspect: IMAGE_ASPECTS.includes(m.aspect as ImageAspect) ? (m.aspect as ImageAspect) : "9:16",
    status: normStatus(m.status),
    model: typeof m.model === "string" && m.model ? m.model : null,
    styleId: typeof m.styleId === "string" && m.styleId ? m.styleId : null,
    overlay: normOverlay(m.overlay),
    background: typeof m.background === "string" && m.background ? m.background : null,
    final: typeof m.final === "string" && m.final ? m.final : null,
    error: typeof m.error === "string" && m.error ? m.error : null,
    createdAt: typeof m.createdAt === "string" && m.createdAt ? m.createdAt : mtimeIso,
    updatedAt: typeof m.updatedAt === "string" && m.updatedAt ? m.updatedAt : mtimeIso,
  };
}

/** Đọc meta.json của image project - ném HttpError 400/404/500 như readMeta của video project */
export function readImageMeta(id: string): ImageProject {
  if (!isKebabCase(id)) {
    throw new HttpError(400, "INVALID_IMAGE_ID", `Image project id không hợp lệ: ${id}`);
  }
  const file = imageMetaPathOf(id);
  if (!fs.existsSync(file)) {
    throw new HttpError(404, "IMAGE_NOT_FOUND", `Không tìm thấy image project "${id}"`);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return normImageMeta(id, raw, fs.statSync(file).mtime.toISOString());
  } catch {
    throw new HttpError(
      500,
      "META_INVALID",
      `meta.json của image project "${id}" không phải JSON hợp lệ`,
    );
  }
}

export function writeImageMeta(id: string, meta: ImageProject): void {
  meta.updatedAt = nowIso();
  ensureDir(imageDirOf(id));
  fs.writeFileSync(imageMetaPathOf(id), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

/** Sinh id từ name (bỏ dấu tiếng Việt, kebab-case), trùng thì thêm -2, -3… */
export function newImageProjectId(name: string): string {
  const base = toKebabAscii(name) || "image";
  let id = base;
  for (let n = 2; fs.existsSync(imageDirOf(id)); n++) id = `${base}-${n}`;
  return id;
}

/** Quét image-projects/<id>/meta.json → danh sách, mới cập nhật trước */
export function scanImageProjects(): ImageProject[] {
  if (!fs.existsSync(paths.imageProjectsDir)) return [];
  const out: ImageProject[] = [];
  for (const entry of fs.readdirSync(paths.imageProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = imageMetaPathOf(entry.name);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      out.push(normImageMeta(entry.name, raw, fs.statSync(file).mtime.toISOString()));
    } catch {
      /* meta hỏng → bỏ qua khỏi danh sách */
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}
