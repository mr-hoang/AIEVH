import { z } from "zod";

/**
 * Schema props của composition still `Poster` (xem docs/API.md mục
 * "Image Projects"). Server truyền props qua file JSON khi chạy:
 *   npx remotion still Poster --props=<file.json> --output=out.png
 *
 * Nguyên tắc giống manifest.ts:
 * - `z.looseObject` (passthrough) — backend ghi thêm field lạ vẫn parse qua.
 * - Đường dẫn media (background, design.logoFile) là đường dẫn TƯƠNG ĐỐI
 *   trong public/staging (server stage bằng hardlink) — chỉ load qua
 *   `staticFile()`, không bao giờ đọc đường dẫn tuyệt đối.
 * - Mọi field overlay đều có default rỗng — field nào rỗng thì Poster.tsx
 *   bỏ qua phần đó, không vẽ khối trống.
 */

export const posterAspectSchema = z.enum(["9:16", "16:9", "1:1", "4:5"]);
export type PosterAspect = z.infer<typeof posterAspectSchema>;

/** Kích thước canvas theo aspect (docs/API.md). */
export const POSTER_DIMENSIONS: Record<PosterAspect, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

export const posterStatSchema = z.looseObject({
  label: z.string().default(""),
  value: z.string().default(""),
});

export const posterColorsSchema = z.looseObject({
  primary: z.string().default("#3b82f6"),
  secondary: z.string().default("#1e293b"),
  background: z.string().default("#0b1220"),
  text: z.string().default("#f8fafc"),
  accent: z.string().default("#22d3ee"),
});

export const posterFontsSchema = z.looseObject({
  /**
   * Tên font từ Design System. Render offline nên KHÔNG load webfont từ mạng —
   * Poster.tsx luôn nối thêm stack hệ thống an toàn phía sau
   * (Inter, 'Segoe UI', Roboto, sans-serif) để tiếng Việt đủ dấu.
   * Font brand THẬT nạp qua `fontFiles` (file cục bộ trong public/staging).
   */
  heading: z.string().default("Inter"),
  body: z.string().default("Inter"),
});

export const posterFontFilesSchema = z.looseObject({
  /**
   * Đường dẫn staging của file font brand (woff2/woff/otf/ttf), vd
   * "staging/img-abc/inter-bold.woff2". null = không có file → Poster.tsx
   * rơi về design.fonts.* + stack hệ thống. Load qua staticFile() +
   * loadFont() của @remotion/fonts (offline, delayRender tự động).
   */
  heading: z.string().nullable().default(null),
  body: z.string().nullable().default(null),
});

/** Hiệu ứng thẩm mỹ từ Style Design — gradient chữ highlight, chip liquid glass */
export const posterEffectsSchema = z.looseObject({
  gradient: z.boolean().default(true),
  liquidGlass: z.boolean().default(true),
});

export const posterDesignSchema = z.looseObject({
  colors: posterColorsSchema.prefault({}),
  fonts: posterFontsSchema.prefault({}),
  fontFiles: posterFontFilesSchema.prefault({}),
  effects: posterEffectsSchema.prefault({}),
  /** Đường dẫn staging của logo, vd "staging/img-abc/logo.png". null = không có. */
  logoFile: z.string().nullable().default(null),
  brandName: z.string().default(""),
});

/**
 * Vị trí khối chữ - lưới 3x3. "auto" giữ đúng bố cục trước khi có tùy chọn này
 * (ngang → giữa-trái, vuông → đáy-giữa, dọc → đáy-trái) nên project cũ render
 * lại vẫn ra y hệt. Phải khớp IMAGE_TEXT_POSITIONS ở apps/server/src/imageMeta.ts.
 */
export const posterTextPositionSchema = z.enum([
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
]);
export type PosterTextPosition = z.infer<typeof posterTextPositionSchema>;

export const posterOverlaySchema = z.looseObject({
  title: z.string().default(""),
  subtitle: z.string().default(""),
  stats: z.array(posterStatSchema).default([]),
  cta: z.string().default(""),
  showLogo: z.boolean().default(true),
  position: posterTextPositionSchema.default("auto"),
});

export const posterSchema = z.looseObject({
  aspect: posterAspectSchema.default("1:1"),
  /** Đường dẫn staging của ảnh nền. null = dựng nền gradient từ design.colors. */
  background: z.string().nullable().default(null),
  design: posterDesignSchema.prefault({}),
  overlay: posterOverlaySchema.prefault({}),
});

export type PosterStat = z.infer<typeof posterStatSchema>;
export type PosterFontFiles = z.infer<typeof posterFontFilesSchema>;
export type PosterDesign = z.infer<typeof posterDesignSchema>;
export type PosterOverlay = z.infer<typeof posterOverlaySchema>;
export type PosterProps = z.infer<typeof posterSchema>;
