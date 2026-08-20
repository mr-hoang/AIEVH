import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { childEnv } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * Chỉnh màu video - preset dùng CHUNG cho preview (1 frame) và khi AI áp toàn bài.
 * Nguyên tắc: preview phải ra đúng kết quả cuối → mọi nơi đều dùng filter chain ở đây.
 * (Xem skill color-grading.)
 */

export interface GradePreset {
  id: string;
  label: string;
  /** Chuỗi -vf của FFmpeg */
  filter: string;
}

export const GRADE_PRESETS: GradePreset[] = [
  { id: "tu-nhien", label: "Tự nhiên", filter: "eq=contrast=1.06:saturation=1.12" },
  {
    id: "tuoi-sang",
    label: "Tươi sáng",
    filter: "eq=brightness=0.03:contrast=1.08:saturation=1.22,vibrance=intensity=0.15",
  },
  {
    id: "vivid",
    label: "Rực rỡ",
    filter: "eq=contrast=1.12:saturation=1.3,vibrance=intensity=0.25",
  },
  {
    id: "cinematic",
    label: "Cinematic",
    filter:
      "curves=master='0/0 0.25/0.22 0.75/0.78 1/1',colorbalance=rs=0.05:bs=-0.05:rm=0.03:bm=-0.02:rh=-0.02:bh=0.04,eq=saturation=1.05",
  },
  {
    id: "teal-orange",
    label: "Teal & Orange",
    filter:
      "colorbalance=rs=0.12:bs=-0.10:rm=0.05:bm=-0.04:rh=-0.06:bh=0.10,eq=contrast=1.1:saturation=1.1",
  },
  {
    id: "film-vintage",
    label: "Film Vintage",
    filter:
      "curves=master='0/0.06 0.3/0.3 0.7/0.72 1/0.94',colorbalance=rh=0.05:bh=-0.06,eq=saturation=0.85:contrast=1.02",
  },
  {
    id: "mau-phim",
    label: "Matte Film",
    filter: "curves=master='0/0.05 1/0.97',eq=contrast=1.05:saturation=0.9",
  },
  {
    id: "golden-hour",
    label: "Golden Hour",
    filter:
      "colortemperature=temperature=4800,colorbalance=rm=0.06:bm=-0.04,eq=saturation=1.1:brightness=0.02",
  },
  { id: "am", label: "Ấm", filter: "colortemperature=temperature=5200,eq=saturation=1.08" },
  { id: "lanh", label: "Lạnh", filter: "colortemperature=temperature=8200,eq=saturation=1.05" },
  {
    id: "dem-xanh",
    label: "Đêm xanh",
    filter:
      "colortemperature=temperature=9000,colorbalance=bs=0.08,eq=brightness=-0.03:contrast=1.1:saturation=0.95",
  },
  {
    id: "moody",
    label: "Moody",
    filter: "eq=brightness=-0.04:contrast=1.18:saturation=0.8,colorbalance=bs=0.05",
  },
  {
    id: "pastel",
    label: "Pastel",
    filter:
      "eq=brightness=0.05:contrast=0.92:saturation=0.85,colorbalance=rh=0.03:bh=0.03",
  },
  { id: "den-trang", label: "Đen trắng", filter: "hue=s=0,eq=contrast=1.15" },
];

/** Thông số chỉnh tay - cộng CHỒNG lên preset. Giá trị mặc định = không đổi gì. */
export interface GradeAdjust {
  /** -0.3..0.3, mặc định 0 */
  brightness: number;
  /** 0.7..1.4, mặc định 1 */
  contrast: number;
  /** 0..2, mặc định 1 */
  saturation: number;
  /** 0.7..1.4, mặc định 1 */
  gamma: number;
  /** 4000..9500 (K), mặc định 6500 = không đổi */
  temperature: number;
  /** -0.5..0.5, mặc định 0 */
  vibrance: number;
}

