import fs from "node:fs";
import path from "node:path";
import type { TrimAggressiveness } from "./autoTrim.js";
import { paths } from "./config.js";
import { IMAGE_TEXT_POSITIONS, type ImageTextPosition } from "./imageMeta.js";
import { videoStyleExists } from "./videoStyles.js";
import {
  HttpError,
  ensureDir,
  isKebabCase,
  listFilesRecursive,
  nowIso,
  type FileInfo,
} from "./util.js";

/** Schema meta.json - manifest trung tâm của một video project (xem skill video-pipeline) */
export interface SceneMeta {
  id: string;
  /** Composition HyperFrames - scene do HyperFrames render */
  src?: string;
  /** Footage dùng thẳng - không qua HyperFrames */
  srcVideo?: string;
  /** Ảnh tĩnh (ảnh minh họa AI) - scene cutaway full-bleed */
  srcImage?: string;
  durationInFrames?: number;
  render?: string;
  from?: number;
  to?: number;
  transitionOverlap?: number;
  [key: string]: unknown;
}

export interface SfxMeta {
  file: string;
  atFrame?: number;
  volume?: number;
  [key: string]: unknown;
}

/** Nhạc nền với auto-ducking khi có thoại - file staging + speech ranges (giây) */
export interface MusicMeta {
  file: string;
  volume?: number;
  duckVolume?: number;
  speech?: [number, number][];
  [key: string]: unknown;
}

/** Kịch bản edit - AI đọc phần này khi bắt đầu edit project (xem docs/API.md mục Project Brief) */
export type SfxMode = "recommended" | "library" | "none";

export const SFX_MODES: SfxMode[] = ["recommended", "library", "none"];

/** Nhạc nền: AI tự chọn theo mood trong thư viện assets/music/ hoặc không dùng */
export type MusicMode = "auto" | "none";

export const MUSIC_MODES: MusicMode[] = ["auto", "none"];

/**
 * Mức mạnh tay khi cắt khoảng lặng - ánh xạ 1-1 sang TrimAggressiveness của
 * autoTrim.ts (natural | default | tight, xem TRIM_PROFILES ở đó để biết con số).
 *
 * Khai bằng Record chứ không viết thẳng mảng: thêm/bớt một mức trong autoTrim.ts
 * mà quên sửa ở đây thì TypeScript báo lỗi ngay, thay vì để lọt một mức không bao
 * giờ qua nổi khâu kiểm tra của brief.
 */
const AUTO_CUT_LEVEL_TABLE: Record<TrimAggressiveness, true> = {
  natural: true,
  default: true,
  tight: true,
};

export const AUTO_CUT_LEVELS = Object.keys(AUTO_CUT_LEVEL_TABLE) as TrimAggressiveness[];

