import { Router } from "express";
import { geminiApiKey } from "../gemini.js";
import {
  applySpeedToWav,
  DEFAULT_TTS_VOICE,
  listTtsModels,
  listVoices,
  synthPreviewWav,
  TTS_LANGUAGES,
} from "../tts.js";
import { listLocalVoices, probeLocalEngine, synthLocalPreviewWav } from "../ttsLocal.js";
import { normTtsSpeed } from "../textToVideoMeta.js";
import {
  isTtsEngine,
  previewTextFor,
  TTS_ENGINES,
  type TtsEngine,
  type TtsVoice,
} from "../ttsTypes.js";
import { HttpError } from "../util.js";

/**
 * GET  /api/tts/models  - model TTS khả dụng (live từ Google, cache 1h)
 * GET  /api/tts/voices  - 30 giọng dựng sẵn kèm nhãn tiếng Việt
 * POST /api/tts/preview - đọc thử một câu ngắn, trả thẳng bytes WAV
 *
 * Đây là các endpoint phục vụ màn hình chọn giọng của Text to video. Chỉ
 * /preview là TỐN TIỀN (mỗi lần bấm là một lần gọi Gemini sinh audio), nên nó
 * bị chặn cả về độ dài chữ lẫn tần suất - xem PREVIEW_MAX_CHARS và rate limit
 * bên dưới. /models và /voices thì miễn phí: danh sách model là một lời gọi
 * GET, còn danh sách giọng lấy được từ chính thông báo lỗi 400 khi hỏi một tên
 * giọng bịa (bị chặn trước khi sinh audio).
 */

/**
 * Câu đọc thử mặc định - CỐ Ý NGẮN, và CÓ HAI BẢN theo ngôn ngữ giao diện.
 *
 * Nghe thử chỉ để biết chất giọng có hợp không, mà mỗi lần nghe là một lần gọi
 * API tính tiền và chờ vài giây. Câu dài làm người dùng ngại bấm thử, nên cuối
 * cùng họ chọn giọng bằng cách đoán qua cái tên.
 *
 * Đang xem giao diện tiếng Anh mà bấm nghe thử lại ra một câu tiếng Việt thì
 * không đánh giá được giọng - nên câu mẫu đi theo ngôn ngữ đang hiện, xem
 * previewTextFor() trong ttsTypes.ts.
 */
export { PREVIEW_TEXT } from "../ttsTypes.js";

/**
 * Trần độ dài câu đọc thử. Đọc thử chỉ để nghe chất giọng, không phải để tổng
 * hợp cả bài - ai muốn cả bài thì chạy job. Trần này cũng nằm dưới mốc ~1400 ký
 * tự mà Gemini bắt đầu đọc thiếu mà vẫn trả 200.
 */
const PREVIEW_MAX_CHARS = 300;

/**
 * Rate limit đơn giản trong một tiến trình (server này chỉ chạy một tiến trình,
 * không cần store ngoài): cách nhau tối thiểu 2 giây và tối đa 30 lần mỗi 10
 * phút. Mục đích là chặn tay bấm liên tục / vòng lặp lỗi đốt tiền, không phải
 * chống tấn công - lớp xác thực token đã lo phần đó.
 */
const PREVIEW_MIN_GAP_MS = 2_000;
const PREVIEW_WINDOW_MS = 10 * 60 * 1000;
const PREVIEW_MAX_PER_WINDOW = 30;
let previewLastAt = 0;
let previewHits: number[] = [];

function checkPreviewRate(): void {
  const now = Date.now();
  if (now - previewLastAt < PREVIEW_MIN_GAP_MS) {
    throw new HttpError(
      429,
      "PREVIEW_TOO_FAST",
      "Bấm chậm lại một chút - mỗi lần đọc thử cách nhau ít nhất 2 giây.",
    );
  }
  previewHits = previewHits.filter((t) => now - t < PREVIEW_WINDOW_MS);
  if (previewHits.length >= PREVIEW_MAX_PER_WINDOW) {
    throw new HttpError(
      429,
      "PREVIEW_QUOTA",
      `Đã đọc thử ${PREVIEW_MAX_PER_WINDOW} lần trong 10 phút - mỗi lần đọc thử đều tốn tiền API. Chờ vài phút rồi thử lại.`,
    );
  }
  previewLastAt = now;
  previewHits.push(now);
}

const router = Router();

// GET /api/tts/models → TtsModel[]
router.get("/models", async (_req, res) => {
  res.json(await listTtsModels());
});

/**
 * GET /api/tts/engines - engine nào dùng được TRÊN MÁY NÀY.
 *
 * Web KHÔNG được tự suy: có key Gemini chưa, cài Python chưa, có torch chưa -
 * đó là chuyện của máy chạy server. Trả cả `reason` dạng mã để web tự dịch sang
 * ngôn ngữ đang hiện, và `detail` là dữ liệu kỹ thuật thô (không dịch).
 */
router.get("/engines", async (_req, res) => {
  const local = await probeLocalEngine();
  const hasKey = Boolean(geminiApiKey());
  res.json(
    TTS_ENGINES.map((engine) =>
      engine === "gemini"
        ? {
            engine,
            available: hasKey,
            // Gemini KHÔNG nhân bản giọng: API chỉ nhận 30 tên giọng dựng sẵn,
            // không có đường đưa mẫu ghi âm vào.
            canClone: false,
            reason: hasKey ? null : "NO_GEMINI_KEY",
            detail: hasKey ? "GEMINI_API_KEY đã có trong .env" : "",
          }
        : {
            engine,
            available: local.available,
            canClone: local.canClone,
            reason: local.reason,
            detail: local.detail,
          },
    ),
  );
});

