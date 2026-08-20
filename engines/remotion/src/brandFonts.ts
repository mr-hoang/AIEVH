import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

/**
 * Nạp font BRAND thật từ file trong public/staging bằng @remotion/fonts.
 *
 * Cách chính thống của @remotion/fonts là gọi `loadFont()` như một promise
 * top-level — hàm này tự lo delayRender/continueRender/cancelRender bên trong
 * (xem load-font.js trong package @remotion/fonts). Vì URL font đến từ props (mỗi render
 * một brand khác nhau) nên không thể gọi ở top-level module; thay vào đó
 * Poster.tsx gọi `ensureBrandFont()` ngay trong thân component — vẫn là cùng
 * promise đó, chỉ khác thời điểm. Cache module-level đảm bảo mỗi cặp
 * (family, file) chỉ loadFont đúng một lần dù component render lại nhiều lần.
 *
 * Offline hoàn toàn: file đọc qua staticFile() từ public/, không chạm mạng.
 */

/** Tên family cố định đăng ký cho font brand — Poster.tsx tham chiếu trong fontFamily. */
export const BRAND_HEADING_FAMILY = "BrandHeading";
export const BRAND_BODY_FAMILY = "BrandBody";

type FontFormat = "woff2" | "woff" | "opentype" | "truetype";

/** Suy format từ đuôi file — đuôi lạ → null (bỏ qua, không cancelRender cả poster). */
const formatFromExtension = (file: string): FontFormat | null => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "woff2":
      return "woff2";
    case "woff":
      return "woff";
    case "otf":
      return "opentype";
    case "ttf":
      return "truetype";
    default:
      return null;
  }
};

/**
 * Suy weight từ tên file (vd "inter-bold.woff2" → 700, "inter-700-normal" → 700).
 * Không đoán được → undefined (FontFace mặc định 400; CSS vẫn match family và
 * tự synthesize đậm/nhạt nên chữ luôn dùng font brand).
 */
const WEIGHT_NAMES: Record<string, string> = {
  thin: "100",
  hairline: "100",
  extralight: "200",
  ultralight: "200",
  light: "300",
  regular: "400",
  normal: "400",
  medium: "500",
  semibold: "600",
  demibold: "600",
  extrabold: "800",
  ultrabold: "800",
  bold: "700",
  black: "900",
  heavy: "900",
};

const weightFromFilename = (file: string): string | undefined => {
  const base = (file.split("/").pop() ?? file).toLowerCase().replace(/\.[a-z0-9]+$/, "");
  // Số 100-900 đứng riêng giữa các dấu phân cách (inter-700-normal, Inter_400).
  const numeric = base.match(/(?:^|[^0-9])([1-9]00)(?:[^0-9]|$)/);
  if (numeric) return numeric[1];
  // Tên weight — thử từ dài đến ngắn để "extrabold" không match nhầm "bold".
  const names = Object.keys(WEIGHT_NAMES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (base.includes(name)) return WEIGHT_NAMES[name];
  }
  return undefined;
};

/** Cache (family + file) đã kích hoạt loadFont — tránh nạp lặp khi re-render. */
const requested = new Set<string>();

/**
 * Kích hoạt nạp font brand nếu có file. Trả về true nếu font ĐANG/ĐÃ được nạp
 * (caller thêm family vào đầu font stack), false nếu không có file hợp lệ.
 * Idempotent — an toàn khi gọi mỗi lần render.
 */
export const ensureBrandFont = (family: string, file: string | null | undefined): boolean => {
  if (!file || file.trim() === "") return false;
  const format = formatFromExtension(file);
  if (!format) {
    // eslint-disable-next-line no-console
    console.warn(`[Poster] Bỏ qua font brand "${file}": đuôi file không hỗ trợ (cần woff2/woff/otf/ttf).`);
    return false;
  }
  const key = `${family}::${file}`;
  if (!requested.has(key)) {
    requested.add(key);
    // loadFont tự delayRender/continueRender; lỗi load → cancelRender với
    // message rõ ràng (file hỏng/thiếu là lỗi backend cần thấy ngay).
    void loadFont({
      family,
      url: staticFile(file),
      format,
      weight: weightFromFilename(file),
    });
  }
  return true;
};