export interface Brief {
  /** Mô tả nội dung video gốc - bối cảnh cho AI */
  sourceDescription: string;
  /** Có tự động cắt bỏ đoạn thừa, khoảng lặng không */
  autoCut: boolean;
  /**
   * Mạnh tay tới đâu khi cắt - chỉ có nghĩa khi autoCut = true (autoCut vẫn là
   * công tắc bật/tắt duy nhất, field này KHÔNG bật thay nó).
   */
  autoCutLevel: TrimAggressiveness;
  /** Có tạo phụ đề (karaoke) không */
  subtitles: boolean;
  /** BẬT = AI tự phân tích source, tự chọn keyword để highlight */
  highlightEnabled: boolean;
  /** (Nâng cao, tùy chọn) chỉ định thêm keyword thủ công */
  highlightKeywords: string[];
  /** BẬT = bố cục Key: KEY CHÍNH vùng TRÊN video, KEY LIÊN QUAN vùng DƯỚI (skill key-layout) */
  keyLayoutEnabled: boolean;
  /** Key chính user chỉ định - "" = AI tự phân tích chọn */
  mainKey: string;
  /** Key liên quan user chỉ định (bắt buộc dùng đủ) - [] = AI tự chọn 3–6 key */
  relatedKeys: string[];
  /** Tên skill dùng để edit (null = AI tự chọn) */
  skill: string | null;
  /** Sound effect: chỉ bộ đề xuất / tự tìm cả thư viện / không dùng */
  sfxMode: SfxMode;
  /** Nhạc nền: "auto" = AI tự chọn bài theo mood (thư viện assets/music/), "none" = không dùng */
  musicMode: MusicMode;
  /** BẬT = Claude tự tạo ảnh minh họa bằng Gemini (đồng bộ Design System) và ghép vào video */
  autoIllustrations: boolean;
  /** Model Gemini cho ảnh minh họa (null = mặc định Nano Banana 2) */
  illustrationModel: string | null;
  /** BẬT = cho phép Gemini vẽ chữ tiếng Việt vào ảnh minh họa (mặc định TẮT - chữ do Remotion/HyperFrames đặt) */
  illustrationText: boolean;
  /**
   * Vị trí CHỦ THỂ trong ảnh minh họa (lưới 3x3, dùng chung giá trị với vị trí
   * chữ của image project). "auto" = giữa khung theo chiều dọc, chừa band trên
   * (key chính) + band dưới (caption) - bố cục an toàn cho video.
   */
  illustrationPosition: ImageTextPosition;
  /**
   * Mật độ ảnh minh họa: số ảnh Gemini MỖI PHÚT video (1-20, số nguyên).
   * null = AI tự quyết theo nội dung (hành vi cũ). Đặt số để video dài
   * (Text to video đọc bài viết) đổi nền liên tục, đỡ nhàm chán.
   * Trần 20 = một ảnh mỗi 3 giây - dày hơn nữa là slideshow chớp nháy.
   */
  illustrationsPerMinute: number | null;
  /** Style Design áp cho video (id trong assets/styles/styles.json) - null = style default */
  styleId: string | null;
  /**
   * Công tắc PHONG CÁCH DỰNG. TẮT (mặc định) = video dựng theo đúng cấu hình đã
   * chọn (skill + Style Design), KHÔNG áp phong cách nào; BẬT = dùng phong cách
   * chỉ định ở `videoStyleId`.
   *
   * Có công tắc riêng chứ không suy từ `videoStyleId !== null`: một id để trống
   * không nói được người dùng muốn "không dùng phong cách" hay "chưa chọn xong".
   */
  videoStyleEnabled: boolean;
  /**
   * Phong cách dựng video (id trong videoStyles.ts) - CHỈ có hiệu lực khi
   * `videoStyleEnabled` bật (đọc qua activeVideoStyleId, đừng đọc thẳng field này).
   *
   * KHÁC styleId: styleId là nhận diện thương hiệu (màu/font/logo), còn cái này
   * là ngôn ngữ thị giác của video (giấy gấp, mực tàu, người que...). Hai thứ
   * chồng lên nhau chứ không thay thế nhau.
   */
  videoStyleId: string | null;
  /** Ghi chú tự do cho AI */
  notes: string;
  /** Tên tài liệu kịch bản quay dựng đã phân tích (Word/Excel/Google Sheets). */
  referenceName: string;
  /** Link Google Sheets gốc, nếu tài liệu được nhập bằng link. */
  referenceUrl: string;
  /** Văn bản đã trích xuất để AI đối chiếu với video gốc và yêu cầu edit. */
  referenceContent: string;
}

export function defaultBrief(): Brief {
  return {
    sourceDescription: "",
    autoCut: true,
    autoCutLevel: "default",
    subtitles: true,
    highlightEnabled: true,
    highlightKeywords: [],
    keyLayoutEnabled: true,
    mainKey: "",
    relatedKeys: [],
    skill: null,
    sfxMode: "recommended",
    musicMode: "auto",
    autoIllustrations: false,
    illustrationModel: null,
    illustrationText: false,
    illustrationPosition: "auto",
    illustrationsPerMinute: null,
    styleId: null,
    videoStyleEnabled: false,
    videoStyleId: null,
    notes: "",
    referenceName: "",
    referenceUrl: "",
    referenceContent: "",
  };
}

