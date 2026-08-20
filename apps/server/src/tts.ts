import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { geminiApiKey } from "./gemini.js";
import {
  TTS_CHUNK_MAX_CHARS,
  TTS_CHUNK_MIN_CHARS,
  TTS_CHUNK_SAFE_MIN_CHARS,
} from "./textToVideoMeta.js";
import { synthLocalChunkWav } from "./ttsLocal.js";
import type { TtsEngine, TtsGender, TtsVoice } from "./ttsTypes.js";
import { HttpError, ensureDir, execFileCaptureAll } from "./util.js";

/**
 * Gemini text-to-speech - đọc kịch bản của Text to video thành file giọng đọc.
 *
 * VÌ SAO KHÔNG DÙNG LẠI geminiEndpoint() TRONG gemini.ts: hàm đó trỏ vào /v1,
 * mà /v1 TỪ CHỐI speechConfig (400 "Unknown name speechConfig"). TTS chỉ chạy
 * trên /v1beta. Key thì vẫn dùng chung geminiApiKey().
 *
 * Những điều đã đo thật trên API (đừng "tối ưu" mất):
 * - Model trả PCM THÔ 16-bit little-endian, 24000 Hz, mono, KHÔNG có header WAV.
 * - 200 OK KHÔNG có nghĩa là có tiếng: gặp 6/10 lần với câu 9 ký tự, phản hồi
 *   thiếu hẳn phần inlineData và finishReason là "OTHER" -> phải thử lại.
 * - Input dài trên ~1400 ký tự bị đọc thiếu ÂM THẦM: vẫn 200, vẫn
 *   finishReason "STOP", nhưng chỉ đọc một phần (đo được 38% ở mức 5000 ký tự).
 *   Vì thế mọi thứ đều phải chia đoạn 400-800 ký tự trước khi gửi.
 * - Thời lượng KHÔNG lặp lại được: cùng một câu 83 ký tự, 45 lần gọi cho ra
 *   4,93s tới 6,33s. Mọi con số thời lượng ở đây đều ĐO bằng ffprobe.
 */

/** Model TTS mặc định - rẻ hơn bản pro 2,6 lần, chất lượng tiếng Việt không phân biệt được */
export const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";

export interface TtsModel {
  id: string;
  label: string;
}

/**
 * Giới tính giọng. Google KHÔNG công bố dữ liệu này - họ chỉ cho nhãn phong cách
 * ("Bright", "Firm"...). Con số ở đây là ĐO THẬT: đọc cùng một câu tiếng Việt
 * bằng cả 30 giọng, đo tần số cơ bản (F0) từ sóng âm, rồi đối chiếu với nhận
 * định nghe lại. 16 nam / 13 nữ / 1 trung tính.
 *
 * Kiểu đã dời sang ttsTypes.ts để engine offline dùng chung; xuất lại ở đây cho
 * code cũ import theo đường cũ vẫn chạy.
 */
export type { TtsGender, TtsVoice } from "./ttsTypes.js";

/**
 * Mã ngôn ngữ hợp lệ của speechConfig.languageCode, lấy từ discovery document
 * chính thức của Google (v1beta).
 *
 * HAI ĐIỀU ĐÃ KIỂM CHỨNG, đừng bỏ đi vì tưởng là thiếu sót:
 *
 * 1. API KHÔNG kiểm giá trị này. Gửi "klingon" hay "xx-YY" vẫn trả 200 kèm
 *    audio. Nên đây là danh sách để người dùng chọn, không phải để tin.
 * 2. Mọi giọng đọc được MỌI ngôn ngữ - không có "giọng tiếng Việt" riêng và
 *    "giọng tiếng Anh" riêng. Đã dựng cả 30 giọng ở vi/en/ja: 90/90 thành công,
 *    và bộ nhận diện xác nhận vẫn cùng một người nói. Vì vậy KHÔNG lọc giọng
 *    theo ngôn ngữ - hai ô chọn đó độc lập với nhau.
 */
export const TTS_LANGUAGES = [
  { code: "vi-VN", label: "Tiếng Việt (Việt Nam)" },
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "en-AU", label: "English (Australia)" },
  { code: "en-IN", label: "English (India)" },
  { code: "ja-JP", label: "日本語 (Nhật)" },
  { code: "ko-KR", label: "한국어 (Hàn)" },
  { code: "cmn-CN", label: "中文 (Trung)" },
  { code: "th-TH", label: "ไทย (Thái)" },
  { code: "id-ID", label: "Bahasa Indonesia" },
  { code: "hi-IN", label: "हिन्दी (Ấn Độ)" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "es-ES", label: "Español (España)" },
  { code: "es-US", label: "Español (US)" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "it-IT", label: "Italiano" },
  { code: "nl-NL", label: "Nederlands" },
  { code: "pl-PL", label: "Polski" },
  { code: "ru-RU", label: "Русский" },
  { code: "tr-TR", label: "Türkçe" },
  { code: "ar-XA", label: "العربية" },
  { code: "fr-CA", label: "Français (Canada)" },
  { code: "bn-IN", label: "বাংলা" },
  { code: "gu-IN", label: "ગુજરાતી" },
  { code: "kn-IN", label: "ಕನ್ನಡ" },
  { code: "ml-IN", label: "മലയാളം" },
  { code: "mr-IN", label: "मराठी" },
  { code: "ta-IN", label: "தமிழ்" },
  { code: "te-IN", label: "తెలుగు" },
] as const;

export const DEFAULT_TTS_LANGUAGE = "vi-VN";

/** Danh sách tĩnh - fallback khi không có key hoặc gọi Google lỗi */
export const TTS_MODELS: TtsModel[] = [
  {
    id: "gemini-2.5-flash-preview-tts",
    label: "Flash TTS (khuyên dùng, rẻ nhất) - gemini-2.5-flash-preview-tts",
  },
  {
    id: "gemini-2.5-pro-preview-tts",
    label: "Pro TTS (đắt hơn 2,6 lần) - gemini-2.5-pro-preview-tts",
  },
  {
    id: "gemini-3.1-flash-tts-preview",
    label: "Flash TTS 3.1 (nhịp đọc đều hơn) - gemini-3.1-flash-tts-preview",
  },
];

/**
 * 30 giọng dựng sẵn + tính cách giọng (nhãn tiếng Việt cho người dùng chọn).
 * Google KHÔNG có endpoint liệt kê giọng - đã dò mọi đường dẫn hợp lý đều 404 và
 * discovery document không có RPC nào về voice. Danh sách này được làm tươi bằng
 * cách hỏi ngược API (xem probeVoiceNames), còn nhãn thì phải tự nuôi ở đây.
 */
