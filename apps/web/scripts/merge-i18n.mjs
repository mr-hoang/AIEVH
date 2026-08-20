/**
 * Gộp các key i18n do agent tạo (mỗi agent ghi một file riêng để không giẫm
 * chân nhau) vào vi.ts / en.ts. Dùng một lần cho đợt đại tu giao diện 8/2026;
 * giữ lại vì lần sau chạy nhiều agent song song lại cần đúng cách này.
 *
 * node scripts/merge-i18n.mjs <đường-dẫn-thư-mục-chứa-i18n-*.json>
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("Thiếu tham số: thư mục chứa các file i18n-*.json");
  process.exit(1);
}

const merged = {};
for (const f of readdirSync(dir).filter((f) => /^i18n-.*\.json$/.test(f))) {
  const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
  for (const [k, v] of Object.entries(j)) {
    if (merged[k] && JSON.stringify(merged[k]) !== JSON.stringify(v)) {
      console.log(`XUNG ĐỘT: ${k} (${f})`);
    }
    merged[k] = v;
  }
}

// common.no-results đã được gộp vào common.no-match trước đó (hai agent đặt
// hai key cho cùng một câu "không tìm thấy gì").
delete merged["common.no-results"];
merged["common.no-match"] = {
  vi: "Không có mục nào khớp với tìm kiếm hoặc bộ lọc hiện tại.",
  en: "Nothing matches the current search or filters.",
};

const esc = (s) =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const HEADER = {
  vi: "\n  // ===== Đại tu giao diện 8/2026: tìm kiếm, lọc, trạng thái rỗng, chú thích =====\n",
  en: "\n  // ===== Aug 2026 UI overhaul: search, filters, empty states, hints =====\n",
};

for (const [lang, file] of [
  ["vi", "src/lib/locales/vi.ts"],
  ["en", "src/lib/locales/en.ts"],
]) {
  let src = readFileSync(file, "utf8");
  const lines = Object.entries(merged)
    .filter(([k]) => !src.includes(`"${k}":`))
    .map(([k, v]) => `  "${k}": "${esc(v[lang])}",`);

  if (lines.length === 0) {
    console.log(`${lang}: không có key mới`);
    continue;
  }
  const i = src.lastIndexOf("};");
  src = src.slice(0, i) + HEADER[lang] + lines.join("\n") + "\n" + src.slice(i);
  writeFileSync(file, src);
  console.log(`${lang}: đã thêm ${lines.length} key`);
}