/**
 * Id phong cách dựng CÓ HIỆU LỰC cho brief này - công tắc tắt (hoặc bật mà chưa
 * chọn phong cách nào) thì trả null = dựng theo skill + Style Design.
 *
 * MỌI chỗ cần phong cách phải đi qua đây, KHÔNG đọc thẳng `brief.videoStyleId`:
 * đọc thẳng là công tắc tắt mà phong cách vẫn áp, đúng kiểu lỗi mà công tắc này
 * sinh ra để chặn.
 */
export function activeVideoStyleId(brief: Brief): string | null {
  return brief.videoStyleEnabled ? brief.videoStyleId : null;
}

/** Merge meta.brief (nếu có) lên default - field thiếu/sai kiểu dùng default */
export function briefOf(meta: ProjectMeta): Brief {
  const base = defaultBrief();
  const raw = meta.brief as unknown; // meta đọc từ đĩa - không tin kiểu
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const b = raw as Record<string, unknown>;
  if (typeof b.sourceDescription === "string") base.sourceDescription = b.sourceDescription;
  if (typeof b.autoCut === "boolean") base.autoCut = b.autoCut;
  if (AUTO_CUT_LEVELS.includes(b.autoCutLevel as TrimAggressiveness)) {
    base.autoCutLevel = b.autoCutLevel as TrimAggressiveness;
  }
  if (typeof b.subtitles === "boolean") base.subtitles = b.subtitles;
  if (typeof b.highlightEnabled === "boolean") base.highlightEnabled = b.highlightEnabled;
  if (Array.isArray(b.highlightKeywords)) {
    base.highlightKeywords = b.highlightKeywords.filter(
      (k): k is string => typeof k === "string",
    );
  }
  if (typeof b.keyLayoutEnabled === "boolean") base.keyLayoutEnabled = b.keyLayoutEnabled;
  if (typeof b.mainKey === "string") base.mainKey = b.mainKey;
  if (Array.isArray(b.relatedKeys)) {
    base.relatedKeys = b.relatedKeys.filter((k): k is string => typeof k === "string");
  }
  if (typeof b.skill === "string" && b.skill.trim()) base.skill = b.skill.trim();
  if (SFX_MODES.includes(b.sfxMode as SfxMode)) base.sfxMode = b.sfxMode as SfxMode;
  if (MUSIC_MODES.includes(b.musicMode as MusicMode)) base.musicMode = b.musicMode as MusicMode;
  if (typeof b.autoIllustrations === "boolean") base.autoIllustrations = b.autoIllustrations;
  if (typeof b.illustrationModel === "string" && b.illustrationModel.trim()) {
    base.illustrationModel = b.illustrationModel.trim();
  }
  if (typeof b.illustrationText === "boolean") base.illustrationText = b.illustrationText;
  if (IMAGE_TEXT_POSITIONS.includes(b.illustrationPosition as ImageTextPosition)) {
    base.illustrationPosition = b.illustrationPosition as ImageTextPosition;
  }
  if (
    typeof b.illustrationsPerMinute === "number" &&
    Number.isInteger(b.illustrationsPerMinute) &&
    b.illustrationsPerMinute >= 1 &&
    b.illustrationsPerMinute <= 20
  ) {
    base.illustrationsPerMinute = b.illustrationsPerMinute;
  }
  if (typeof b.styleId === "string" && b.styleId.trim()) base.styleId = b.styleId.trim();
  // Phong cách đã bị gỡ khỏi catalog (đổi tên id) thì lùi về null = không áp
  // phong cách, chứ không giữ một id chết làm mọi lời gọi sau đó báo lỗi
  if (typeof b.videoStyleId === "string" && videoStyleExists(b.videoStyleId.trim())) {
    base.videoStyleId = b.videoStyleId.trim();
  }
  // Brief cũ (ghi trước khi có công tắc) không có field này. Đã chọn được một
  // phong cách hợp lệ nghĩa là hồi đó người dùng CÓ ý dùng nó - giữ nguyên hiệu
  // lực, đừng để bản nâng cấp âm thầm tắt phong cách của project đang chạy dở.
  // PHẢI đứng SAU khối videoStyleId ở trên vì nó đọc kết quả của khối đó.
  if (typeof b.videoStyleEnabled === "boolean") base.videoStyleEnabled = b.videoStyleEnabled;
  else base.videoStyleEnabled = base.videoStyleId !== null;
  if (typeof b.notes === "string") base.notes = b.notes;
  if (typeof b.referenceName === "string") base.referenceName = b.referenceName;
  if (typeof b.referenceUrl === "string") base.referenceUrl = b.referenceUrl;
  if (typeof b.referenceContent === "string") base.referenceContent = b.referenceContent;
  return base;
}