const VOICE_CATALOG: Array<{
  name: string;
  style: string;
  gender: TtsGender;
  /** Tần số cơ bản trung vị ĐO ĐƯỢC (Hz) - căn cứ để xếp giới tính */
  f0: number;
}> = [
  { name: "Zephyr", style: "trong trẻo, tươi sáng", gender: "nu", f0: 196 },
  { name: "Puck", style: "vui tươi, hào hứng", gender: "nam", f0: 115 },
  { name: "Charon", style: "truyền đạt, rành mạch", gender: "nam", f0: 126 },
  { name: "Kore", style: "chắc chắn, dứt khoát", gender: "nu", f0: 207 },
  { name: "Fenrir", style: "sôi nổi, dễ phấn khích", gender: "nam", f0: 128 },
  { name: "Leda", style: "trẻ trung", gender: "nu", f0: 206 },
  { name: "Orus", style: "chắc chắn, quả quyết", gender: "nam", f0: 130 },
  { name: "Aoede", style: "nhẹ nhàng, thoáng", gender: "nu", f0: 180 },
  { name: "Callirrhoe", style: "thư thái, dễ chịu", gender: "nu", f0: 203 },
  { name: "Autonoe", style: "tươi sáng", gender: "nu", f0: 183 },
  { name: "Enceladus", style: "nhiều hơi thở, thủ thỉ", gender: "nam", f0: 114 },
  { name: "Iapetus", style: "rõ ràng, sáng tiếng", gender: "nam", f0: 137 },
  { name: "Umbriel", style: "thư thái", gender: "nam", f0: 131 },
  { name: "Algieba", style: "mượt mà", gender: "nam", f0: 109 },
  { name: "Despina", style: "mượt mà, êm", gender: "nu", f0: 222 },
  { name: "Erinome", style: "rõ ràng", gender: "nu", f0: 214 },
  { name: "Algenib", style: "khàn, sạn", gender: "nam", f0: 126 },
  { name: "Rasalgethi", style: "truyền đạt, học thuật", gender: "nam", f0: 141 },
  { name: "Laomedeia", style: "hào hứng", gender: "nu", f0: 182 },
  { name: "Achernar", style: "dịu, nhỏ nhẹ", gender: "nu", f0: 219 },
  { name: "Alnilam", style: "chắc, đanh", gender: "nam", f0: 117 },
  { name: "Schedar", style: "đều đều, điềm tĩnh", gender: "nam", f0: 136 },
  { name: "Gacrux", style: "trầm, từng trải", gender: "nu", f0: 152 },
  { name: "Pulcherrima", style: "chủ động, đẩy tới", gender: "trung-tinh", f0: 131 },
  { name: "Achird", style: "thân thiện", gender: "nam", f0: 142 },
  { name: "Zubenelgenubi", style: "tự nhiên, đời thường", gender: "nam", f0: 141 },
  { name: "Vindemiatrix", style: "hiền hòa, êm ái", gender: "nu", f0: 191 },
  { name: "Sadachbia", style: "sống động", gender: "nam", f0: 125 },
  { name: "Sadaltager", style: "am hiểu, chững chạc", gender: "nam", f0: 125 },
  { name: "Sulafat", style: "ấm áp", gender: "nu", f0: 231 },
];

export const DEFAULT_TTS_VOICE = "Kore";

/** Khoảng lặng chèn giữa hai đoạn khi ghép - xem ghi chú ở stitchChunks() */
export const TTS_GAP_SEC = 0.25;

/** Sample rate của file ghép cuối - 48kHz cho khớp track audio của Remotion */
const OUT_SAMPLE_RATE = 48_000;

/** Số lần gọi lại tối đa cho MỘT đoạn (1 lần đầu + 3 lần thử lại) */
const MAX_ATTEMPTS = 4;

/**
 * Chữ càng ngắn, model càng hay trả 200 mà không có tiếng - đo thật với câu 9 ký
 * tự: 6/10 lần rỗng, và có lần 4 lượt liên tiếp đều rỗng. Nên đoạn ngắn được
 * phát thêm lượt thử; đoạn dài thì không cần (và mỗi lượt thừa đều tốn tiền).
 */
const SHORT_TEXT_ATTEMPTS = 7;

/** Chờ giữa các lần thử lại khi API kêu quá tải / hết hạn mức - lùi dần */
const RETRY_DELAY_MS = [1_500, 4_000, 9_000];

/**
 * Chờ khi API trả 200 mà không có tiếng. Ca này KHÔNG phải bị chặn hạn mức
 * (không tính vào usage), gọi lại ngay là được - lùi dần chỉ làm job chậm oan.
 */
const EMPTY_RETRY_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function missingKeyError(): HttpError {
  return new HttpError(
    503,
    "NO_GEMINI_KEY",
    "Chưa có GEMINI_API_KEY nên không tổng hợp được giọng đọc. Thêm GEMINI_API_KEY vào file .env ở gốc repo (lấy key tại aistudio.google.com/apikey) rồi khởi động lại server.",
  );
}

// ---------------------------------------------------------------------------
// Danh sách model
// ---------------------------------------------------------------------------

let modelsCache: { at: number; list: TtsModel[] } | null = null;
const LIST_CACHE_MS = 60 * 60 * 1000;

/**
 * Model TTS khả dụng - hỏi thẳng Google rồi lọc theo id có "tts".
 * Không có trường capability nào cho biết model đọc được chữ, chuỗi con trong id
 * là dấu hiệu DUY NHẤT (đúng cách mà danh sách model ảnh đang lọc theo "image").
 */
export async function listTtsModels(): Promise<TtsModel[]> {
  const key = geminiApiKey();
  if (!key) return TTS_MODELS;
  if (modelsCache && Date.now() - modelsCache.at < LIST_CACHE_MS) return modelsCache.list;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: { "x-goog-api-key": key },
    });
    if (!r.ok) return TTS_MODELS;
    const data = (await r.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const labels = new Map(TTS_MODELS.map((m) => [m.id, m.label]));
    const seen = new Set<string>();
    const list: TtsModel[] = [];
    for (const m of data.models ?? []) {
      const id = (m.name ?? "").replace(/^models\//, "");
      if (!id || seen.has(id) || !id.includes("tts")) continue;
      const methods = m.supportedGenerationMethods ?? [];
      if (methods.length > 0 && !methods.includes("generateContent")) continue;
      seen.add(id);
      list.push({ id, label: labels.get(id) ?? id });
    }
    if (list.length === 0) return TTS_MODELS;
    // Model mặc định luôn đứng đầu để UI chọn sẵn cái rẻ nhất
    list.sort((a, b) => {
      if (a.id === DEFAULT_TTS_MODEL) return -1;
      if (b.id === DEFAULT_TTS_MODEL) return 1;
      return a.id.localeCompare(b.id);
    });
    modelsCache = { at: Date.now(), list };
    return list;
  } catch {
    return TTS_MODELS;
  }
}

// ---------------------------------------------------------------------------
// Danh sách giọng
// ---------------------------------------------------------------------------

let voicesCache: { at: number; list: TtsVoice[] } | null = null;

/**
 * Hỏi ngược API xem nó nhận những tên giọng nào: gửi một voiceName bịa ra, API
 * trả 400 kèm nguyên câu "Allowed voice names are: ..." liệt kê đủ 30 giọng.
 * Lời gọi này MIỄN PHÍ (bị chặn trước khi sinh audio, không có usageMetadata).
 * Chỉ gemini-2.5-flash-preview-tts trả lời kiểu này; gemini-3.1-flash-tts-preview
 * chỉ trả 404 trống nên đừng đổi model dò.
 */
