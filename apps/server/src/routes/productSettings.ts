import fs from "node:fs";
import { Router } from "express";
import multer from "multer";
import { paths } from "../config.js";
import {
  productLogoPath,
  readProductSettings,
  saveProductLogo,
  updateProductSettings,
} from "../productSettings.js";
import { HttpError } from "../util.js";

const router = Router();
const upload = multer({ dest: paths.uploadTmpDir, limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.get("/", (_req, res) => res.json(readProductSettings()));

router.put("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json(updateProductSettings({ appName: body.appName, source: body.source }));
});

router.post("/logo", upload.single("logo"), (req, res) => {
  if (!req.file) throw new HttpError(400, "LOGO_REQUIRED", "Chưa chọn file logo");
  const tmp = req.file.path;
  try {
    if (!["image/png", "image/jpeg", "image/svg+xml"].includes(req.file.mimetype)) {
      throw new HttpError(400, "INVALID_LOGO", "Logo phải là PNG, JPG hoặc SVG");
    }
    res.json(saveProductLogo(tmp, req.file.mimetype));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

router.get("/logo", (_req, res) => {
  const file = productLogoPath();
  if (!file) throw new HttpError(404, "LOGO_NOT_FOUND", "Chưa có logo ứng dụng");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (file.toLowerCase().endsWith(".svg")) {
    // SVG là tài liệu chủ động nếu mở trực tiếp. Sandbox + CSP giữ upload logo
    // ở vai trò hình ảnh, không cho script hay tài nguyên ngoài chạy.
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  }
  res.sendFile(file);
});

export default router;
