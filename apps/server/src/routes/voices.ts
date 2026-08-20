import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { paths } from "../config.js";
import { probeLocalEngine, synthLocalPreviewWav } from "../ttsLocal.js";
import { previewTextFor } from "../ttsTypes.js";
import {
  createClonedVoice,
  getClonedVoice,
  listClonedVoices,
  patchClonedVoice,
  removeClonedVoice,
} from "../voiceStore.js";
import { HttpError, ensureDir, fileKind, isKebabCase } from "../util.js";

/**
 * GET    /api/voices            - kho giọng đã nhân bản
 * POST   /api/voices            - multipart: file mẫu + name/gender/note
 * PATCH  /api/voices/:id        - đổi tên / giới tính / ghi chú
 * DELETE /api/voices/:id        - xóa cả bản ghi lẫn file mẫu
 * POST   /api/voices/:id/preview- đọc thử một câu ngắn, trả thẳng bytes WAV
 *
 * Khác hẳn /api/tts/preview (Gemini): ở đây KHÔNG có rate limit. Đọc thử bằng
 * VieNeu không tốn một đồng nào - nó chỉ tốn CPU, mà phần đó đã có hàng đợi
 * tuần tự trong ttsLocal.ts giữ: bấm mười lần thì mười lần xếp hàng chạy lần
 * lượt, không có gì để dồn đống. Thêm rate limit ở đây chỉ làm phiền người dùng
 * đang thử đi thử lại để chọn giọng.
 */

const router = Router();

// multer ghi vào thư mục tạm cùng ổ đĩa rồi ffmpeg đọc từ đó - giống routes/sfx.ts
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureDir(paths.uploadTmpDir);
      cb(null, paths.uploadTmpDir);
    },
    filename: (_req, _file, cb) => cb(null, `voice-${Date.now()}-${Math.round(Math.random() * 1e9)}`),
  }),
  // Giữ đúng trần của thư viện sound effect: mẫu giọng chỉ vài giây, nhưng
  // người dùng hay kéo thẳng cả video quay bằng điện thoại vào.
  limits: { fileSize: 200 * 1024 * 1024 },
});

/** id vừa là khóa vừa là TÊN THƯ MỤC - chặn traversal trước khi đụng tới đĩa */
function safeId(raw: string): string {
  const id = path.basename(String(raw ?? "").trim());
  if (!id || !isKebabCase(id)) {
    throw new HttpError(400, "INVALID_VOICE_ID", `id giọng không hợp lệ: "${String(raw).slice(0, 40)}"`);
  }
  return id;
}

function rmQuiet(file: string | undefined): void {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* file tạm - kệ nếu đang bị giữ */
  }
}

// GET /api/voices -> ClonedVoice[]
router.get("/", (_req, res) => {
  res.json(listClonedVoices());
});

// POST /api/voices - multipart: file + name + gender + note -> ClonedVoice
router.post("/", upload.single("file"), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) {
    throw new HttpError(400, "FILE_REQUIRED", "Thiếu file mẫu giọng (field `file`)");
  }
  try {
    // Chặn TRƯỚC khi chuẩn hóa file: lưu được giọng mà không đọc được thì người
    // dùng chỉ phát hiện ra lúc bấm nghe thử, và lúc đó lời nhắn cài đặt lại
    // nằm ở màn hình khác.
    const status = await probeLocalEngine();
    if (!status.canClone) {
      throw new HttpError(503, status.reason ?? "NO_VIENEU", status.detail);
    }

    const kind = fileKind(uploaded.originalname);
    if (kind !== "audio" && kind !== "video") {
      throw new HttpError(
        400,
        "INVALID_AUDIO",
        "File mẫu phải là audio (mp3/wav/ogg/m4a/aac/flac) hoặc video có tiếng nói",
      );
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const entry = await createClonedVoice({
      name: body.name,
      gender: body.gender,
      note: body.note,
      srcAbs: uploaded.path,
    });
    res.status(201).json(entry);
  } finally {
    // File tạm không còn cần sau khi ffmpeg đã chuẩn hóa xong (bản chuẩn nằm ở
    // assets/voices/<id>/ref.wav), và cũng phải dọn khi lỗi.
    rmQuiet(uploaded.path);
  }
});

// PATCH /api/voices/:id { name?, gender?, note? } -> ClonedVoice
router.patch("/:id", (req, res) => {
  const id = safeId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: { name?: unknown; gender?: unknown; note?: unknown } = {};
  if ("name" in body) patch.name = body.name;
  if ("gender" in body) patch.gender = body.gender;
  if ("note" in body) patch.note = body.note;
  res.json(patchClonedVoice(id, patch));
});

// DELETE /api/voices/:id -> { id }
router.delete("/:id", (req, res) => {
  const id = safeId(req.params.id);
  removeClonedVoice(id);
  res.json({ id });
});

// POST /api/voices/:id/preview { uiLang? } -> bytes audio/wav
router.post("/:id/preview", async (req, res) => {
  const id = safeId(req.params.id);
  const voice = getClonedVoice(id);
  if (!voice) {
    throw new HttpError(404, "VOICE_NOT_FOUND", `Không tìm thấy giọng nhân bản "${id}"`);
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Câu đọc thử là CỐ ĐỊNH, người dùng không nhập được: nghe thử chỉ để biết
  // giọng có giống mẫu không. Cho nhập chữ tự do ở đây tức là mở một đường tổng
  // hợp không giới hạn độ dài, mà mỗi giây tiếng tốn khoảng một giây CPU.
  const text = previewTextFor(body.uiLang);

  const { wav, durationSec, model } = await synthLocalPreviewWav({ text, voice: id });

  res.setHeader("content-type", "audio/wav");
  res.setHeader("content-length", String(wav.length));
  // Mỗi lần sinh ra một bản khác nhau (model có lấy mẫu ngẫu nhiên) - cấm cache
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-tts-model", model);
  res.setHeader("x-tts-duration", durationSec.toFixed(2));
  res.send(wav);
});

export default router;