async function probeVoiceNames(key: string): Promise<string[]> {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_TTS_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "x" }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "__PROBE__" } } },
        },
      }),
    },
  );
  const data = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
  const msg = data?.error?.message ?? "";
  const listPart = msg.match(/Allowed voice names are:\s*(.+)$/i)?.[1] ?? "";
  return listPart
    .split(",")
    .map((s) => s.trim().replace(/[.\s]+$/, ""))
    .filter((s) => /^[a-z][a-z0-9-]{1,40}$/i.test(s));
}

/**
 * Danh sách giọng cho UI chọn. Nền là VOICE_CATALOG (có nhãn tiếng Việt), làm
 * tươi bằng probe: giọng nào API báo nhận mà chưa có trong catalog thì vẫn trả
 * về (nhãn lấy tạm chính tên) - Google thêm giọng mới là UI thấy ngay, không
 * phải chờ sửa code. Cache 1 giờ như danh sách model ảnh.
 */
export async function listVoices(): Promise<TtsVoice[]> {
  const labeled = (name: string, style?: string, gender?: TtsGender, f0?: number): TtsVoice => ({
    engine: "gemini",
    name,
    // Giọng Gemini không có tên riêng để hiển thị - chính tên là tên
    title: name,
    label: style ? `${name} - ${style}` : name,
    // Giọng mới Google thêm sau này chưa có số đo -> để "trung-tinh" chứ không
    // đoán theo tên. Đoán sai giới tính khó chịu hơn là nói "chưa rõ".
    gender: gender ?? "trung-tinh",
    f0: f0 ?? 0,
    kind: "preset",
    // Gemini không phân vùng miền: đã dựng thử cả 30 giọng ở nhiều ngôn ngữ,
    // không giọng nào mang giọng vùng miền cố định.
    region: null,
    // Web dịch mô tả chất giọng theo key này; giọng Google thêm sau chưa có key
    // nên để null và web sẽ lùi về `label`.
    timbreKey: style ? name.toLowerCase() : null,
    note: "",
  });
  const key = geminiApiKey();
  if (!key) return VOICE_CATALOG.map((v) => labeled(v.name, v.style, v.gender, v.f0));
  if (voicesCache && Date.now() - voicesCache.at < LIST_CACHE_MS) return voicesCache.list;

  let allowed: string[] = [];
  try {
    allowed = await probeVoiceNames(key);
  } catch {
    /* mạng lỗi - dùng catalog tĩnh, không chặn UI */
  }
  if (allowed.length === 0) return VOICE_CATALOG.map((v) => labeled(v.name, v.style, v.gender, v.f0));

  // API trả tên viết thường; catalog giữ dạng viết hoa đẹp để hiện lên UI
  const allowedLc = new Set(allowed.map((s) => s.toLowerCase()));
  const inCatalog = new Set(VOICE_CATALOG.map((v) => v.name.toLowerCase()));
  const list: TtsVoice[] = [];
  for (const v of VOICE_CATALOG) {
    if (allowedLc.has(v.name.toLowerCase())) list.push(labeled(v.name, v.style, v.gender, v.f0));
  }
  for (const name of allowed) {
    if (inCatalog.has(name.toLowerCase())) continue;
    // Giọng mới chưa có nhãn - viết hoa chữ đầu cho dễ đọc, nhãn là chính tên
    list.push(labeled(name.charAt(0).toUpperCase() + name.slice(1)));
  }
  voicesCache = { at: Date.now(), list };
  return list;
}

// ---------------------------------------------------------------------------
// Chia đoạn
// ---------------------------------------------------------------------------

/**
 * Tách văn bản thành câu. Cắt sau . ! ? … khi phía sau là khoảng trắng, nhưng
 * KHÔNG cắt sau chữ cái đơn (viết tắt kiểu "T. Nguyễn") hay sau chữ số (mốc
 * "2.5") - cắt bậy vào giữa cụm làm câu đọc bị hụt hơi.
 */
function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  const re = /([.!?…]+["'”’)\]]?)\s+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) {
    const end = m.index + m[1].length;
    const before = paragraph.slice(Math.max(0, m.index - 2), m.index);
    // "A." / "2." -> viết tắt hoặc số thứ tự, không phải hết câu
    if (/(^|\s)[A-Za-zÀ-ỹ0-9]$/.test(before) && m[1].length === 1 && m[1] === ".") continue;
    const piece = paragraph.slice(last, end).trim();
    if (piece) out.push(piece);
    last = re.lastIndex;
  }
  const tail = paragraph.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}

/** Câu dài hơn trần thì phải xé nhỏ: ưu tiên dấu phẩy/chấm phẩy, cùng lắm mới cắt theo từ */
function hardSplit(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const out: string[] = [];
  let buf = "";
  // Giữ dấu phân cách ở cuối mảnh để câu đọc còn nhịp
  const parts = sentence.split(/(?<=[,;:])\s+/);
  const flush = (): void => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (const part of parts) {
    if (part.length > max) {
      flush();
      // Không còn dấu nào để bám - cắt theo từ
      let line = "";
      for (const word of part.split(/\s+/)) {
        // Một "từ" dài hơn cả trần (URL, chuỗi rác dán vào) - đành cắt cứng theo
        // ký tự, thà đọc sai một chỗ còn hơn gửi đi rồi bị đọc thiếu âm thầm
        const words =
          word.length > max ? (word.match(new RegExp(`.{1,${max}}`, "g")) ?? [word]) : [word];
        for (const w of words) {
          if (line && `${line} ${w}`.length > max) {
            out.push(line);
            line = w;
          } else {
            line = line ? `${line} ${w}` : w;
          }
        }
      }
      if (line) out.push(line);
      continue;
    }
    if (buf && `${buf} ${part}`.length > max) flush();
    buf = buf ? `${buf} ${part}` : part;
  }
  flush();
  return out;
}

/**
 * Chia kịch bản thành các đoạn 400-800 ký tự, LUÔN cắt ở ranh giới câu.
 *
 * Vì sao phải chia: trên ~1400 ký tự Gemini đọc thiếu mà vẫn trả 200 + STOP -
 * không có cách nào biết bị hụt ngoài việc nghe lại. Chia nhỏ là cách duy nhất
 * chắc chắn đọc đủ. Đoạn quá ngắn cũng nguy: dưới ~30 ký tự tỉ lệ trả về rỗng
 * tăng vọt, nên mảnh cuối ngắn quá thì gộp ngược vào đoạn trước.
 */
