import { Router } from "express";
import {
  builtinVideoStyle,
  isBuiltinVideoStyle,
  readVideoStyles,
  videoStyleUsage,
  writeVideoStyles,
  type VideoStyle,
  type VideoStylePalette,
} from "../videoStyles.js";
import { HttpError, isKebabCase, nowIso, toKebabAscii } from "../util.js";

/**
 * Phong cách dựng (giấy gấp, mực tàu, người que...) - CRUD đầy đủ cho trang
 * /video-styles trên dashboard. Nguồn sự thật: assets/video-styles/video-styles.json
 * (xem videoStyles.ts). Contract đầy đủ ở docs/API.md mục "Video styles".
 *
 * HAI SHAPE, ĐỪNG GỘP:
 *
 * - GET /api/video-styles (mặc định) trả ĐÚNG shape cũ { id, name, palette, motion }
 *   cho ô chọn phong cách trong brief. `art`/`avoid` là prompt chỉ đạo mỹ thuật
 *   gửi Gemini - người đi CHỌN phong cách không cần đọc, mà bày ra thì màn hình
 *   chọn dài gấp ba. VideoStyleSelect.tsx đang ăn đúng shape này.
 * - Các endpoint QUẢN LÝ (?full=1, GET/POST/PUT/:id) trả đủ mọi field: người đi
 *   SỬA phong cách thì bắt buộc phải thấy và sửa được `art`/`avoid`, không thì
 *   phong cách tự tạo ra chẳng có chỉ đạo mỹ thuật nào.
 */
const router = Router();

/** Phong cách kèm thông tin quản lý - chỉ dùng cho trang quản lý, không cho ô chọn */
interface ManagedVideoStyle extends VideoStyle {
  /** Bản mặc định ship kèm repo (sửa/xóa được, nhưng khôi phục lại được) */
  builtin: boolean;
  /** Số project/phiên đang trỏ tới phong cách này */
  usageCount: number;
}

function findStyle(styles: VideoStyle[], id: string): VideoStyle {
  const style = styles.find((s) => s.id === id);
  if (!style) {
    throw new HttpError(404, "VIDEO_STYLE_NOT_FOUND", `Không tìm thấy phong cách dựng "${id}"`);
  }
  return style;
}

/** Field bắt buộc: rỗng là prompt gửi Gemini/agent bị cụt (vd "Avoid: .") */
function requiredStr(body: Record<string, unknown>, key: string, label: string): string {
  const v = typeof body[key] === "string" ? (body[key] as string).trim() : "";
  if (!v) {
    throw new HttpError(400, "INVALID_VIDEO_STYLE", `Thiếu ${key} - ${label}`);
  }
  return v;
}

function normPalette(raw: unknown): VideoStylePalette {
  if (raw !== "brand" && raw !== "loose") {
    throw new HttpError(400, "INVALID_PALETTE", 'palette phải là "brand" hoặc "loose"');
  }
  return raw;
}

function managedOf(style: VideoStyle, usageCount: number): ManagedVideoStyle {
  return { ...style, builtin: isBuiltinVideoStyle(style.id), usageCount };
}

// GET /api/video-styles           -> shape gọn cho ô chọn brief (KHÔNG đổi - có consumer)
// GET /api/video-styles?full=1    -> shape đầy đủ cho trang quản lý
router.get("/", (req, res) => {
  const { styles } = readVideoStyles();
  if (req.query.full === "1" || req.query.full === "true") {
    res.json(
      styles.map((s) => managedOf(s, videoStyleUsage(s.id).length)),
    );
    return;
  }
  res.json(
    styles.map((s) => ({
      id: s.id,
      name: s.name,
      palette: s.palette,
      motion: s.motion,
    })),
  );
});

// GET /api/video-styles/:id -> ManagedVideoStyle + danh sách project đang dùng
router.get("/:id", (req, res) => {
  const { styles } = readVideoStyles();
  const style = findStyle(styles, req.params.id);
  const usage = videoStyleUsage(style.id);
  res.json({ ...managedOf(style, usage.length), usage });
});

