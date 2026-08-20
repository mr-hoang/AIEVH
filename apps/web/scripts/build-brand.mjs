#!/usr/bin/env node
/**
 * Nướng logo + favicon của AIEV - Mr Hoàng vào mã nguồn dưới dạng data URI.
 *
 * Đọc  : apps/web/public/brand/*.png   (ảnh gốc, độ phân giải cao - nguồn sự thật)
 * Ghi  : apps/web/src/lib/brand.ts     (hằng số base64, file SINH RA - đừng sửa tay)
 * Chạy : node scripts/build-brand.mjs  (chỉ khi thay logo, KHÔNG nằm trong build)
 *
 * VÌ SAO NƯỚNG VÀO CODE:
 * Nhận diện của chính ứng dụng phải luôn nhất quán. Để ở dạng file
 * tĩnh trong public/ thì chỉ cần chép đè ba cái PNG là đổi được logo cả app.
 * Thành hằng số biên dịch vào bundle thì thay ảnh trong public/ không còn tác
 * dụng gì nữa - muốn đổi phải sửa nguồn rồi chạy lại script này.
 *
 * Lưu ý: logo mà NGƯỜI DÙNG tải lên trong Style Design là chuyện hoàn toàn
 * khác. Cái đó nằm ở assets/styles/files/, đi qua đường /media/ của backend, và
 * chỉ dùng để đóng dấu lên VIDEO. Hai đường không hề đụng nhau - kiểm lại bằng
 * cách grep "/brand/" trong apps/server: không có kết quả nào.
 *
 * VÌ SAO PHẢI THU NHỎ TRƯỚC KHI MÃ HÓA:
 * Ảnh gốc là 3577x1056 (logo) và 1000x1000 (favicon), trong khi chỗ hiển thị
 * chỉ cao 28px và 16-32px - to gấp mấy chục lần mức cần. Nướng nguyên cỡ đó
 * thành base64 là nhét 280KB chuỗi vào bundle, đổi một vấn đề lấy một vấn đề
 * tệ hơn. Thu về đúng cỡ (gấp 3 lần cỡ hiển thị cho màn hình nét cao) thì tổng
 * còn khoảng 21KB - NHẸ HƠN cả cách tải ba file rời như trước.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const SRC = join(WEB, "public", "brand");
const OUT = join(WEB, "src", "lib", "brand.ts");

/**
 * Chiều cao đích = 3x chiều cao hiển thị thật.
 * - Logo hiện ở `h-7` (28px) trên topbar → 84px.
 * - Favicon: 64px phủ đủ mọi cỡ trình duyệt dùng (16/32/48).
 * Đổi chỗ hiển thị thì sửa luôn số ở đây rồi chạy lại script.
 */
const JOBS = [
  { file: "logo-duong-ban.png", name: "LOGO_LIGHT", height: 84 },
  { file: "logo-am-ban.png", name: "LOGO_DARK", height: 84 },
  { file: "favicon.png", name: "FAVICON", height: 64 },
];

const parts = [];
let total = 0;

for (const job of JOBS) {
  const original = await readFile(join(SRC, job.file));
  const resized = await sharp(original)
    .resize({ height: job.height, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  const { width, height } = await sharp(resized).metadata();
  const b64 = resized.toString("base64");
  total += b64.length;

  parts.push({ ...job, width, height, b64, bytes: resized.length });
  console.log(
    `${job.file.padEnd(20)} -> ${width}x${height}  ` +
      `${(original.length / 1024).toFixed(1)}KB -> ${(resized.length / 1024).toFixed(1)}KB`
  );
}

const body = `// FILE NÀY DO MÁY SINH RA - ĐỪNG SỬA TAY.
// Nguồn: apps/web/public/brand/*.png
// Tạo lại: cd apps/web && node scripts/build-brand.mjs
//
// Logo và favicon của chính ứng dụng, nướng thẳng vào bundle dưới dạng data URI
// để nhận diện ứng dụng không đổi ngoài ý muốn bằng cách chép đè file trong public/.
// Logo người dùng tải lên ở Style Design là đường hoàn toàn khác (assets/styles,
// phục vụ qua /media, chỉ dùng đóng dấu lên video) - xem scripts/build-brand.mjs.

${parts
  .map(
    (p) =>
      `/** ${p.file} - ${p.width}x${p.height}, ${(p.bytes / 1024).toFixed(1)}KB */\n` +
      `export const ${p.name} =\n  "data:image/png;base64,${p.b64}";`
  )
  .join("\n\n")}
`;

await writeFile(OUT, body, "utf8");
console.log(
  `\nĐã ghi ${OUT}\ntổng base64: ${(total / 1024).toFixed(1)}KB`
);