/**
 * Áp một patch Brief (body JSON thô, không tin kiểu) lên brief nền và trả bản mới.
 *
 * Dùng chung cho `PUT /api/projects/:id/brief` và cấu hình edit của một phiên
 * Auto cut - hai nơi phải theo CÙNG một bộ luật, nếu tách ra viết lại thì sớm
 * muộn cũng lệch nhau.
 *
 * `checkStyle` được tiêm vào (thay vì import styles.ts) để meta.ts không phụ
 * thuộc ngược vào tầng trên.
 */
export function applyBriefPatch(
  base: Brief,
  body: Record<string, unknown>,
  checkStyle?: (id: string) => boolean,
): Brief {
  const brief: Brief = { ...base };
  const bad = (msg: string): never => {
    throw new HttpError(400, "INVALID_BRIEF", msg);
  };

  const str = (key: keyof Brief, trim = false): void => {
    if (!(key in body)) return;
    if (typeof body[key] !== "string") bad(`${key} phải là string`);
    const v = body[key] as string;
    (brief as unknown as Record<string, unknown>)[key] = trim ? v.trim() : v;
  };
  const bool = (key: keyof Brief): void => {
    if (!(key in body)) return;
    if (typeof body[key] !== "boolean") bad(`${key} phải là boolean`);
    (brief as unknown as Record<string, unknown>)[key] = body[key];
  };
  const strList = (key: keyof Brief): void => {
    if (!(key in body)) return;
    const raw = body[key];
    if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string")) {
      bad(`${key} phải là mảng string`);
    }
    (brief as unknown as Record<string, unknown>)[key] = (raw as string[])
      .map((k) => k.trim())
      .filter(Boolean);
  };
  /** string hoặc null; chuỗi rỗng quy về null */
  const nullableStr = (key: keyof Brief): string | null | undefined => {
    if (!(key in body)) return undefined;
    if (body[key] !== null && typeof body[key] !== "string") {
      bad(`${key} phải là string hoặc null`);
    }
    const v = typeof body[key] === "string" ? (body[key] as string).trim() : "";
    (brief as unknown as Record<string, unknown>)[key] = v || null;
    return v || null;
  };

  str("sourceDescription");
  bool("autoCut");
  bool("subtitles");
  bool("highlightEnabled");
  strList("highlightKeywords");
  bool("keyLayoutEnabled");
  str("mainKey", true);
  strList("relatedKeys");
  nullableStr("skill");
  bool("autoIllustrations");
  nullableStr("illustrationModel");
  bool("illustrationText");
  str("notes");
  str("referenceName");
  str("referenceUrl");
  str("referenceContent");

  if (
    "illustrationPosition" in body &&
    !IMAGE_TEXT_POSITIONS.includes(body.illustrationPosition as ImageTextPosition)
  ) {
    bad(`illustrationPosition phải là một trong: ${IMAGE_TEXT_POSITIONS.join(" | ")}`);
  }
  if ("illustrationPosition" in body) {
    brief.illustrationPosition = body.illustrationPosition as ImageTextPosition;
  }

  if ("illustrationsPerMinute" in body) {
    const v = body.illustrationsPerMinute;
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 20)) {
      bad("illustrationsPerMinute phải là null hoặc số nguyên 1-20");
    }
    brief.illustrationsPerMinute = v as number | null;
  }

  if (
    "autoCutLevel" in body &&
    !AUTO_CUT_LEVELS.includes(body.autoCutLevel as TrimAggressiveness)
  ) {
    bad(`autoCutLevel phải là một trong: ${AUTO_CUT_LEVELS.join(" | ")}`);
  }
  if ("autoCutLevel" in body) brief.autoCutLevel = body.autoCutLevel as TrimAggressiveness;

  if ("sfxMode" in body && !SFX_MODES.includes(body.sfxMode as SfxMode)) {
    bad(`sfxMode phải là một trong: ${SFX_MODES.join(" | ")}`);
  }
  if ("sfxMode" in body) brief.sfxMode = body.sfxMode as SfxMode;

  if ("musicMode" in body && !MUSIC_MODES.includes(body.musicMode as MusicMode)) {
    bad(`musicMode phải là một trong: ${MUSIC_MODES.join(" | ")}`);
  }
  if ("musicMode" in body) brief.musicMode = body.musicMode as MusicMode;

  const styleId = nullableStr("styleId");
  if (styleId && checkStyle && !checkStyle(styleId)) {
    throw new HttpError(400, "STYLE_NOT_FOUND", `Không tìm thấy style "${styleId}"`);
  }

  bool("videoStyleEnabled");

  const videoStyleId = nullableStr("videoStyleId");
  if (videoStyleId && !videoStyleExists(videoStyleId)) {
    throw new HttpError(
      400,
      "VIDEO_STYLE_NOT_FOUND",
      `Không tìm thấy phong cách dựng "${videoStyleId}". Xem danh sách tại GET /api/video-styles.`,
    );
  }
  // Chọn phong cách mà không nói gì tới công tắc = có ý dùng nó. Đây là hợp đồng
  // cũ của API (trước khi có công tắc, chỉ cần gửi videoStyleId là ăn), giữ lại
  // để client cũ và AI gọi thẳng API không bị "gửi xong mà không có tác dụng".
  // UI luôn gửi kèm videoStyleEnabled nên nhánh này không đụng tới nó.
  if (videoStyleId && !("videoStyleEnabled" in body)) brief.videoStyleEnabled = true;

  return brief;
}

