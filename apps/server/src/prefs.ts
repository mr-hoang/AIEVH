import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { ensureDir } from "./util.js";

/**
 * LỰA CHỌN GẦN NHẤT của người dùng, dùng làm mặc định cho project/phiên TẠO SAU.
 *
 * Vì sao có: mỗi lần tạo phiên dịch mới lại phải chọn lại đúng bộ đó - AI bóc
 * lời nào, dịch sang tiếng gì, cỡ chữ phụ đề bao nhiêu, engine đọc nào. Người
 * dùng làm mười video thì chọn lại mười lần y hệt nhau. Mặc định cứng trong mã
 * nguồn chỉ đúng cho video ĐẦU TIÊN của một người.
 *
 * Ranh giới cố ý:
 *  - CHỈ nhớ thứ mang tính "gu làm việc": ngôn ngữ, engine, kiểu chữ, tỉ lệ khung.
 *  - KHÔNG nhớ thứ thuộc về một video cụ thể: tên, prompt, nội dung, và nhất là
 *    map giọng theo người nói (`dub.voices` - người nói "1" của video này chẳng
 *    liên quan gì tới người nói "1" của video sau).
 *  - Ghi nhớ là việc PHỤ: hỏng file, hỏng quyền ghi, JSON rác - đều nuốt lỗi và
 *    chạy tiếp bằng mặc định. Không bao giờ để việc nhớ một lựa chọn làm hỏng
 *    thao tác chính của người dùng.
 *
 * Lưu ở data/prefs.json - cùng chỗ với render-settings.json, đã gitignore (đây
 * là thói quen của một người trên một máy, không phải dữ liệu của repo).
 */

/** Nhóm cấu hình - mỗi màn hình một khóa, không giẫm lên nhau */
export type PrefScope =
  | "translate-video"
  | "image"
  | "text-to-video"
  | "auto-cut"
  | "video-project";

type PrefBag = Record<string, unknown>;

const prefsFile = (): string => path.join(paths.dataDir, "prefs.json");

function readAll(): Record<string, PrefBag> {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, PrefBag>;
  } catch {
    // Chưa có file (lần chạy đầu) hoặc JSON hỏng - cả hai đều là "chưa nhớ gì"
    return {};
  }
}

/**
 * Lựa chọn đã nhớ của một nhóm. Trả object RỖNG khi chưa có gì - nơi gọi cứ
 * merge lên mặc định của mình, không phải kiểm tra null.
 */
export function getPrefs(scope: PrefScope): PrefBag {
  const bag = readAll()[scope];
  return bag && typeof bag === "object" && !Array.isArray(bag) ? bag : {};
}

/**
 * Nhớ thêm/ghi đè vài khóa trong một nhóm. `undefined` bị bỏ qua (nơi gọi cứ
 * truyền thẳng field tùy chọn vào, không phải lọc trước).
 *
 * Nuốt mọi lỗi ghi: đây là tiện ích, không phải dữ liệu người dùng - thà quên
 * một lựa chọn còn hơn làm hỏng cái PATCH mà người ta vừa bấm.
 */
export function rememberPrefs(scope: PrefScope, values: PrefBag): void {
  const clean: PrefBag = {};
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return;
  try {
    const all = readAll();
    all[scope] = { ...(all[scope] ?? {}), ...clean };
    ensureDir(paths.dataDir);
    fs.writeFileSync(prefsFile(), JSON.stringify(all, null, 2) + "\n", "utf8");
  } catch {
    /* nhớ được thì tốt, không nhớ được cũng không sao */
  }
}

/** Đọc một khóa kiểu string đã nhớ; không có/không phải string -> undefined */
export function prefString(bag: PrefBag, key: string): string | undefined {
  const v = bag[key];
  return typeof v === "string" && v ? v : undefined;
}

/** Đọc một khóa kiểu boolean đã nhớ */
export function prefBool(bag: PrefBag, key: string): boolean | undefined {
  return typeof bag[key] === "boolean" ? (bag[key] as boolean) : undefined;
}

/** Đọc một khóa kiểu object đã nhớ (subtitleStyle, overlay…) */
export function prefObject(bag: PrefBag, key: string): unknown {
  const v = bag[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}
