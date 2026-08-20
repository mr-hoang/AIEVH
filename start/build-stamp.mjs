#!/usr/bin/env node
/**
 * Dấu vân tay của MÃ NGUỒN - để script khởi động biết chắc bản đang chạy có
 * đúng là bản dựng từ code hiện tại hay không.
 *
 * VÌ SAO CẦN: trước đây start.ps1 và start.sh đoán bằng cách so thời gian sửa
 * file giữa `src` và `.next`/`dist`. Hai lỗi chết người:
 *
 *   1. `next start` GHI CACHE vào chính `.next` lúc đang chạy (tối ưu ảnh,
 *      fetch cache), nên `.next` luôn trông mới hơn `src` - sửa code thật xong
 *      script vẫn kết luận "không có gì mới", không build lại.
 *   2. Bản .sh còn so với mtime của THƯ MỤC `.next`, thứ chỉ đổi khi thêm/xóa
 *      file con trực tiếp - gần như không bao giờ phát hiện được thay đổi.
 *
 * Và một lỗi thứ ba nằm ở chỗ khác: hai script chỉ hỏi "cổng 6868 có ai trả
 * lời không". Người dùng lỡ chạy `npm run dev` trước đó thì dev server trả lời,
 * script tưởng hệ thống đã sẵn sàng rồi mở trình duyệt vào đúng cái bản CŨ đang
 * nằm trong bộ nhớ. File này cộng với `run.json` (do script khởi động ghi) là
 * để cả ba chuyện đó không xảy ra nữa.
 *
 * Dùng chung một logic cho Windows/macOS/Linux, đúng cách doctor.mjs đang làm -
 * ba nơi tự tính riêng là ba nơi sẽ lệch nhau.
 *
 * Cách dùng:
 *   node start/build-stamp.mjs --print          in dấu vân tay hiện tại
 *   node start/build-stamp.mjs --save           ghi vào .aiev/build.json
 *   node start/build-stamp.mjs --check          exit 0 nếu khớp, 1 nếu lệch
 */

import { createHash } from "node:crypto";
import {
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(ROOT, ".aiev");
const BUILD_FILE = join(STATE_DIR, "build.json");

/**
 * Thứ gì đổi thì PHẢI build lại. Cố ý KHÔNG gồm `renders/`, `outputs/`,
 * `video-projects/`… - đó là dữ liệu người dùng, đổi liên tục và không liên
 * quan gì tới bản build.
 */
const WATCH_DIRS = [
  "apps/server/src",
  "apps/web/src",
  "apps/web/public",
  "engines/remotion/src",
];

const WATCH_FILES = [
  "package.json",
  "package-lock.json",
  "apps/server/package.json",
  "apps/server/tsconfig.json",
  "apps/web/package.json",
  "apps/web/tsconfig.json",
  "apps/web/next.config.ts",
  "apps/web/next.config.js",
  "apps/web/next.config.mjs",
  "apps/web/postcss.config.mjs",
  "apps/web/postcss.config.js",
];

/** Bỏ qua rác không ảnh hưởng bản build */
const SKIP_DIR = new Set(["node_modules", ".next", "dist", ".git", ".turbo"]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // thư mục không tồn tại (vd engines/remotion/src) - bỏ qua
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function computeStamp() {
  const files = [];
  for (const d of WATCH_DIRS) walk(join(ROOT, d), files);
  for (const f of WATCH_FILES) {
    const p = join(ROOT, f);
    if (existsSync(p)) files.push(p);
  }

  // Sắp xếp để thứ tự đọc thư mục của hệ điều hành không làm đổi kết quả.
  files.sort();

  const h = createHash("sha1");
  for (const f of files) {
    const s = statSync(f);
    // mtime + size là đủ: nội dung đổi thì ít nhất một trong hai đổi theo, mà
    // đọc hết nội dung vài nghìn file mỗi lần khởi động thì quá chậm.
    h.update(relative(ROOT, f).replace(/\\/g, "/"));
    h.update("|");
    h.update(String(Math.floor(s.mtimeMs)));
    h.update("|");
    h.update(String(s.size));
    h.update("\n");
  }
  return `${files.length}-${h.digest("hex").slice(0, 16)}`;
}

function readSaved() {
  try {
    return JSON.parse(readFileSync(BUILD_FILE, "utf8")).stamp ?? null;
  } catch {
    return null;
  }
}

const mode = process.argv[2] ?? "--print";

if (mode === "--print") {
  process.stdout.write(computeStamp());
} else if (mode === "--save") {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    BUILD_FILE,
    JSON.stringify({ stamp: computeStamp(), at: new Date().toISOString() }, null, 2)
  );
  process.stdout.write("saved");
} else if (mode === "--check") {
  const saved = readSaved();
  process.exit(saved !== null && saved === computeStamp() ? 0 : 1);
} else {
  process.stderr.write(`Khong hieu tham so: ${mode}\n`);
  process.exit(2);
}