export interface ProjectMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  status: string;
  brief?: Brief;
  scenes?: SceneMeta[];
  audio?: {
    voice?: string | null;
    sfx?: SfxMeta[];
    /** Nhạc nền auto-ducking (xem skill background-music) - null/thiếu = không có nhạc */
    music?: MusicMeta | null;
    [key: string]: unknown;
  };
  output?: string | null;
  /** Tags quản lý project - hiện trong danh sách, lọc được */
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ProjectSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  status: "draft" | "rendering" | "done";
  output: string | null;
  tags: string[];
  /**
   * Phiên Text to video đã sinh ra project này - null = project tạo tay.
   * Có trong SUMMARY (không chỉ trong meta chi tiết) để danh sách project hiện
   * được nguồn gốc: không thì người dùng thấy một project lạ mọc ra và không
   * hiểu nó ở đâu ra.
   */
  textToVideoId: string | null;
  createdAt: string | null;
  updatedAt: string;
}

/**
 * Chuẩn hóa output về string đường dẫn theo hợp đồng API.
 * AI đôi khi ghi meta.output thành object { file, renderPath, ... } - lấy .file.
 */
export function normOutput(raw: unknown): string | null {
  if (typeof raw === "string" && raw) return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (typeof o.file === "string" && o.file) return o.file;
    if (typeof o.renderPath === "string" && o.renderPath) return o.renderPath;
  }
  return null;
}

/** Chuẩn hóa mảng tags: string, trim, bỏ rỗng, dedupe */
export function normTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))];
}