export function chunkForTts(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Mỗi câu kèm cờ "là câu cuối đoạn văn" - đó là chỗ ngắt nghe tự nhiên nhất
  const units: Array<{ text: string; paraEnd: boolean }> = [];
  for (const para of paragraphs) {
    const sentences = splitSentences(para).flatMap((s) => hardSplit(s, TTS_CHUNK_MAX_CHARS));
    sentences.forEach((s, i) => units.push({ text: s, paraEnd: i === sentences.length - 1 }));
  }

  const chunks: string[] = [];
  let buf = "";
  for (const u of units) {
    const merged = buf ? `${buf} ${u.text}` : u.text;
    if (merged.length > TTS_CHUNK_MAX_CHARS && buf) {
      chunks.push(buf);
      buf = u.text;
    } else {
      buf = merged;
    }
    // Đủ dài rồi mà lại đúng cuối đoạn văn -> chốt luôn, đừng nhồi sang đoạn khác
    if (buf.length >= TTS_CHUNK_MIN_CHARS && u.paraEnd) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);

  // Mảnh cuối quá ngắn thì gộp ngược - trừ khi gộp xong vượt trần
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (
      last.length < TTS_CHUNK_SAFE_MIN_CHARS &&
      `${prev} ${last}`.length <= TTS_CHUNK_MAX_CHARS + TTS_CHUNK_SAFE_MIN_CHARS
    ) {
      chunks.splice(chunks.length - 2, 2, `${prev} ${last}`);
    }
  }
  return chunks.filter((c) => c.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Gọi API
// ---------------------------------------------------------------------------

interface TtsResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

/**
 * Đọc sample rate / số kênh từ mimeType. Phải parse phòng thủ vì hai model viết
 * hai kiểu khác nhau: "audio/L16;codec=pcm;rate=24000" (2.5) và
 * "audio/l16; rate=24000; channels=1" (3.1).
 */
function parsePcmMime(mime: string): { sampleRate: number; channels: number } {
  const rate = Number(mime.match(/rate=(\d+)/i)?.[1] ?? 0);
  const ch = Number(mime.match(/channels=(\d+)/i)?.[1] ?? 0);
  return {
    sampleRate: Number.isFinite(rate) && rate > 0 ? rate : 24_000,
    channels: Number.isFinite(ch) && ch > 0 ? ch : 1,
  };
}

/** Chỉ dẫn cách đọc chèn trước văn bản - model không đọc phần chỉ dẫn thành tiếng */
function withStyle(text: string, style?: string): string {
  const s = (style ?? "").trim().replace(/[:：]\s*$/, "");
  return s ? `${s}: ${text}` : text;
}

/** Model hợp lệ: id an toàn và có "tts" trong tên; sai thì rơi về mặc định */
function resolveModel(model?: string | null): string {
  return model && /^[a-z0-9][a-z0-9.-]{2,80}$/i.test(model) && model.includes("tts")
    ? model
    : DEFAULT_TTS_MODEL;
}

interface RawAudio {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  model: string;
}

/**
 * Một lần gọi API. Trả null nếu 200 nhưng KHÔNG có audio (để vòng ngoài thử
 * lại); throw nếu lỗi không cứu được.
 */
async function callTtsOnce(input: {
  text: string;
  voice: string;
  /** Mã ngôn ngữ speechConfig.languageCode, vd "vi-VN" - bỏ trống cũng được */
  language?: string;
  model: string;
  timeoutMs: number;
  isCanceled?: () => boolean;
}): Promise<{
  audio: RawAudio | null;
  note: string;
  retryable: boolean;
  /** "empty" = 200 mà thiếu tiếng (gọi lại ngay được); "http" = bị API chặn (phải chờ) */
  kind: "ok" | "empty" | "http";
}> {
  const key = geminiApiKey();
  if (!key) throw missingKeyError();

  // Hủy job phải cắt được cả request đang bay, không chỉ dừng ở vòng lặp sau
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const cancelTimer = input.isCanceled
    ? setInterval(() => {
        if (input.isCanceled?.()) controller.abort();
      }, 1_000)
    : null;
  cancelTimer?.unref?.();

  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: input.text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } },
              // Ghi rõ ngôn ngữ cho tường minh. ĐO ĐƯỢC: trường này KHÔNG đổi
              // kết quả - thử mù 48 lượt trên văn bản tiếng Anh với vi-VN và
              // en-US, không lượt nào nghe ra khác biệt giọng vùng miền. Model
              // đi theo ngôn ngữ của CHÍNH văn bản. Giữ lại vì API có nhận, và
              // vì nó nói rõ ý định cho người đọc code sau này.
              ...(input.language ? { languageCode: input.language } : {}),
            },
          },
        }),
      },
    );
  } catch (err) {
    if (input.isCanceled?.()) throw new Error("Job đã bị hủy");
    const msg = err instanceof Error ? err.message : String(err);
    // Timeout/đứt mạng đều đáng thử lại - lỗi tạm thời, không phải sai tham số
    return { audio: null, note: `lỗi mạng: ${msg}`, retryable: true, kind: "http" };
  } finally {
    clearTimeout(timer);
    if (cancelTimer) clearInterval(cancelTimer);
  }

  if (!res.ok) {
    const raw = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    let message = raw;
    try {
      message = (JSON.parse(raw) as TtsResponse).error?.message ?? raw;
    } catch {
      /* body không phải JSON - dùng nguyên văn */
    }
    if (res.status === 429 || res.status >= 500) {
      return { audio: null, note: `Gemini ${res.status}: ${message}`, retryable: true, kind: "http" };
    }
    if (res.status === 400 && /voice/i.test(message)) {
      throw new HttpError(
        400,
        "INVALID_VOICE",
        `Giọng "${input.voice}" không hợp lệ với model ${input.model}. Chọn lại giọng trong danh sách. Chi tiết: ${message}`,
      );
    }
    if (res.status === 403 || res.status === 401) {
      throw new HttpError(
        502,
        "GEMINI_AUTH",
        `GEMINI_API_KEY bị từ chối (${res.status}). Kiểm tra lại key trong .env - tạo key mới tại aistudio.google.com/apikey. Chi tiết: ${message}`,
      );
    }
    if (res.status === 404) {
      throw new HttpError(
        400,
        "TTS_MODEL_NOT_FOUND",
        `Model "${input.model}" không tồn tại hoặc không đọc được chữ. Chọn lại model TTS. Chi tiết: ${message}`,
      );
    }
    throw new HttpError(
      502,
      "GEMINI_TTS_FAILED",
      `Gemini TTS trả lỗi ${res.status}: ${message || res.statusText}`,
    );
  }

  const data = (await res.json().catch(() => null)) as TtsResponse | null;
  const cand = data?.candidates?.[0];
  const part = (cand?.content?.parts ?? []).find((p) => typeof p.inlineData?.data === "string");
  const b64 = part?.inlineData?.data;
  if (!b64) {
    // Đây là ca 200-OK-không-có-tiếng, thường kèm finishReason "OTHER"
    const why =
      data?.promptFeedback?.blockReason ??
      cand?.finishReason ??
      (data ? "không rõ" : "phản hồi không phải JSON");
    return { audio: null, note: `không có audio (finishReason=${why})`, retryable: true, kind: "empty" };
  }

  const mime = part?.inlineData?.mimeType ?? "";
  if (mime && !/l16|pcm|linear/i.test(mime)) {
    throw new HttpError(
      502,
      "GEMINI_TTS_FORMAT",
      `Gemini trả định dạng audio lạ (${mime}) - code này chỉ xử lý PCM 16-bit. Báo lỗi để cập nhật server.`,
    );
  }
  const { sampleRate, channels } = parsePcmMime(mime);
  return {
    audio: { pcm: Buffer.from(b64, "base64"), sampleRate, channels, model: input.model },
    note: "",
    retryable: false,
    kind: "ok",
  };
}

