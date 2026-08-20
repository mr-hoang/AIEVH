import { z } from "zod";
import { posterDesignSchema } from "./posterManifest";

/**
 * Schema props của composition still `Thumbnail` — ảnh bìa cho một video đã
 * render: nền do Gemini vẽ (hoặc gradient từ Style Design) + FRAME cắt từ
 * chính video (card bo góc) + title rất lớn theo font/màu của style.
 *
 * Khác `Poster` (posterManifest.ts): Poster là ảnh quảng cáo tự do
 * (subtitle/stats/CTA), Thumbnail luôn có card frame video + một title duy
 * nhất, nên tách composition riêng thay vì nhồi thêm nhánh vào Poster.
 *
 * Nguyên tắc giống manifest.ts / posterManifest.ts:
 * - `z.looseObject` (passthrough) — backend ghi thêm field lạ vẫn parse qua.
 * - `background` / `frame` là đường dẫn TƯƠNG ĐỐI trong public/staging
 *   (stage bằng hardlink) — chỉ load qua `staticFile()`.
 * - `design` dùng CHUNG schema với Poster (colors/fonts/fontFiles/effects/
 *   logoFile/brandName) — server đổ thẳng Style Design đã resolve vào đây.
 */

export const thumbnailAspectSchema = z.enum(["9:16", "16:9", "1:1", "4:5"]);
export type ThumbnailAspect = z.infer<typeof thumbnailAspectSchema>;

export const THUMBNAIL_DIMENSIONS: Record<
  ThumbnailAspect,
  { width: number; height: number }
> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

export const thumbnailSchema = z.looseObject({
  aspect: thumbnailAspectSchema.default("9:16"),
  /** Ảnh nền (Gemini) trong public/staging. null = nền gradient từ design.colors. */
  background: z.string().nullable().default(null),
  /** Frame cắt từ video (ffmpeg) trong public/staging. null = không vẽ card frame. */
  frame: z.string().nullable().default(null),
  /** Title giật tít — chữ rất lớn, font heading của style. */
  title: z.string().default(""),
  /** Style Design đã resolve (cùng hợp đồng với Poster — docs/API.md). */
  design: posterDesignSchema.prefault({}),
});

export type ThumbnailDesign = z.infer<typeof posterDesignSchema>;
export type ThumbnailProps = z.infer<typeof thumbnailSchema>;
