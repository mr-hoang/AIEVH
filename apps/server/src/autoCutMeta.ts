import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { briefOf, defaultBrief, type Brief, type ProjectMeta } from "./meta.js";
import { HttpError, ensureDir, isKebabCase, nowIso } from "./util.js";

/**
 * "Auto cut videos" - cắt một video dài thành nhiều video ngắn, mỗi video ngắn
 * tự động trở thành một Videos Project dựng sẵn (không phải import lại).
 *
 * Trạng thái một phiên cắt nằm ở `auto-cut/<id>/meta.json` (đĩa là nguồn sự thật,
 * giống video-projects). SQLite chỉ giữ job của queue.
 *
 * Vòng đời: draft -> (job step "plan") planned -> (job step "cut") done
 * Bước plan và bước cut tách rời để người dùng DUYỆT danh sách đoạn trước khi
 * tốn thời gian cắt/encode.
 */

// ------------------------------------------------------------------ Kiểu dữ liệu

/** Cách chọn đoạn cắt */
export type AutoCutMode = "time" | "ai" | "prompt";
export const AUTO_CUT_MODES: AutoCutMode[] = ["time", "ai", "prompt"];

/** Tỉ lệ khung đầu ra - "keep" = giữ nguyên tỉ lệ nguồn */
export type AutoCutAspect = "keep" | "9:16" | "16:9" | "1:1" | "4:5";
export const AUTO_CUT_ASPECTS: AutoCutAspect[] = ["keep", "9:16", "16:9", "1:1", "4:5"];

/** Kích thước đích theo tỉ lệ (nguồn dọc/ngang đều quy về các khổ chuẩn này) */
export const ASPECT_SIZE: Record<Exclude<AutoCutAspect, "keep">, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/**
 * Cách đưa khung nguồn vào khung đích khi lệch tỉ lệ:
 * - "crop": cắt cúp bám CHỦ THỂ (nhân vật vào giữa khung). Hình đầy khung, chủ thể to,
 *   đổi lại mất phần rìa - hợp talking-head.
 * - "fit": thu nhỏ giữ trọn khung nguồn rồi lấp phần trống bằng nền - KHÔNG mất thông tin,
 *   hợp video có chữ/màn hình/slide.
 * - "auto": hỏi Gemini xem khung chủ yếu là người hay là chữ/màn hình rồi tự chọn crop/fit.
 */
export type AutoCutLayout = "auto" | "crop" | "fit";
export const AUTO_CUT_LAYOUTS: AutoCutLayout[] = ["auto", "crop", "fit"];

/** Nền lấp phần trống ở chế độ "fit" */
export type AutoCutBackground = "gemini" | "blur" | "style";
export const AUTO_CUT_BACKGROUNDS: AutoCutBackground[] = ["gemini", "blur", "style"];

export interface AutoCutSource {
  /** relPath tính từ repo root (thường trong imports/) */
  relPath: string;
  /** Kích thước SAU KHI giải mã (đã áp cờ xoay) - xem ghi chú rotation bên dưới */
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /**
   * Video quay bằng điện thoại hay có side-data `rotation`: ffprobe trả
   * width/height của luồng THÔ (vd 3840x2160) trong khi khung giải mã ra lại là
   * 2160x3840. Đã gặp thật với `20260731-164133.mp4` trong repo. Mọi phép tính
   * tỉ lệ/cắt cúp PHẢI dùng width/height ở trên (đã hoán đổi), không dùng số thô.
   */
  rotation: number;
}

export interface AutoCutOutput {
  aspect: AutoCutAspect;
  layout: AutoCutLayout;
  background: AutoCutBackground;
  /** Style Design áp cho nền Gemini + brief của project con (null = style mặc định) */
  styleId: string | null;
  /** fps đầu ra (null = giữ theo nguồn) */
  fps: number | null;
}