/** Số giây của một khối PCM thô */
function pcmSeconds(bytes: number, sampleRate: number, channels: number): number {
  return bytes / (sampleRate * channels * 2);
}

/**
 * Gọi API và thử lại cho tới khi có audio dùng được.
 *
 * Ba ca phải bắt: (1) 200 nhưng thiếu hẳn phần audio, (2) audio ngắn bất thường
 * (gần như im lặng), (3) "lảm nhảm vô tận" - model lặp lại một đoạn tới hàng
 * phút. Cả ba đều là 200 OK nên nếu chỉ tin HTTP status thì người dùng lãnh đủ.
 */
async function synthRaw(input: {
  text: string;
  voice: string;
  /** Mã ngôn ngữ speechConfig.languageCode, vd "vi-VN" - bỏ trống cũng được */
  language?: string;
  model?: string | null;
  style?: string;
  onLog?: (line: string) => void;
  isCanceled?: () => boolean;
}): Promise<RawAudio> {
  const text = withStyle(input.text.trim(), input.style);
  if (!text) throw new HttpError(400, "TTS_EMPTY_TEXT", "Không có chữ nào để đọc");
  const model = resolveModel(input.model);
  const voice = (input.voice || DEFAULT_TTS_VOICE).trim();
  // Model đọc chậm nhất đo được ~14,9 ký tự/giây; cho hẳn 3 phút cho một đoạn 800 ký tự
  const timeoutMs = Math.min(300_000, 60_000 + text.length * 200);
  // Ngưỡng "lảm nhảm": gấp 3 lần thời lượng hợp lý cộng 20s dư - đã đo được ca 588s
  const sane = text.length / 14.9;
  const maxSec = sane * 3 + 20;

  const maxAttempts =
    text.length < TTS_CHUNK_SAFE_MIN_CHARS * 2 ? SHORT_TEXT_ATTEMPTS : MAX_ATTEMPTS;

  let lastNote = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (input.isCanceled?.()) throw new Error("Job đã bị hủy");
    const { audio, note, retryable, kind } = await callTtsOnce({
      text,
      voice,
      model,
      language: input.language,
      timeoutMs,
      isCanceled: input.isCanceled,
    });
    // Rỗng thì gọi lại được ngay (không phải bị chặn); chỉ lỗi HTTP mới phải lùi dần
    const backoff = kind === "http";
    if (audio) {
      const sec = pcmSeconds(audio.pcm.length, audio.sampleRate, audio.channels);
      if (sec < 0.3) {
        lastNote = `audio quá ngắn (${sec.toFixed(2)}s)`;
      } else if (sec > maxSec) {
        lastNote = `audio dài bất thường ${sec.toFixed(1)}s (hợp lý ~${sane.toFixed(1)}s) - nghi model lặp vô tận`;
      } else {
        if (attempt > 1) input.onLog?.(`[tts] lần ${attempt} đã có tiếng (${sec.toFixed(2)}s)`);
        return audio;
      }
    } else {
      lastNote = note;
      if (!retryable) break;
    }
    if (attempt < maxAttempts) {
      const wait = backoff
        ? RETRY_DELAY_MS[Math.min(attempt - 1, RETRY_DELAY_MS.length - 1)]
        : EMPTY_RETRY_DELAY_MS;
      input.onLog?.(`[tts] ${lastNote} - thử lại lần ${attempt + 1}/${maxAttempts} sau ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new HttpError(
    502,
    "GEMINI_TTS_NO_AUDIO",
    `Gemini không trả về giọng đọc sau ${maxAttempts} lần thử (${lastNote}). ` +
      (text.length < TTS_CHUNK_SAFE_MIN_CHARS * 2
        ? "Câu quá ngắn hay bị model bỏ qua - viết dài thêm vài chữ rồi thử lại."
        : "Thử rút ngắn đoạn hoặc đổi giọng/model rồi chạy lại."),
  );
}

/** Ghép header WAV 44 byte vào PCM thô - dùng khi không muốn/không gọi được ffmpeg */
export function pcmToWavBuffer(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); // kích thước khối fmt
  h.writeUInt16LE(1, 20); // 1 = PCM không nén
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(channels * 2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Một đoạn -> file PCM. Trả về đường dẫn tuyệt đối + số byte. */
export async function synthChunk(input: {
  text: string;
  voice: string;
  /** Mã ngôn ngữ speechConfig.languageCode, vd "vi-VN" - bỏ trống cũng được */
  language?: string;
  model?: string | null;
  style?: string;
  outPcmAbs: string;
  onLog?: (line: string) => void;
}): Promise<{ pcmAbs: string; bytes: number }> {
  const audio = await synthRaw(input);
  ensureDir(path.dirname(input.outPcmAbs));
  fs.writeFileSync(input.outPcmAbs, audio.pcm);
  return { pcmAbs: input.outPcmAbs, bytes: audio.pcm.length };
}

/**
 * Áp tốc độ đọc lên một WAV đã nằm trong bộ nhớ.
 *
 * Dùng ĐÚNG bộ lọc atempo mà synthScript dùng, không phải một cách khác cho
 * nhanh: nghe thử mà xử lý khác lúc dựng thật thì bản nghe thử nói dối. (Cách
 * rẻ hơn là để trình duyệt đổi `playbackRate`, nhưng thuật toán giãn thời gian
 * của trình duyệt khác atempo, nên nghe ra sẽ không đúng thứ sắp nhận được.)
 *
 * Đi qua file tạm chứ không pipe: ffmpeg ghi WAV ra stdout thì không quay lại
 * sửa được kích thước trong header, để lại 0xFFFFFFFF - có trình duyệt nuốt,
 * có trình duyệt không.
 */
export async function applySpeedToWav(wav: Buffer, speed: number): Promise<Buffer> {
  if (Math.abs(speed - 1) < 0.001) return wav;
  ensureDir(paths.uploadTmpDir);
  const stem = path.join(paths.uploadTmpDir, `tts-speed-${process.pid}-${Date.now()}`);
  const srcAbs = `${stem}.in.wav`;
  const dstAbs = `${stem}.out.wav`;
  try {
    fs.writeFileSync(srcAbs, wav);
    await runFfmpeg(
      [
        "-i",
        srcAbs,
        "-filter:a",
        `atempo=${speed.toFixed(3)}`,
        "-ar",
        String(OUT_SAMPLE_RATE),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        dstAbs,
      ],
      { timeoutMs: 60_000 },
    );
    return fs.readFileSync(dstAbs);
  } finally {
    fs.rmSync(srcAbs, { force: true });
    fs.rmSync(dstAbs, { force: true });
  }
}

/** Đọc thử một câu ngắn -> WAV nằm trong bộ nhớ (không đụng đĩa, không cần ffmpeg) */
export async function synthPreviewWav(input: {
  text: string;
  voice: string;
  /** Mã ngôn ngữ speechConfig.languageCode, vd "vi-VN" - bỏ trống cũng được */
  language?: string;
  model?: string | null;
  style?: string;
}): Promise<{ wav: Buffer; durationSec: number; model: string }> {
  const audio = await synthRaw(input);
  return {
    wav: pcmToWavBuffer(audio.pcm, audio.sampleRate, audio.channels),
    durationSec: pcmSeconds(audio.pcm.length, audio.sampleRate, audio.channels),
    model: audio.model,
  };
}

// ---------------------------------------------------------------------------
// Ghép đoạn
// ---------------------------------------------------------------------------

/**
 * Cắt khoảng lặng ở HAI ĐẦU đoạn (mỗi đoạn model trả về kèm ~0,25s im lặng mỗi
 * đầu; nối thẳng là mỗi mối nối hở nửa giây).
 *
 * TUYỆT ĐỐI KHÔNG đổi sang dạng stop_periods=-1: dạng đó cắt cả khoảng lặng BÊN
 * TRONG câu, phá sạch nhịp ngắt nghỉ (đo được 22,94s tụt còn 20,79s trên cùng
 * một đoạn). Cách đúng là cắt đầu, lộn ngược, cắt đầu lần nữa, lộn lại.
 */
const TRIM_FILTER =
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05," +
  "areverse," +
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05," +
  "areverse";

async function runFfmpeg(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; isCanceled?: () => boolean },
): Promise<void> {
  let r: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    r = await execFileCaptureAll("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 120_000,
      isCanceled: opts.isCanceled,
    });
  } catch (err) {
    throw new HttpError(
      503,
      "NO_FFMPEG",
      `Không chạy được ffmpeg - cài FFmpeg và thêm vào PATH. Chi tiết: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (r.canceled) throw new Error("Job đã bị hủy");
  if (r.timedOut) throw new Error("ffmpeg chạy quá lâu khi ghép giọng đọc - đã hủy");
  if (r.code !== 0) {
    const tail = r.stderr.split(/\r?\n/).slice(-12).join("\n");
    throw new Error(`ffmpeg thất bại khi ghép giọng đọc (mã ${r.code}):\n${tail}`);
  }
}

/**
 * Lệch bao nhiêu so với F0 chuẩn thì coi là ĐỔI NGƯỜI NÓI.
 *
 * 18%: giọng cùng một người lên xuống theo câu (hỏi, nhấn mạnh) nhưng hiếm khi
 * quá ~15%; còn ca đổi giọng đo được là 190 Hz so với chuẩn 120 Hz, tức 58%.
 * Đặt 18% thì bắt được ca thật mà không đọc lại oan vì ngữ điệu.
 */
const VOICE_DRIFT_TOLERANCE = 0.18;

/**
 * Ngưỡng RIÊNG khi chuẩn là F0 trong VOICE_CATALOG (0.22, rộng hơn 0.18).
 *
 * F0 trong catalog được đo trên MỘT câu mẫu khác hẳn kịch bản đang đọc, nên
 * cùng một giọng đọc câu khác vẫn lệch so với catalog nhiều hơn là lệch so với
 * trung vị của chính lần chạy này (cùng kịch bản, cùng phiên). Giữ 0.18 cho
 * đường trung vị; nới lên 0.22 cho đường catalog để không đọc lại oan.
 */
const VOICE_DRIFT_TOLERANCE_CATALOG = 0.22;
const VOICE_DRIFT_RETRIES = 2;

/**
 * F0 trung vị (Hz) của một file WAV PCM 16-bit mono - dùng để nhận ra đoạn nào
 * bị model đọc bằng giọng khác. Trả 0 nếu không đo được (file lặng, quá ngắn).
 *
 * Tự cài bằng autocorrelation thay vì kéo thêm thư viện: chỉ cần TƯƠNG ĐỐI
 * chính xác để so các đoạn với nhau, không phải phân tích âm học nghiêm túc.
 */
export function medianF0OfWav(absFile: string): number {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absFile);
  } catch {
    return 0;
  }
  // Tìm chunk "data" thay vì tin header luôn dài đúng 44 byte
  let pos = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "data") {
      dataOff = pos + 8;
      dataLen = Math.min(size, buf.length - dataOff);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataOff < 0 || dataLen < 4096) return 0;
  const sampleRate = buf.length > 28 ? buf.readUInt32LE(24) : 48_000;
  const n = Math.floor(dataLen / 2);
  const at = (i: number): number => buf.readInt16LE(dataOff + i * 2);

  const win = Math.floor(sampleRate * 0.04);
  const lagLo = Math.floor(sampleRate / 320); // 320 Hz
  const lagHi = Math.floor(sampleRate / 70); //  70 Hz
  if (win <= lagHi) return 0;

  const found: number[] = [];
  for (let start = 0; start + win < n; start += win) {
    // Bỏ cửa sổ gần như im lặng - autocorrelation trên nhiễu ra số vô nghĩa
    let energy = 0;
    for (let i = 0; i < win; i += 4) energy += Math.abs(at(start + i));
    if (energy / (win / 4) < 500) continue;

    let bestLag = 0;
    let bestVal = 0;
    for (let lag = lagLo; lag < lagHi; lag++) {
      let sum = 0;
      // bước 4 mẫu: nhanh gấp 4 mà đỉnh tương quan vẫn rõ
      for (let i = 0; i + lag < win; i += 4) sum += at(start + i) * at(start + i + lag);
      if (sum > bestVal) {
        bestVal = sum;
        bestLag = lag;
      }
    }
    if (bestLag > 0) found.push(sampleRate / bestLag);
  }
  if (found.length === 0) return 0;
  found.sort((a, b) => a - b);
  return found[Math.floor(found.length / 2)];
}

