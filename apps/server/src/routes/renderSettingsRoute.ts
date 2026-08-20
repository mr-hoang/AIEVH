import { Router } from "express";
import {
  DEFAULT_RENDER_SETTINGS,
  detectHardware,
  maxWorkers,
  readRenderSettings,
  recommendedWorkers,
  UPDATE_CHANNELS,
  writeRenderSettings,
  type RenderSettings,
  type UpdateChannel,
} from "../renderSettings.js";
import { HttpError } from "../util.js";

/** Tab "Tăng tốc" - xem phần cứng + chỉnh cài đặt render. Đổi là hiệu lực ngay (job đọc mỗi lần chạy). */
const router = Router();

// GET /api/render-settings → { settings, defaults, hardware, recommended }
router.get("/", async (_req, res) => {
  res.json({
    settings: readRenderSettings(),
    defaults: DEFAULT_RENDER_SETTINGS,
    hardware: await detectHardware(),
    // Theo máy thật - UI dựng option worker/concurrency từ đây, không hardcode
    recommended: {
      workers: recommendedWorkers,
      concurrency: recommendedWorkers,
      maxWorkers,
    },
  });
});

type SettingKind = "number" | "boolean" | "nullableNumber" | "updateChannel";

/**
 * Kiểu dữ liệu của TỪNG cài đặt, dùng để lọc body của PUT.
 *
 * Kiểu `Record<keyof RenderSettings, …>` là phần quan trọng nhất ở đây: thêm một
 * field vào RenderSettings mà quên khai báo tại đây thì TypeScript BÁO LỖI BUILD.
 * Bản trước liệt kê tên field bằng tay trong ba mảng rời, nên `updateChannel`,
 * `aiMaxAttempts` và `aiMaxTurns` bị bỏ quên - PUT vẫn trả 200 kèm settings cũ,
 * giao diện nháy sang giá trị mới rồi bật lại như cũ và vẫn báo "đã lưu". Im lặng
 * bỏ qua là kiểu hỏng tệ nhất, nên bây giờ nó thành lỗi biên dịch.
 */
const SETTING_KINDS: Record<keyof RenderSettings, SettingKind> = {
  workers: "number",
  browserGpu: "boolean",
  gpuEncodeDraft: "boolean",
  gpuEncodeFinal: "boolean",
  fastCapture: "boolean",
  remotionConcurrency: "number",
  queueConcurrency: "number",
  draftFps: "nullableNumber",
  qcGate: "boolean",
  updateChannel: "updateChannel",
  aiMaxAttempts: "number",
  aiMaxTurns: "number",
};

const KIND_LABEL: Record<SettingKind, string> = {
  number: "phải là số",
  boolean: "phải là boolean",
  nullableNumber: "phải là số hoặc null",
  updateChannel: `phải là một trong ${UPDATE_CHANNELS.join(", ")}`,
};

function isValid(kind: SettingKind, v: unknown): boolean {
  switch (kind) {
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "nullableNumber":
      return v === null || (typeof v === "number" && Number.isFinite(v));
    case "updateChannel":
      return UPDATE_CHANNELS.includes(v as UpdateChannel);
  }
}

// PUT /api/render-settings - partial → { settings }
router.put("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<RenderSettings> = {};

  for (const [key, kind] of Object.entries(SETTING_KINDS) as Array<
    [keyof RenderSettings, SettingKind]
  >) {
    if (!(key in body)) continue;
    if (!isValid(kind, body[key])) {
      throw new HttpError(400, "INVALID_SETTING", `${key} ${KIND_LABEL[kind]}`);
    }
    (patch as Record<string, unknown>)[key] = body[key];
  }

  // Kẹp range vẫn do normalizeSettings() lo - ở đây chỉ chặn sai KIỂU.
  res.json({ settings: writeRenderSettings(patch) });
});

export default router;