export interface AutoCutParams {
  /** mode "time": độ dài mỗi đoạn (phút) */
  minutes?: number;
  /** mode "time": phần chồng lấn giữa hai đoạn liền nhau (giây) */
  overlapSec?: number;
  /** mode "ai"/"prompt": số đoạn mong muốn */
  count?: number;
  /** mode "ai"/"prompt": khoảng độ dài mỗi đoạn (giây) */
  minSec?: number;
  maxSec?: number;
  /** mode "prompt": yêu cầu của người dùng về đoạn cần lấy */
  request?: string;
}

export interface AutoCutSegment {
  index: number;
  /** Giây tuyệt đối trong video nguồn */
  start: number;
  end: number;
  title: string;
  /** Chỉ có ở mode ai/prompt */
  hook?: string;
  reason?: string;
  score?: number;
  /** Người dùng bỏ tích đoạn này thì không cắt */
  selected: boolean;
  /** Điền sau khi cắt xong - id project con đã tạo */
  projectId?: string;
  /** Layout thực tế đã áp (mode "auto" quyết định lúc cắt) */
  appliedLayout?: Exclude<AutoCutLayout, "auto">;
}

export type AutoCutStatus =
  | "draft"
  | "planning"
  | "planned"
  | "cutting"
  | "done"
  | "failed";