/** Đo thời lượng bằng ffprobe - KHÔNG bao giờ suy ra từ số ký tự (lệch tới 28%) */
async function probeSeconds(
  absFile: string,
  isCanceled?: () => boolean,
): Promise<number> {
  const r = await execFileCaptureAll(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absFile],
    { timeoutMs: 20_000, isCanceled },
  );
  if (r.canceled) throw new Error("Job đã bị hủy");
  const sec = parseFloat(r.stdout.trim());
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new HttpError(
      503,
      "NO_FFPROBE",
      `Không đo được thời lượng file ${path.basename(absFile)} bằng ffprobe - cài FFmpeg và thêm vào PATH.`,
    );
  }
  return sec;
}

/** Cả kịch bản -> một WAV 48kHz mono đã ghép. durationSec là số ĐO ĐƯỢC bằng ffprobe. */
export async function synthScript(input: {
  chunks: string[];
  voice: string;
  /**
   * Engine đọc. Chỉ khâu SINH TIẾNG của từng đoạn là khác nhau; cắt lặng hai
   * đầu, chèn nhịp nghỉ và ghép file thì dùng chung - hai engine mà hai cách
   * ghép là chắc chắn nhịp đọc lệch nhau, người dùng nghe ra ngay.
   */
  engine?: TtsEngine;
  /** Tốc độ đọc, 1 = giữ nguyên - áp bằng atempo sau khi ghép xong */
  speed?: number;
  /** Mã ngôn ngữ speechConfig.languageCode, vd "vi-VN" - bỏ trống cũng được */
  language?: string;
  model?: string | null;
  style?: string;
  workDir: string;
  outWavAbs: string;
  onProgress?: (done: number, total: number) => void;
  onLog?: (line: string) => void;
  isCanceled?: () => boolean;
}): Promise<{ wavAbs: string; durationSec: number; chunkDurations: number[] }> {
  const chunks = input.chunks.map((c) => c.trim()).filter(Boolean);
  if (chunks.length === 0) {
    throw new HttpError(400, "TTS_EMPTY_SCRIPT", "Kịch bản rỗng - chưa có gì để đọc");
  }
  ensureDir(input.workDir);
  ensureDir(path.dirname(input.outWavAbs));
  const total = chunks.length;
  const partNames: string[] = [];
  const chunkDurations: number[] = [];

  /**
   * Dựng MỘT đoạn ra file part-XXX.wav. Tách thành hàm vì bước dò giọng lệch ở
   * dưới phải gọi lại đúng quy trình này cho những đoạn cần đọc lại.
   */
  const renderChunk = async (i: number): Promise<void> => {
    if (input.isCanceled?.()) throw new Error("Job đã bị hủy");
    const idx = String(i + 1).padStart(3, "0");
    const pcmAbs = path.join(input.workDir, `chunk-${idx}.pcm`);
    const wavName = `part-${idx}.wav`;
    const wavAbs = path.join(input.workDir, wavName);

    if (input.engine === "vieneu") {
      // Engine trên máy đã trả thẳng WAV 48kHz mono (đúng OUT_SAMPLE_RATE) nên
      // không phải dựng header hay đổi tần số - nhưng VẪN đi qua TRIM_FILTER
      // như đường Gemini: mọi engine đều để lại chút lặng ở hai đầu, mà chỗ nối
      // hở nửa giây thì nghe rõ hơn bất kỳ khác biệt chất giọng nào.
      const rawWavAbs = path.join(input.workDir, `raw-${idx}.wav`);
      await synthLocalChunkWav({
        text: chunks[i],
        voice: input.voice,
        outWavAbs: rawWavAbs,
        onLog: input.onLog,
        isCanceled: input.isCanceled,
      });
      await runFfmpeg(
        [
          "-i",
          rawWavAbs,
          "-af",
          TRIM_FILTER,
          "-ar",
          String(OUT_SAMPLE_RATE),
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          wavAbs,
        ],
        { timeoutMs: 120_000, isCanceled: input.isCanceled },
      );
      fs.rmSync(rawWavAbs, { force: true });
    } else {
      const audio = await synthRaw({
        text: chunks[i],
        voice: input.voice,
        model: input.model,
        style: input.style,
        language: input.language,
        onLog: input.onLog,
        isCanceled: input.isCanceled,
      });
      fs.writeFileSync(pcmAbs, audio.pcm);

      // PCM thô -> WAV: cờ định dạng đầu vào PHẢI đứng TRƯỚC -i, nếu không ffmpeg
      // coi file là container và bỏ cuộc vì không có header.
      await runFfmpeg(
        [
          "-f",
          "s16le",
          "-ar",
          String(audio.sampleRate),
          "-ac",
          String(audio.channels),
          "-i",
          pcmAbs,
          "-af",
          TRIM_FILTER,
          "-ar",
          String(OUT_SAMPLE_RATE),
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          wavAbs,
        ],
        { timeoutMs: 120_000, isCanceled: input.isCanceled },
      );
    }
    partNames[i] = wavName;
    chunkDurations[i] = await probeSeconds(wavAbs, input.isCanceled);
    fs.rmSync(pcmAbs, { force: true });
  };

  for (let i = 0; i < total; i++) {
    input.onLog?.(`[tts] đoạn ${i + 1}/${total} (${chunks[i].length} ký tự)`);
    await renderChunk(i);
    input.onProgress?.(i + 1, total);
  }

  // ---- Chống ĐỔI GIỌNG giữa chừng ------------------------------------------
  //
  // ĐO ĐƯỢC, KHÔNG PHẢI PHÒNG XA: đọc 4 đoạn liền nhau bằng cùng một giọng
  // ("Charon", nam ~126 Hz) thì đoạn 2 trả về F0 190 Hz - tức là một người khác
  // hẳn, giọng nữ. Mỗi lần gọi API là một lần sinh độc lập, không có gì buộc
  // model giữ nguyên người nói. Người xem nghe ra ngay ở chỗ nối.
  //
  // Chia hai bước, đừng gộp - mục tiêu thật là các đoạn ĐỒNG NHẤT VỚI NHAU:
  //
  // 1. KÍCH HOẠT bằng độ đồng nhất nội bộ: đo F0 mọi đoạn, lấy trung vị m của
  //    lần chạy. Nếu MỌI đoạn đều trong 18% quanh m thì cả bài là MỘT giọng -
  //    không làm gì, kể cả khi cả cụm lệch xa catalog. Lý do: input.style áp
  //    cho mọi đoạn, một style hợp lệ (vd đọc hào hứng lên tông trên giọng
  //    trầm) đẩy F0 CẢ BÀI lệch catalog như nhau; so thẳng với catalog là đọc
  //    lại toàn bộ mất tiền (tới ~3 lần chi phí Gemini) mà bản mới vẫn y hệt.
  // 2. Có ít nhất một đoạn lệch quá 18% so với m (tức là bài KHÔNG đồng nhất)
  //    thì mới cần TRỌNG TÀI để biết cụm nào đúng: F0 trong VOICE_CATALOG của
  //    giọng người dùng CHỌN (chỉ Gemini - catalog là giọng dựng sẵn của
  //    Gemini). Chuẩn này không phụ thuộc lần chạy nên xử được ca ĐA SỐ đoạn
  //    cùng trôi sang giọng khác: lấy m làm chuẩn thì chính giọng SAI thành
  //    chuẩn, đoạn đúng bị "sửa" theo giọng sai. Giọng ngoài catalog thì dùng
  //    m như cũ (trung vị chịu được thiểu số lệch, trung bình thì không) và
  //    vẫn đòi đủ 3 mẫu đo được.
  //
  // Một đoạn thì bỏ qua hẳn: không thể lệch với chính nó, mà lệch đều so với
  // catalog thì không phân biệt được với style. Hai đoạn + catalog thì bước 1
  // vẫn chạy: trung vị của hai là một trong hai, hai đoạn vênh nhau quá 18%
  // là catalog đứng ra phân xử.
  //
  // GIỚI HẠN ĐÃ BIẾT: so bằng F0 thì KHÔNG bắt được ca đổi giữa hai giọng có
  // cao độ gần bằng nhau (vd Sadachbia 125 Hz sang Sadaltager 125 Hz) - khác
  // âm sắc nhưng cùng cao độ thì phép đo này mù.
  if (total >= 2) {
    const f0s = partNames.map((n) => medianF0OfWav(path.join(input.workDir, n)));
    const usable = f0s.filter((v) => v > 0).sort((a, b) => a - b);
    const m = usable.length >= 2 ? usable[Math.floor(usable.length / 2)] : 0;
    const uniform =
      m > 0 &&
      f0s.every((v) => v <= 0 || Math.abs(v - m) / m <= VOICE_DRIFT_TOLERANCE);
    let ref = 0;
    let tol = VOICE_DRIFT_TOLERANCE;
    if (m > 0 && !uniform) {
      const catalogF0 =
        input.engine === "vieneu"
          ? 0
          : VOICE_CATALOG.find(
              (v) => v.name.toLowerCase() === input.voice.toLowerCase(),
            )?.f0 ?? 0;
      if (catalogF0 > 0) {
        ref = catalogF0;
        // Catalog đo trên câu khác kịch bản nên ngưỡng phải rộng hơn - xem chú
        // thích ở VOICE_DRIFT_TOLERANCE_CATALOG
        tol = VOICE_DRIFT_TOLERANCE_CATALOG;
        input.onLog?.(
          `[tts] các đoạn lệch giọng nhau - chuẩn giọng "${input.voice}" ${ref.toFixed(0)} Hz (catalog)`,
        );
      } else if (usable.length >= 3) {
        ref = m;
        input.onLog?.(
          `[tts] các đoạn lệch giọng nhau - chuẩn giọng "${input.voice}" ${ref.toFixed(0)} Hz (trung vị lần chạy)`,
        );
      }
    }
    if (ref > 0) {
      const off = (v: number): number => (v > 0 ? Math.abs(v - ref) / ref : 0);
      for (let i = 0; i < total; i++) {
        if (off(f0s[i]) <= tol) continue;
        input.onLog?.(
          `[tts] đoạn ${i + 1} lệch giọng (F0 ${f0s[i].toFixed(0)} Hz so với chuẩn ${ref.toFixed(0)} Hz) - đọc lại`,
        );
        let best = f0s[i];
        const keepAbs = path.join(input.workDir, `keep-${i}.wav`);
        fs.copyFileSync(path.join(input.workDir, partNames[i]), keepAbs);
        for (let attempt = 1; attempt <= VOICE_DRIFT_RETRIES; attempt++) {
          await renderChunk(i);
          const got = medianF0OfWav(path.join(input.workDir, partNames[i]));
          if (off(got) < off(best)) {
            best = got;
            fs.copyFileSync(path.join(input.workDir, partNames[i]), keepAbs);
          }
          if (off(got) <= tol) break;
        }
        // Giữ bản GẦN CHUẨN NHẤT trong mọi lần thử - đọc lại mà tệ hơn thì quay
        // về bản cũ, chứ không phải cứ lần cuối là lấy
        fs.copyFileSync(keepAbs, path.join(input.workDir, partNames[i]));
        fs.rmSync(keepAbs, { force: true });
        chunkDurations[i] = await probeSeconds(
          path.join(input.workDir, partNames[i]),
          input.isCanceled,
        );
        if (off(best) > tol) {
          input.onLog?.(
            `[tts] đoạn ${i + 1} vẫn lệch sau ${VOICE_DRIFT_RETRIES} lần - giữ bản gần nhất (F0 ${best.toFixed(0)} Hz)`,
          );
        }
      }
    }
  }

  if (partNames.length === 1) {
    fs.copyFileSync(path.join(input.workDir, partNames[0]), input.outWavAbs);
  } else {
    // Chèn một nhịp lặng CÓ KIỂM SOÁT giữa hai đoạn - đã cắt sạch lặng ở hai đầu
    // nên nếu không chèn thì hai câu dính liền, nghe như hụt hơi.
    const gapName = "gap.wav";
    await runFfmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        `anullsrc=r=${OUT_SAMPLE_RATE}:cl=mono`,
        "-t",
        String(TTS_GAP_SEC),
        "-c:a",
        "pcm_s16le",
        path.join(input.workDir, gapName),
      ],
      { timeoutMs: 30_000, isCanceled: input.isCanceled },
    );
    // Danh sách dùng TÊN TƯƠNG ĐỐI + chạy ffmpeg với cwd=workDir: đường dẫn
    // Windows có dấu \ và dấu : làm cú pháp concat hiểu sai.
    const listName = "concat.txt";
    const lines: string[] = [];
    partNames.forEach((n, i) => {
      if (i > 0) lines.push(`file '${gapName}'`);
      lines.push(`file '${n}'`);
    });
    fs.writeFileSync(path.join(input.workDir, listName), lines.join("\n") + "\n", "utf8");
    await runFfmpeg(
      [
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listName,
        "-ar",
        String(OUT_SAMPLE_RATE),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        input.outWavAbs,
      ],
      { cwd: input.workDir, timeoutMs: 300_000, isCanceled: input.isCanceled },
    );
  }

  // Tăng/giảm tốc ĐỘ ĐỌC - làm ở đây, tức là SAU khi ghép và TRƯỚC khi ai đó
  // đo thời lượng hay chạy transcript. Làm sau bước transcript thì mọi mốc thời
  // gian từng từ (phụ đề karaoke, zoom theo nhịp, sound effect) lệch hết.
  const speed = input.speed ?? 1;
  if (Math.abs(speed - 1) > 0.001) {
    const spedAbs = path.join(input.workDir, "speed.wav");
    await runFfmpeg(
      [
        "-i",
        input.outWavAbs,
        // atempo giữ nguyên CAO ĐỘ giọng, chỉ đổi nhịp - đổi sample rate thì
        // giọng bị the như hoạt hình. Một tầng atempo chạy đúng trong 0.5-2.0,
        // mà dải cho phép của ta là 0.8-1.6 nên không cần nối tầng.
        "-filter:a",
        `atempo=${speed.toFixed(3)}`,
        "-ar",
        String(OUT_SAMPLE_RATE),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        spedAbs,
      ],
      { timeoutMs: 300_000, isCanceled: input.isCanceled },
    );
    fs.rmSync(input.outWavAbs, { force: true });
    fs.renameSync(spedAbs, input.outWavAbs);
    // Thời lượng từng đoạn đo TRƯỚC khi tăng tốc - phải quy đổi, nếu không UI
    // hiện một đằng còn file dài một nẻo
    for (let i = 0; i < chunkDurations.length; i++) chunkDurations[i] /= speed;
    input.onLog?.(`[tts] tăng tốc đọc x${speed}`);
  }

  const durationSec = await probeSeconds(input.outWavAbs, input.isCanceled);

  // Dọn file trung gian CHỈ khi đã ghép xong: WAV 48kHz mono ngốn ~96KB/giây,
  // một bài 5 phút để lại tới gần 30MB rác. Ngược lại, khi hỏng giữa chừng thì
  // giữ nguyên mọi mảnh trong workDir để còn nghe lại chỗ sai.
  for (const n of partNames) fs.rmSync(path.join(input.workDir, n), { force: true });
  fs.rmSync(path.join(input.workDir, "gap.wav"), { force: true });
  fs.rmSync(path.join(input.workDir, "concat.txt"), { force: true });

  input.onLog?.(`[tts] xong ${total} đoạn - giọng đọc dài ${durationSec.toFixed(2)}s (đo bằng ffprobe)`);
  return { wavAbs: input.outWavAbs, durationSec, chunkDurations };
}