export const DEFAULT_ADJUST: GradeAdjust = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 1,
  temperature: 6500,
  vibrance: 0,
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Chuẩn hóa object adjust từ input không tin cậy (thiếu field → default, kẹp range) */
export function normAdjust(raw: unknown): GradeAdjust {
  const base = { ...DEFAULT_ADJUST };
  if (!raw || typeof raw !== "object") return base;
  const a = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  base.brightness = clamp(num(a.brightness, 0), -0.3, 0.3);
  base.contrast = clamp(num(a.contrast, 1), 0.7, 1.4);
  base.saturation = clamp(num(a.saturation, 1), 0, 2);
  base.gamma = clamp(num(a.gamma, 1), 0.7, 1.4);
  base.temperature = clamp(num(a.temperature, 6500), 4000, 9500);
  base.vibrance = clamp(num(a.vibrance, 0), -0.5, 0.5);
  return base;
}

export function isDefaultAdjust(a: GradeAdjust): boolean {
  return (
    a.brightness === 0 &&
    a.contrast === 1 &&
    a.saturation === 1 &&
    a.gamma === 1 &&
    a.temperature === 6500 &&
    a.vibrance === 0
  );
}

/** Chuỗi filter cho phần chỉnh tay - rỗng nếu toàn giá trị mặc định */
export function adjustFilter(a: GradeAdjust): string {
  const parts: string[] = [];
  const eq: string[] = [];
  if (a.brightness !== 0) eq.push(`brightness=${a.brightness}`);
  if (a.contrast !== 1) eq.push(`contrast=${a.contrast}`);
  if (a.saturation !== 1) eq.push(`saturation=${a.saturation}`);
  if (a.gamma !== 1) eq.push(`gamma=${a.gamma}`);
  if (eq.length) parts.push(`eq=${eq.join(":")}`);
  if (a.temperature !== 6500) parts.push(`colortemperature=temperature=${Math.round(a.temperature)}`);
  if (a.vibrance !== 0) parts.push(`vibrance=intensity=${a.vibrance}`);
  return parts.join(",");
}

/** Tonemap HDR/HLG → SDR Rec.709 - chèn TRƯỚC preset khi footage là HDR/log */
export const TONEMAP_FILTER =
  "zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p";

export interface ColorInfo {
  transfer: string | null;
  primaries: string | null;
  /** HDR/HLG/log - cần tonemap/delog trước khi chỉnh màu */
  needsTonemap: boolean;
  durationSec: number | null;
}

/** Đọc metadata màu + duration bằng ffprobe */
export async function probeColorInfo(fileAbs: string): Promise<ColorInfo> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=color_transfer,color_primaries:format=duration",
        "-of", "json",
        fileAbs,
      ],
      // env: ffmpeg/ffprobe ghi file tạm - dồn về .runtime/tmp (xem childEnv)
      { windowsHide: true, env: childEnv() },
    );
    const data = JSON.parse(stdout) as {
      streams?: Array<{ color_transfer?: string; color_primaries?: string }>;
      format?: { duration?: string };
    };
    const transfer = data.streams?.[0]?.color_transfer ?? null;
    const primaries = data.streams?.[0]?.color_primaries ?? null;
    const durationSec = data.format?.duration ? parseFloat(data.format.duration) : null;
    // HLG (arib-std-b67), PQ/HDR10 (smpte2084) hoặc gamut bt2020 → cần tonemap
    const needsTonemap =
      transfer === "arib-std-b67" ||
      transfer === "smpte2084" ||
      primaries === "bt2020";
    return { transfer, primaries, needsTonemap, durationSec };
  } catch {
    return { transfer: null, primaries: null, needsTonemap: false, durationSec: null };
  }
}

/**
 * Chuỗi -vf hoàn chỉnh: tonemap (nếu cần) → preset → chỉnh tay.
 * presetId null + adjust mặc định = nguyên bản (chỉ tonemap nếu có).
 */
export function buildFilterChain(
  presetId: string | null,
  needsTonemap: boolean,
  adjust?: GradeAdjust,
): string | null {
  const preset = presetId ? GRADE_PRESETS.find((p) => p.id === presetId) : null;
  const parts: string[] = [];
  if (needsTonemap) parts.push(TONEMAP_FILTER);
  if (preset) parts.push(preset.filter);
  if (adjust) {
    const extra = adjustFilter(adjust);
    if (extra) parts.push(extra);
  }
  return parts.length ? parts.join(",") : null;
}

