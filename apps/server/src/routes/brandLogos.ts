import { Router } from "express";
import { readBrandLogos, resolveBrandLogo } from "../brandLogos.js";
import { HttpError } from "../util.js";

/**
 * Thư viện logo brand cho agent dùng lúc dựng video.
 *
 * GET  /api/brand-logos          -> danh sách đang có
 * POST /api/brand-logos { name } -> tìm logo của brand; chưa có thì TỰ TẢI về
 *                                   assets/brand-logos/ rồi trả đường dẫn
 *
 * Vì sao là endpoint chứ không để agent tự lên mạng tải: một đường tải duy nhất
 * thì mới kiểm soát được nguồn (chỉ Simple Icons + Wikimedia), khử trùng SVG,
 * giới hạn dung lượng và ghi lại giấy phép từng file. Để agent tự tải thì mỗi
 * phiên một kiểu, và sớm muộn có file rác lọt vào.
 */
const router = Router();

// GET /api/brand-logos → BrandLogo[]
router.get("/", (_req, res) => {
  res.json(readBrandLogos());
});

// POST /api/brand-logos { name } → { slug, title, color, file, relPath, source, added }
router.post("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name : "";
  if (!name.trim()) {
    throw new HttpError(
      400,
      "BRAND_NAME_REQUIRED",
      'Thiếu tên brand. Ví dụ: {"name":"OpenAI"}',
    );
  }
  const logo = await resolveBrandLogo(name);
  res.status(logo.added ? 201 : 200).json({
    ...logo,
    /** Đường dẫn tương đối repo - CHÉP file này vào assets/ của project rồi mới dùng */
    relPath: `assets/brand-logos/${logo.file}`,
  });
});

export default router;