export function projectDirOf(id: string): string {
  return path.join(paths.videoProjectsDir, id);
}

export function metaPathOf(id: string): string {
  return path.join(projectDirOf(id), "meta.json");
}

export function projectExists(id: string): boolean {
  return isKebabCase(id) && fs.existsSync(metaPathOf(id));
}

/** Đọc meta.json - ném HttpError 404/500 tùy trường hợp */
export function readMeta(id: string): ProjectMeta {
  if (!isKebabCase(id)) {
    throw new HttpError(400, "INVALID_PROJECT_ID", `Project id không hợp lệ: ${id}`);
  }
  const file = metaPathOf(id);
  if (!fs.existsSync(file)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy project "${id}"`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ProjectMeta;
  } catch {
    throw new HttpError(500, "META_INVALID", `meta.json của project "${id}" không phải JSON hợp lệ`);
  }
}

export function writeMeta(id: string, meta: ProjectMeta): void {
  meta.updatedAt = nowIso();
  fs.writeFileSync(metaPathOf(id), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

function normStatus(s: unknown): ProjectSummary["status"] {
  return s === "rendering" || s === "done" ? s : "draft";
}

export function projectSummaryOf(id: string): ProjectSummary | null {
  const file = metaPathOf(id);
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectMeta;
    const updatedAt =
      typeof meta.updatedAt === "string" && meta.updatedAt
        ? meta.updatedAt
        : fs.statSync(file).mtime.toISOString();
    return {
      id,
      name: typeof meta.name === "string" ? meta.name : id,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      fps: Number(meta.fps) || 0,
      status: normStatus(meta.status),
      output: normOutput(meta.output),
      tags: normTags(meta.tags),
      textToVideoId:
        typeof meta.textToVideoId === "string" && meta.textToVideoId
          ? meta.textToVideoId
          : null,
      createdAt: typeof meta.createdAt === "string" && meta.createdAt ? meta.createdAt : null,
      updatedAt,
    };
  } catch {
    return null; // meta hỏng → bỏ qua khỏi danh sách
  }
}

// ------------------------------------------------- Asset descriptions
// File video-projects/<id>/assets/assets.json = { "<fileName>": { "description": string } }
// Thiếu entry nghĩa là asset chưa được mô tả - upload mới không cần tạo entry.

export type FileInfoWithDescription = FileInfo & {
  description?: string;
  /** Preset chỉnh màu người dùng đã duyệt cho asset video (id trong GRADE_PRESETS, null = không chỉnh) */
  colorGrade?: string;
  /** Thông số chỉnh tay cộng chồng lên preset (GradeAdjust) - chỉ có khi khác mặc định */
  colorAdjust?: Record<string, number>;
  /** Số cảnh do người dùng gán; thiếu = theo thứ tự danh sách từ trên xuống. */
  sceneOrder?: number;
  /** Clip chính hay clip phụ trong cùng một cảnh. */
  sceneRole?: "main" | "support";
};

export interface AssetEntry {
  description?: string;
  colorGrade?: string;
  colorAdjust?: Record<string, number>;
  sceneOrder?: number;
  sceneRole?: "main" | "support";
}

/** Đọc assets.json → map fileName → entry đầy đủ; file thiếu/hỏng → {} */
export function readAssetEntries(id: string): Record<string, AssetEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(assetsJsonPathOf(id), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, AssetEntry> = {};
    for (const [file, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const clean: AssetEntry = {};
      if (typeof e.description === "string") clean.description = e.description;
      if (typeof e.colorGrade === "string" && e.colorGrade) clean.colorGrade = e.colorGrade;
      if (e.colorAdjust && typeof e.colorAdjust === "object" && !Array.isArray(e.colorAdjust)) {
        clean.colorAdjust = e.colorAdjust as Record<string, number>;
      }
      if (typeof e.sceneOrder === "number" && Number.isInteger(e.sceneOrder) && e.sceneOrder >= 1) {
        clean.sceneOrder = e.sceneOrder;
      }
      if (e.sceneRole === "main" || e.sceneRole === "support") clean.sceneRole = e.sceneRole;
      out[file] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge một phần entry của asset vào assets.json (colorGrade: null để xóa) */
export function writeAssetEntry(
  id: string,
  fileName: string,
  patch: {
    description?: string;
    colorGrade?: string | null;
    colorAdjust?: Record<string, number> | null;
    sceneOrder?: number | null;
    sceneRole?: "main" | "support" | null;
  },
): void {
  const map = readAssetEntries(id);
  const cur = map[fileName] ?? {};
  if (patch.description !== undefined) cur.description = patch.description;
  if (patch.colorGrade !== undefined) {
    if (patch.colorGrade === null) delete cur.colorGrade;
    else cur.colorGrade = patch.colorGrade;
  }
  if (patch.colorAdjust !== undefined) {
    if (patch.colorAdjust === null) delete cur.colorAdjust;
    else cur.colorAdjust = patch.colorAdjust;
  }
  if (patch.sceneOrder !== undefined) {
    if (patch.sceneOrder === null) delete cur.sceneOrder;
    else cur.sceneOrder = patch.sceneOrder;
  }
  if (patch.sceneRole !== undefined) {
    if (patch.sceneRole === null) delete cur.sceneRole;
    else cur.sceneRole = patch.sceneRole;
  }
  map[fileName] = cur;
  ensureDir(projectAssetsDirOf(id));
  fs.writeFileSync(assetsJsonPathOf(id), JSON.stringify(map, null, 2) + "\n", "utf8");
}

/** Xóa hẳn entry của một asset khỏi assets.json (dùng khi xóa file asset) - không có entry thì bỏ qua */
export function removeAssetEntry(id: string, fileName: string): void {
  const map = readAssetEntries(id);
  if (!(fileName in map)) return;
  delete map[fileName];
  fs.writeFileSync(assetsJsonPathOf(id), JSON.stringify(map, null, 2) + "\n", "utf8");
}

export function projectAssetsDirOf(id: string): string {
  return path.join(projectDirOf(id), "assets");
}

export function assetsJsonPathOf(id: string): string {
  return path.join(projectAssetsDirOf(id), "assets.json");
}

// LƯU Ý: mọi ghi vào assets.json PHẢI đi qua writeAssetEntry (merge từng field).
// Cặp readAssetDescriptions/writeAssetDescription cũ đã bị xóa vì rebuild cả file
// chỉ với description → xóa trắng colorGrade/colorAdjust của mọi asset.

/** Liệt kê asset của project (bỏ assets.json), merge description + colorGrade từ assets.json */
export function listProjectAssets(id: string): FileInfoWithDescription[] {
  const files = listFilesRecursive(projectAssetsDirOf(id)).filter(
    (f) => f.name !== "assets.json",
  );
  const entries = readAssetEntries(id);
  return files.map((f) => {
    const e = entries[f.name];
    if (!e) return f;
    const out: FileInfoWithDescription = { ...f };
    if (e.description !== undefined) out.description = e.description;
    if (e.colorGrade !== undefined) out.colorGrade = e.colorGrade;
    if (e.colorAdjust !== undefined) out.colorAdjust = e.colorAdjust;
    if (e.sceneOrder !== undefined) out.sceneOrder = e.sceneOrder;
    if (e.sceneRole !== undefined) out.sceneRole = e.sceneRole;
    return out;
  });
}

/** Quét video-projects/<id>/meta.json → danh sách summary, mới cập nhật trước */
export function scanProjects(): ProjectSummary[] {
  if (!fs.existsSync(paths.videoProjectsDir)) return [];
  const out: ProjectSummary[] = [];
  for (const entry of fs.readdirSync(paths.videoProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!fs.existsSync(metaPathOf(entry.name))) continue;
    const summary = projectSummaryOf(entry.name);
    if (summary) out.push(summary);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}