/**
 * GET /api/tts/voices?engine=... → TtsVoice[]
 *
 * Không truyền engine thì trả về giọng của CẢ HAI engine trong một lần gọi -
 * người dùng thấy hết lựa chọn mà không phải bấm qua lại để biết mình có gì.
 * Engine chưa dùng được thì phần của nó rỗng, KHÔNG ném lỗi: thiếu key Gemini
 * mà làm hỏng luôn danh sách giọng offline thì vô lý.
 */
router.get("/voices", async (req, res) => {
  const want = req.query.engine;
  if (want !== undefined && !isTtsEngine(want)) {
    throw new HttpError(
      400,
      "INVALID_ENGINE",
      `Engine không hợp lệ: "${String(want).slice(0, 40)}". Chỉ nhận ${TTS_ENGINES.join(", ")}.`,
    );
  }
  const engine = want as TtsEngine | undefined;

  const jobs: Array<Promise<TtsVoice[]>> = [];
  if (!engine || engine === "gemini") {
    jobs.push(listVoices().catch(() => [] as TtsVoice[]));
  }
  if (!engine || engine === "vieneu") {
    jobs.push(listLocalVoices().catch(() => [] as TtsVoice[]));
  }
  const lists = await Promise.all(jobs);
  res.json(lists.flat());
});

/**
 * GET /api/tts/languages - danh sách mã ngôn ngữ hợp lệ.
 *
 * Tĩnh hoàn toàn: Google không có endpoint liệt kê, danh sách lấy từ discovery
 * document. Và API KHÔNG kiểm giá trị này (gửi bừa vẫn trả 200), nên đây thuần
 * là danh sách cho người dùng chọn.
 */
router.get("/languages", (_req, res) => {
  res.json(TTS_LANGUAGES.map((l) => ({ ...l })));
});

// POST /api/tts/preview { voice, engine?, model?, style?, language?, uiLang?, text? } → bytes audio/wav
router.post("/preview", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const engine: TtsEngine = isTtsEngine(body.engine) ? body.engine : "gemini";
  const voice = typeof body.voice === "string" ? body.voice.trim() : "";
  if (!voice) {
    throw new HttpError(400, "VOICE_REQUIRED", "Thiếu tên giọng cần nghe thử (voice)");
  }
  // Giọng Gemini là tên Latin không dấu; giọng offline có thể là tên tiếng Việt
  // CÓ DẤU ("Minh Đức") hoặc id kebab của giọng nhân bản - nên chỉ ràng buộc độ
  // dài và chặn ký tự đường dẫn, không ép về bảng chữ cái ASCII.
  if (engine === "gemini") {
    if (!/^[a-z][a-z0-9-]{1,40}$/i.test(voice)) {
      throw new HttpError(400, "INVALID_VOICE", `Tên giọng không hợp lệ: "${voice.slice(0, 40)}"`);
    }
  } else if (voice.length > 80 || /[\\/\r\n\0]/.test(voice)) {
    throw new HttpError(400, "INVALID_VOICE", `Tên giọng không hợp lệ: "${voice.slice(0, 40)}"`);
  }
  if ("model" in body && body.model !== null && body.model !== undefined && typeof body.model !== "string") {
    throw new HttpError(400, "INVALID_MODEL", "model phải là string hoặc null");
  }
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  const style = typeof body.style === "string" ? body.style.trim() : "";
  const language =
    typeof body.language === "string" && body.language.trim() ? body.language.trim() : undefined;
  if (style.length > PREVIEW_MAX_CHARS) {
    throw new HttpError(
      400,
      "STYLE_TOO_LONG",
      `Chỉ dẫn cách đọc dài quá ${PREVIEW_MAX_CHARS} ký tự`,
    );
  }

  const raw = typeof body.text === "string" ? body.text.trim() : "";
  if (raw.length > PREVIEW_MAX_CHARS) {
    throw new HttpError(
      400,
      "PREVIEW_TEXT_TOO_LONG",
      `Câu đọc thử tối đa ${PREVIEW_MAX_CHARS} ký tự (đang ${raw.length}). Đọc thử chỉ để nghe chất giọng - cả bài thì chạy bước tổng hợp giọng đọc.`,
    );
  }
  const text = raw || previewTextFor(body.uiLang);

  // Chỉ chặn tần suất với Gemini: engine chạy trên máy không tốn tiền, mà giới
  // hạn "30 lần / 10 phút" ở đó chỉ tổ cản người dùng thử giọng cho kỹ.
  if (engine === "gemini") checkPreviewRate();

  const synth =
    engine === "vieneu"
      ? await synthLocalPreviewWav({ text, voice })
      : await synthPreviewWav({
          text,
          voice: voice || DEFAULT_TTS_VOICE,
          model,
          style,
          language,
        });

  // Áp ĐÚNG tốc độ đang chọn: nghe thử là để biết trước thứ sắp nhận được, mà
  // đọc ở tốc độ gốc rồi bảo "lúc dựng sẽ nhanh hơn" thì người dùng không đánh
  // giá được gì. Dùng lại đúng hàm mà bước tổng hợp thật dùng.
  const speed = normTtsSpeed(body.speed);
  const wav = await applySpeedToWav(synth.wav, speed);
  const durationSec = synth.durationSec / speed;
  const modelUsed = synth.model;

  res.setHeader("content-type", "audio/wav");
  res.setHeader("content-length", String(wav.length));
  // Mỗi lần gọi cho ra audio khác nhau (thời lượng lệch tới 28%) - cấm cache
  res.setHeader("cache-control", "no-store");
  // Thông tin phụ cho UI hiện dưới nút nghe thử, không nằm trong body vì body là audio
  res.setHeader("x-tts-model", modelUsed);
  res.setHeader("x-tts-duration", durationSec.toFixed(2));
  res.send(wav);
});

export default router;