export interface AutoCutMeta {
  id: string;
  name: string;
  status: AutoCutStatus;
  source: AutoCutSource;
  mode: AutoCutMode;
  params: AutoCutParams;
  output: AutoCutOutput;
  /**
   * Cấu hình edit áp cho MỌI project con cắt ra (đúng bộ field như Kịch bản edit
   * của Videos Project). Nhờ vậy video cắt xong là edit được ngay, không phải vào
   * từng project chỉnh lại.
   *
   * Ba field bị job ghi đè vì phụ thuộc từng đoạn: `sourceDescription` (mô tả đoạn),
   * `mainKey` (lấy tiêu đề đoạn khi user để trống), `notes` (hướng dẫn bắt buộc về
   * file đã cắt sẵn, ghi TRƯỚC rồi mới nối ghi chú của user).
   * `styleId` lấy từ `output.styleId` để chỉ có một nguồn sự thật.
   */
  brief: Brief;
  /** Có transcribe video nguồn không (mode ai/prompt luôn cần; mode time tùy chọn) */
  transcribe: boolean;
  /** Chạy phiên edit AI ngay sau khi tạo project con */
  autoEdit: boolean;
  /** relPath transcript đã tạo (nếu có) */
  transcriptRel?: string | null;
  segments: AutoCutSegment[];
  /** Lỗi gần nhất - hiện trên UI khi status = failed */
  error?: string | null;
  /**
   * Bước nào gây ra status "failed". CẦN THIẾT vì re-plan hỏng vẫn để nguyên
   * segments CŨ trong meta: chỉ nhìn "failed + có segments" là không đủ để cho
   * cắt lại (sẽ cắt theo kế hoạch cũ đã lỗi thời). Route /cut chỉ nhận lại
   * phiên failed khi failedStep === "cut". null/thiếu = không có lỗi (kể cả
   * bản ghi cũ trước khi có field này - các bản đó không cho retry tắt).
   */
  failedStep?: "plan" | "cut" | null;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ Đường dẫn

export function autoCutDirOf(id: string): string {
  return path.join(paths.autoCutDir, id);
}

export function autoCutMetaPathOf(id: string): string {
  return path.join(autoCutDirOf(id), "meta.json");
}

export function autoCutExists(id: string): boolean {
  return isKebabCase(id) && fs.existsSync(autoCutMetaPathOf(id));
}

// ------------------------------------------------------------------ Đọc/ghi

/**
 * Phiên tạo trước khi có field `brief` (hoặc file bị sửa tay) sẽ thiếu nó -
 * trả về defaultBrief để job không phải kiểm null ở mọi chỗ dùng.
 *
 * Chuẩn hóa bằng ĐÚNG `briefOf` của Videos Project chứ không spread thô: brief
 * đọc từ đĩa cần kiểm kiểu, và các luật vá tương thích ngược (vd phiên cũ có
 * `videoStyleId` nhưng chưa có công tắc `videoStyleEnabled`) chỉ được viết MỘT
 * lần ở đó - spread thô là mỗi lần thêm luật lại quên một nhánh.
 */
export function briefOfAutoCut(meta: AutoCutMeta): Brief {
  const raw = meta.brief as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultBrief();
  return briefOf({ brief: raw } as unknown as ProjectMeta);
}

export function readAutoCut(id: string): AutoCutMeta {
  if (!isKebabCase(id)) {
    throw new HttpError(400, "INVALID_AUTOCUT_ID", `Id phiên cắt không hợp lệ: ${id}`);
  }
  const file = autoCutMetaPathOf(id);
  if (!fs.existsSync(file)) {
    throw new HttpError(404, "AUTOCUT_NOT_FOUND", `Không tìm thấy phiên cắt "${id}"`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as AutoCutMeta;
  } catch {
    throw new HttpError(500, "AUTOCUT_META_INVALID", `meta.json của phiên cắt "${id}" hỏng`);
  }
}

export function writeAutoCut(meta: AutoCutMeta): void {
  meta.updatedAt = nowIso();
  ensureDir(autoCutDirOf(meta.id));
  fs.writeFileSync(
    autoCutMetaPathOf(meta.id),
    JSON.stringify(meta, null, 2) + "\n",
    "utf8",
  );
}

/** Sửa một phần meta rồi ghi lại - dùng trong job để cập nhật trạng thái từng bước */
export function patchAutoCut(id: string, patch: Partial<AutoCutMeta>): AutoCutMeta {
  const meta = readAutoCut(id);
  Object.assign(meta, patch);
  writeAutoCut(meta);
  return meta;
}

/** Danh sách phiên cắt, mới cập nhật trước */
export function scanAutoCuts(): AutoCutMeta[] {
  if (!fs.existsSync(paths.autoCutDir)) return [];
  const out: AutoCutMeta[] = [];
  for (const entry of fs.readdirSync(paths.autoCutDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(
        JSON.parse(
          fs.readFileSync(autoCutMetaPathOf(entry.name), "utf8"),
        ) as AutoCutMeta,
      );
    } catch {
      /* meta hỏng/thiếu - bỏ qua khỏi danh sách */
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

// ------------------------------------------------------------------ Tiện ích chung

/** Kích thước đầu ra thực tế theo aspect đã chọn và kích thước nguồn */
export function targetSizeOf(
  aspect: AutoCutAspect,
  source: { width: number; height: number },
): { width: number; height: number } {
  if (aspect === "keep") {
    // Ép về số chẵn - encoder H.264 yêu cầu chiều chia hết cho 2
    return {
      width: Math.max(2, Math.round(source.width / 2) * 2),
      height: Math.max(2, Math.round(source.height / 2) * 2),
    };
  }
  return ASPECT_SIZE[aspect];
}

/** Đoạn cắt theo thời gian cố định - dùng chung cho bước plan mode "time" */
export function planByTime(
  durationSec: number,
  minutes: number,
  overlapSec: number,
): Array<{ start: number; end: number }> {
  const chunk = Math.max(1, minutes) * 60;
  const overlap = Math.max(0, Math.min(overlapSec, chunk - 1));
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < durationSec - 0.5) {
    const end = Math.min(start + chunk, durationSec);
    out.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
    if (end >= durationSec) break;
    start = end - overlap;
  }
  // Đoạn cuối quá ngắn (< 25% chunk) thì gộp vào đoạn trước - tránh đẻ ra clip 5 giây cụt
  if (out.length >= 2) {
    const last = out[out.length - 1];
    if (last.end - last.start < chunk * 0.25) {
      out[out.length - 2].end = last.end;
      out.pop();
    }
  }
  return out;
}