// POST /api/video-styles - { name, art, avoid, palette, motion, id?, cloneFrom? } -> 201
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data = readVideoStyles();

  // cloneFrom = lấy nội dung phong cách có sẵn làm nền, rồi ghi đè bằng field truyền lên.
  // Tạo phong cách mới từ một cái gần giống là cách dùng thật nhất - viết lại
  // cả art/avoid tiếng Anh từ đầu thì hiếm ai làm.
  let base: Omit<VideoStyle, "id" | "createdAt" | "updatedAt"> | null = null;
  if ("cloneFrom" in body) {
    if (typeof body.cloneFrom !== "string") {
      throw new HttpError(400, "INVALID_CLONE_FROM", "cloneFrom phải là id phong cách (string)");
    }
    const src = findStyle(data.styles, body.cloneFrom);
    base = { name: src.name, art: src.art, avoid: src.avoid, palette: src.palette, motion: src.motion };
  }

  const pick = (key: "name" | "art" | "avoid" | "motion", label: string): string => {
    if (key in body || !base) return requiredStr(body, key, label);
    return base[key];
  };
  const name = pick("name", "tên phong cách");
  const art = pick("art", "chỉ đạo mỹ thuật cho ảnh (viết tiếng Anh)");
  const avoid = pick("avoid", "thứ cần tránh trong ảnh (viết tiếng Anh)");
  const motion = pick("motion", "cách dựng cảnh và chuyển động (viết tiếng Việt)");
  const palette = "palette" in body ? normPalette(body.palette) : (base?.palette ?? "brand");

  // id truyền tay thì phải chuẩn và không được trùng; không truyền thì suy từ
  // tên rồi tự nối -2, -3 (giống prompts.ts và stylesRoute.ts)
  let id: string;
  if ("id" in body && body.id !== null && body.id !== "") {
    if (typeof body.id !== "string" || !isKebabCase(body.id.trim())) {
      throw new HttpError(
        400,
        "INVALID_VIDEO_STYLE_ID",
        "id phải là kebab-case (vd: giay-gap-nhat)",
      );
    }
    id = body.id.trim();
    if (data.styles.some((s) => s.id === id)) {
      throw new HttpError(409, "VIDEO_STYLE_EXISTS", `Phong cách dựng "${id}" đã tồn tại`);
    }
  } else {
    const baseId = toKebabAscii(name) || "phong-cach";
    id = baseId;
    for (let n = 2; data.styles.some((s) => s.id === id); n++) id = `${baseId}-${n}`;
  }

  const now = nowIso();
  const style: VideoStyle = { id, name, art, avoid, palette, motion, createdAt: now, updatedAt: now };
  data.styles.push(style);
  // Tạo lại đúng id một phong cách mặc định đã xóa -> bỏ khỏi danh sách "đã xóa",
  // nếu không lần đọc sau sẽ thấy id đó vắng mặt trong danh sách gieo và... không
  // làm gì, nhưng vẫn để lại một mục rác gây hiểu nhầm khi soi file.
  data.removedBuiltins = data.removedBuiltins.filter((x) => x !== id);
  writeVideoStyles(data);
  res.status(201).json(managedOf(style, 0));
});