/**
 * Render MỘT frame theo preset + chỉnh tay - phục vụ preview to và slider trên UI.
 * Trả relPath (repo root) của PNG trong cache của project.
 */
export async function renderGradeFrame(
  projectDir: string,
  projectRelDir: string,
  videoAbs: string,
  fileName: string,
  presetId: string | null,
  adjust: GradeAdjust,
): Promise<{ relPath: string }> {
  const info = await probeColorInfo(videoAbs);
  const t = info.durationSec ? Math.max(0.5, info.durationSec / 3) : 1;
  const outDir = path.join(projectDir, "cache", "grade-preview", fileName);
  fs.mkdirSync(outDir, { recursive: true });

  // Tên file ổn định theo tham số - trùng thì trả cache luôn, không render lại
  const key = JSON.stringify({ p: presetId, a: adjust });
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const outName = `custom-${hash.toString(36)}.png`;
  const outAbs = path.join(outDir, outName);
  const relPath = `${projectRelDir}/cache/grade-preview/${fileName}/${outName}`;
  if (fs.existsSync(outAbs)) return { relPath };

  const chain = buildFilterChain(presetId, info.needsTonemap, adjust);
  const scale = "scale='min(720,iw)':-2";
  const vf = chain ? `${chain},${scale}` : scale;
  await execFileAsync(
    "ffmpeg",
    ["-y", "-v", "error", "-ss", String(t), "-i", videoAbs, "-vf", vf, "-frames:v", "1", outAbs],
    { windowsHide: true, env: childEnv() },
  );
  return { relPath };
}

/**
 * Sinh ảnh preview: 1 frame gốc + 1 frame mỗi preset (kèm tonemap nếu footage HDR/log).
 * Ghi vào <projectDir>/.cache/grade-preview/<tên-file>/ - trả đường dẫn tương đối repo root.
 */
export async function generateGradePreviews(
  projectDir: string,
  projectRelDir: string,
  videoAbs: string,
  fileName: string,
): Promise<{ info: ColorInfo; previews: Array<{ preset: string | null; label: string; relPath: string }> }> {
  const info = await probeColorInfo(videoAbs);
  const t = info.durationSec ? Math.max(0.5, info.durationSec / 3) : 1;
  // KHÔNG dùng ".cache" (dotfolder) - express.static mặc định chặn dotfiles khi serve /media
  const outDir = path.join(projectDir, "cache", "grade-preview", fileName);
  fs.mkdirSync(outDir, { recursive: true });

  const variants: Array<{ preset: string | null; label: string; out: string }> = [
    { preset: null, label: info.needsTonemap ? "Gốc (đã delog)" : "Gốc", out: "goc.png" },
    ...GRADE_PRESETS.map((p) => ({ preset: p.id as string | null, label: p.label, out: `${p.id}.png` })),
  ];

  const previews: Array<{ preset: string | null; label: string; relPath: string }> = [];
  for (const v of variants) {
    const chain = buildFilterChain(v.preset, info.needsTonemap);
    const args = ["-y", "-v", "error", "-ss", String(t), "-i", videoAbs];
    if (chain) args.push("-vf", chain);
    // Scale nhỏ cho preview nhanh + nhẹ (giữ tỉ lệ)
    const scale = "scale='min(720,iw)':-2";
    const vfIndex = args.indexOf("-vf");
    if (vfIndex >= 0) args[vfIndex + 1] = `${args[vfIndex + 1]},${scale}`;
    else args.push("-vf", scale);
    args.push("-frames:v", "1", path.join(outDir, v.out));
    try {
      await execFileAsync("ffmpeg", args, { windowsHide: true, env: childEnv() });
      previews.push({
        preset: v.preset,
        label: v.label,
        relPath: `${projectRelDir}/cache/grade-preview/${fileName}/${v.out}`,
      });
    } catch {
      // Preset lỗi (filter thiếu trong bản ffmpeg) → bỏ qua preset đó, không chặn cả preview
    }
  }
  return { info, previews };
}