// PUT /api/video-styles/:id - patch từng field -> ManagedVideoStyle
router.put("/:id", (req, res) => {
  const data = readVideoStyles();
  const style = findStyle(data.styles, req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;

  // id KHÔNG đổi được: brief của project đang trỏ vào nó bằng id. Đổi id là làm
  // mọi project cũ tụt về "AI tự quyết" mà không báo gì.
  if ("id" in body && typeof body.id === "string" && body.id.trim() !== style.id) {
    throw new HttpError(
      400,
      "VIDEO_STYLE_ID_IMMUTABLE",
      "Không đổi được id của phong cách - project cũ trỏ vào id này. Tạo phong cách mới rồi chọn lại.",
    );
  }

  if ("name" in body) style.name = requiredStr(body, "name", "tên phong cách");
  if ("art" in body) {
    style.art = requiredStr(body, "art", "chỉ đạo mỹ thuật cho ảnh (viết tiếng Anh)");
  }
  if ("avoid" in body) {
    style.avoid = requiredStr(body, "avoid", "thứ cần tránh trong ảnh (viết tiếng Anh)");
  }
  if ("motion" in body) {
    style.motion = requiredStr(body, "motion", "cách dựng cảnh và chuyển động (viết tiếng Việt)");
  }
  if ("palette" in body) style.palette = normPalette(body.palette);

  style.updatedAt = nowIso();
  writeVideoStyles(data);
  res.json(managedOf(style, videoStyleUsage(style.id).length));
});

/**
 * DELETE /api/video-styles/:id[?force=1] -> 204
 *
 * AN TOÀN KHI ĐANG CÓ PROJECT DÙNG: mặc định TỪ CHỐI (409) và trả kèm danh sách
 * project đang trỏ tới. Về mặt kỹ thuật xóa cũng không làm hỏng gì - meta.ts
 * (briefOf) tự hạ videoStyleId lạ về null = "AI tự quyết" - nhưng đó đúng là
 * kiểu hỏng tệ nhất: video vẫn dựng được, chỉ là mất hẳn phong cách mà không ai
 * được báo. Nên bắt người dùng nhìn thấy danh sách trước, rồi mới cho `force=1`
 * (khi đó các project đó lặng lẽ về "AI tự quyết" - đúng như trước khi có tính
 * năng phong cách dựng).
 */
router.delete("/:id", (req, res) => {
  const data = readVideoStyles();
  const style = findStyle(data.styles, req.params.id);
  const force = req.query.force === "1" || req.query.force === "true";
  const usage = videoStyleUsage(style.id);
  if (usage.length > 0 && !force) {
    throw new HttpError(
      409,
      "VIDEO_STYLE_IN_USE",
      `Phong cách "${style.name}" đang được ${usage.length} project dùng: ` +
        `${usage.map((u) => u.name).join(", ")}. Xóa vẫn được (các project đó sẽ về "AI tự quyết") ` +
        "nhưng phải xác nhận - gọi lại với ?force=1.",
    );
  }
  data.styles = data.styles.filter((s) => s.id !== style.id);
  // Nhớ là đã xóa, không thì lần đọc sau file lại gieo bản mặc định vào
  if (isBuiltinVideoStyle(style.id) && !data.removedBuiltins.includes(style.id)) {
    data.removedBuiltins.push(style.id);
  }
  writeVideoStyles(data);
  res.status(204).end();
});

/**
 * POST /api/video-styles/:id/reset -> ManagedVideoStyle
 * Trả một phong cách MẶC ĐỊNH về đúng nội dung ship kèm repo (kể cả khi đã xóa
 * hẳn). Đây là lý do vì sao built-in vẫn cho sửa/xóa thoải mái: luôn có đường về.
 */
router.post("/:id/reset", (req, res) => {
  const id = req.params.id;
  const original = builtinVideoStyle(id);
  if (!original) {
    throw new HttpError(
      400,
      "NOT_BUILTIN_VIDEO_STYLE",
      `"${id}" không phải phong cách mặc định nên không có bản gốc để khôi phục`,
    );
  }
  const data = readVideoStyles();
  const cur = data.styles.find((s) => s.id === id);
  if (cur) {
    cur.name = original.name;
    cur.art = original.art;
    cur.avoid = original.avoid;
    cur.palette = original.palette;
    cur.motion = original.motion;
    cur.updatedAt = nowIso();
  } else {
    data.styles.push(original);
  }
  data.removedBuiltins = data.removedBuiltins.filter((x) => x !== id);
  writeVideoStyles(data);
  const style = findStyle(data.styles, id);
  res.json(managedOf(style, videoStyleUsage(id).length));
});

export default router;
