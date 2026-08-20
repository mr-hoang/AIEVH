import fs from "node:fs";
import path from "node:path";
import { TTS_CHUNK_MAX_CHARS } from "./textToVideoMeta.js";
import { extractAudioWav } from "./transcribe.js";
import type { TranslatedCue } from "./translateVideoMeta.js";
import {
  DEFAULT_TTS_LANGUAGE,
  DEFAULT_TTS_VOICE,
  TTS_LANGUAGES,
  applySpeedToWav,
  chunkForTts,
  medianF0OfWav,
  synthScript,
} from "./tts.js";
import type { TtsEngine, TtsGender, TtsVoice } from "./ttsTypes.js";
import { HttpError, ensureDir, execFileCaptureAll, ffprobeDurationMs } from "./util.js";

/**
 * Lồng tiếng (dub) cho phiên "Dịch video" - nửa còn lại của tính năng, song song
 * với đường ghép phụ đề.
 *
 * ================= VẤN ĐỀ CỐT LÕI: ISOCHRONY =================
 *
 * Câu dịch KHÔNG bao giờ dài đúng bằng câu gốc. Tiếng Việt dịch từ tiếng Anh
 * thường dài hơn 10-25% khi đọc thành tiếng. Nếu cứ đọc rồi nối đuôi nhau thì
 * tới phút thứ hai giọng đọc đã chạy trước/sau hình cả chục giây - đó là lỗi
 * nặng nhất của mọi bản lồng tiếng tự làm.
 *
 * Nghề lồng tiếng giải bằng BA đòn bẩy, ở đây dùng hai:
 *
 *  1. DỊCH CÓ KHỐNG CHẾ ĐỘ DÀI - đã làm sẵn ở `translate.ts` (mode "dub" gửi kèm
 *     thời lượng từng câu, model được dặn chọn cách diễn đạt ngắn hơn, nhắm +-10%).
 *  2. CO GIÃN THỜI GIAN MỘT LƯỢNG NHỎ - chính là file này (xem DUB_TEMPO_MAX).
 *  3. Khớp khẩu hình (lip-sync) - CỐ Ý KHÔNG LÀM. Muốn khớp môi thì phải sinh
 *     lại hình, đó là một hệ thống khác hẳn.
 *
 * ================= NGUYÊN TẮC LẮP RÁP =================
 *
 * Mỗi câu được đặt ở MỐC TUYỆT ĐỐI của nó trên một track lặng dài đúng bằng
 * video nguồn - giống hệt cách `sfx[].atFrame` làm bên Remotion. TUYỆT ĐỐI
 * KHÔNG nối đuôi các câu lại với nhau: nối đuôi thì mỗi câu lệch một chút và
 * sai số CỘNG DỒN, còn đặt tuyệt đối thì sai số của câu này không dính sang câu
 * kia (tối đa nửa mili giây do làm tròn về ms của adelay).
 */

// ---------------------------------------------------------------------------
// Hằng số đã cân nhắc
// ---------------------------------------------------------------------------

/**
 * TRẦN co nhanh giọng đọc = 1.25.
 *
 * Vì sao có trần, và vì sao là 1.25:
 * - Tai người bắt đầu nhận ra nhịp đọc bị đổi ở khoảng 10-15%. Dưới mức đó,
 *   atempo (giữ nguyên cao độ, chỉ đổi nhịp) coi như tàng hình.
 * - Từ ~1.3x trở lên giọng nghe rõ là "bị tua": phụ âm dính vào nhau, câu tiếng
 *   Việt nhiều thanh điệu bị mất chỗ ngân nên nghe méo trước cả khi nghe nhanh.
 * - 1.25 là điểm dừng: vẫn còn nhét thêm được ~20% chữ, mà chưa sang vùng nghe
 *   ra ngay. Quá mức đó thì THÀ để câu tràn một chút sang khoảng nghỉ phía sau
 *   còn hơn - một chỗ chồng nhẹ dễ chịu hơn một câu nghe như chạy trốn.
 *
 * SÀN = 1.0, tức KHÔNG BAO GIỜ đọc chậm lại.
 * Câu dịch ngắn hơn câu gốc thì chỗ dư là khoảng LẶNG, và im lặng đúng chỗ nghe
 * hoàn toàn tự nhiên. Kéo giãn giọng ra cho đầy chỗ trống thì ngược lại: nghe
 * như người đọc bị đuối, và đó là thứ tai bắt được nhanh hơn cả đọc nhanh.
 */
export const DUB_TEMPO_MIN = 1.0;
export const DUB_TEMPO_MAX = 1.25;

/**
 * Vùng chết: lệch dưới 2% thì KHÔNG đụng vào file.
 * Mỗi lần chạy atempo là một lần giải mã + mã hóa lại WAV; đổi 1% thời lượng
 * không ai nghe ra nhưng vẫn tốn một lượt ffmpeg cho mỗi câu.
 */
export const DUB_TEMPO_DEADBAND = 0.02;

/**
 * Được phép "mượn" bao nhiêu giây đầu của khoảng nghỉ phía sau mà KHÔNG phải co.
 *
 * NGUYÊN TẮC: co giãn tồn tại để BẢO VỆ CÂU KẾ TIẾP, không phải để bảo vệ sự im
 * lặng. Câu dịch dài hơn câu gốc mà phía sau là một khoảng nghỉ thì cứ để nó nói
 * nốt vào khoảng nghỉ - không ai bị chồng tiếng, và tránh được một lần xử lý tín
 * hiệu nghe ra được.
 *
 * Vì sao vẫn phải có TRẦN 1 giây chứ không mượn cả khoảng nghỉ: quá một giây thì
 * lời nói bắt đầu rơi sang cảnh sau, người xem thấy lời không còn dính với hình.
 * Một giây là mức vừa đủ để gần như mọi câu dịch dài hơn 10-20% khỏi phải co,
 * mà lời vẫn bám hình.
 *
 * Luôn kẹp theo khoảng nghỉ THẬT (min với gap): hai câu dính nhau thì mượn = 0
 * và luật này tự tắt.
 *
 * ĐÃ ĐO BẰNG SỐ GIẢ (xem báo cáo): để 0,3s thì câu cuối video có 30 giây trống
 * phía sau vẫn bị ép co x1,25 - hoàn toàn vô ích vì chẳng có gì để va vào.
 */
export const DUB_BLEED_FREE_SEC = 1.0;

/**
 * Lấn sang câu kế tiếp bao nhiêu thì vẫn KHÔNG tính là "tràn".
 *
 * 120ms là độ dài một phụ âm đầu; cái đuôi câu trước nằm dưới âm đầu của câu sau
 * chừng đó thì tai nghe thành một nhịp nối, không thành hai người nói chồng nhau.
 *
 * Con số này CỘT với DUB_TEMPO_DEADBAND ở dưới: phần vượt mà vùng chết cho đi
 * qua không bao giờ được lớn hơn phần mà báo cáo coi là chấp nhận được, nếu
 * không thì hệ thống vừa tự cho phép vừa tự tố cáo chính mình.
 */
const DUB_OVERLAP_TOLERANCE_SEC = 0.12;

/** Ranh giới F0 nam/nữ (Hz) - xem ghi chú ở genderFromF0 */
export const F0_GENDER_BOUNDARY = 165;

/** Sample rate của track lồng tiếng - khớp track audio của Remotion */
const OUT_SAMPLE_RATE = 48_000;

/**
 * Số câu tối đa trộn trong MỘT lượt ffmpeg.
 *
 * Mỗi câu là một `-i` + một nhánh filter. Video 10 phút ra hơn 200 câu, dồn hết
 * vào một lệnh thì dòng lệnh phình quá trần của Windows (~32k ký tự) và ffmpeg
 * phải mở hơn 200 file cùng lúc. Chia lô rồi trộn các lô lại: kết quả GIỐNG HỆT
 * vì phép cộng tín hiệu có tính kết hợp, và mỗi lô vẫn dài đủ cả video nên mốc
 * tuyệt đối của từng câu không đổi.
 */
const MIX_BATCH = 96;

/**
 * Âm lượng giọng lồng khi CÒN giữ tiếng gốc chạy nhỏ bên dưới, và trần của
 * tiếng gốc.
 *
 * ĐÃ ĐO với hai track cùng đầy biên độ (ca xấu nhất, đỉnh trùng pha):
 *   0.85 + 0.15 = 1.00 -> đo được đúng -0.00 dB, tức là chạm sát trần
 *   0.85 + 0.12 = 0.97 -> đo được -0.27 dB, còn chỗ thở
 * Chọn 0.12: cộng hai track không bao giờ vượt đỉnh nên KHÔNG cần limiter, mà
 * không cần limiter thì giọng lồng không bị bóp động khi tiếng gốc to lên.
 */
const DUB_VOLUME_WITH_BED = 0.85;
export const DUB_ORIGINAL_VOLUME_MAX = 0.12;

/** Khóa "một giọng cho cả video" - dùng khi transcript không phân vai người nói */
export const DUB_ALL_SPEAKERS = "";

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

/** Một người nói -> một giọng đọc, cố định suốt cả video */
export interface DubVoiceAssignment {
  /** Nhãn người nói ("1"/"2" của Soniox, "A"/"B" của Gemini); "" = mọi câu */
  speaker: string;
  /** Tên giọng gửi cho engine (Gemini: "Kore"; VieNeu: id giọng) */
  voice: string;
  engine: TtsEngine;
}

/** Kết quả co giãn của MỘT câu - hàm thuần, kiểm tra được không cần TTS */
export interface DubFit {
  /** Hệ số atempo đã chọn (1 = không đụng vào file) */
  tempo: number;
  /** Thời lượng sau khi co (giây) */
  finalSec: number;
  /** Đã đụng TRẦN co: muốn co nhiều hơn nhưng không được phép */
  clipped: boolean;
  /** Vẫn tràn qua mốc câu KẾ TIẾP dù đã co hết mức - đây mới là ca xấu thật */
  overflowed: boolean;
}

export interface DubCueResult {
  /** Mốc trong video NGUỒN (giây) */
  start: number;
  end: number;
  speaker?: string;
  /** File WAV của riêng câu này (đã co giãn xong) */
  wavAbs: string;
  /** Thời lượng TTS đọc ra, trước khi co (đo bằng ffprobe) */
  naturalSec: number;
  /** Thời lượng sau khi co (đo lại bằng ffprobe) */
  finalSec: number;
  tempo: number;
  clipped: boolean;
  overflowed: boolean;
}

export interface DubResult {
  /** Track lồng tiếng dài đúng bằng video nguồn */
  wavAbs: string;
  durationSec: number;
  cues: DubCueResult[];
  assignments: DubVoiceAssignment[];
  /** Số câu phải co giãn (tempo != 1) */
  stretched: number;
  /** Số câu KHÔNG nhét vừa dù đã co tối đa - tràn sang mốc câu kế tiếp */
  overflowed: number;
  /** Số câu bị kẹp ở trần co (tràn qua mốc kết thúc của chính nó) */
  clipped: number;
  minTempo: number;
  maxTempo: number;
}

// ---------------------------------------------------------------------------
// Gán giọng
// ---------------------------------------------------------------------------

/**
 * Đoán giới tính người nói từ F0 (tần số cơ bản, Hz).
 *
 * Số quy chiếu chuẩn của âm học tiếng nói: giọng nam trưởng thành 85-180 Hz,
 * giọng nữ 165-255 Hz. Hai dải chồng nhau ở khúc 165-180, nên lấy 165 làm ranh
 * giới - phần chồng thuộc về "nữ trầm" nhiều hơn là "nam cao".
 *
 * 0 hoặc số vô nghĩa (không đo được - đoạn quá ngắn, quá lặng) trả "trung-tinh":
 * NÓI KHÔNG BIẾT chứ không đoán bừa. Đoán sai giới tính là lỗi người dùng nghe
 * ra ngay từ giây đầu tiên.
 */
export function genderFromF0(f0: number): TtsGender {
  if (!Number.isFinite(f0) || f0 <= 0) return "trung-tinh";
  return f0 < F0_GENDER_BOUNDARY ? "nam" : "nu";
}

export interface AutoAssignOptions {
  engine: TtsEngine;
  /**
   * Kho giọng để chọn - lấy từ `listVoices()` (Gemini) hoặc `listLocalVoices()`
   * (VieNeu). Truyền vào thay vì tự gọi để hàm này TẤT ĐỊNH và kiểm tra được:
   * đưa vào một kho giả + vài mức F0 giả là biết ngay nó chọn giọng nào.
   */
  voices: TtsVoice[];
  /** F0 đo được của từng người nói trong video nguồn (Hz); thiếu = 0 */
  speakerF0?: Record<string, number>;
  /** Giọng người dùng đã tự chọn - GIỮ NGUYÊN, chỉ gán tự động cho phần còn lại */
  locked?: Record<string, string>;
  /** Giọng mặc định khi không có gì để căn cứ */
  defaultVoice?: string;
}

interface VoiceCandidate {
  name: string;
  gender: TtsGender;
  f0: number;
  /** Thứ tự trong kho - dùng phá hòa để kết quả không đổi giữa hai lần chạy */
  index: number;
}

/**
 * Một giọng cho MỖI người nói, cố định suốt cả video.
 *
 * Luật, theo đúng thứ tự:
 *  1. Người nói nào người dùng đã chốt giọng (`locked`) thì giữ nguyên, và giọng
 *     đó bị đánh dấu "đã dùng" TRƯỚC khi gán tự động - nếu không thì phần tự
 *     động lại chọn trúng giọng ấy cho người khác.
 *  2. Đo được F0 -> ưu tiên giọng CÙNG GIỚI TÍNH, trong đó chọn giọng có F0 gần
 *     nhất. Giọng "trung-tinh" là hạng hai, giọng khác giới là hạng chót (chỉ
 *     dùng khi hết giọng cùng giới).
 *  3. Không đo được F0 -> chọn giọng KHÁC GIỚI với người vừa gán, để hai người
 *     trong một cuộc hội thoại nghe phân biệt được ngay cả khi ta mù về cao độ.
 *  4. KHÔNG BAO GIỜ hai người nói chung một giọng - trừ khi kho giọng cạn
 *     (hơn 30 người nói), lúc đó mới cho phép trùng chứ không bỏ ai không có giọng.
 *
 * Transcript không phân vai (faster-whisper) -> `speakers` rỗng -> trả đúng MỘT
 * gán với khóa DUB_ALL_SPEAKERS, tức một giọng đọc cho cả video.
 */
export function autoAssignVoices(
  speakers: string[],
  opts: AutoAssignOptions,
): DubVoiceAssignment[] {
  const engine = opts.engine;
  const pool: VoiceCandidate[] = [];
  const seen = new Set<string>();
  for (const v of opts.voices) {
    if (v.engine !== engine) continue;
    const name = (v.name ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    pool.push({
      name,
      gender: v.gender ?? "trung-tinh",
      f0: Number.isFinite(v.f0) && v.f0 > 0 ? v.f0 : 0,
      index: pool.length,
    });
  }
  // Kho rỗng (chưa cài engine offline / gọi danh sách lỗi) - vẫn phải trả về
  // một thứ chạy được, chứ không để bước lồng tiếng chết vì không có danh sách
  if (pool.length === 0) {
    pool.push({
      name: (opts.defaultVoice ?? DEFAULT_TTS_VOICE).trim() || DEFAULT_TTS_VOICE,
      gender: "trung-tinh",
      f0: 0,
      index: 0,
    });
  }

  const keys: string[] = [];
  for (const s of speakers) {
    const k = (s ?? "").trim();
    if (k && !keys.includes(k)) keys.push(k);
  }
  if (keys.length === 0) keys.push(DUB_ALL_SPEAKERS);

  const byName = new Map(pool.map((v) => [v.name.toLowerCase(), v]));
  const used = new Set<string>();
  const out: Array<DubVoiceAssignment | null> = keys.map(() => null);

  // --- Bước 1: giữ nguyên lựa chọn của người dùng --------------------------
  keys.forEach((k, i) => {
    const want = (opts.locked?.[k] ?? "").trim();
    if (!want) return;
    const hit = byName.get(want.toLowerCase());
    if (!hit) return; // giọng đã bị gỡ khỏi kho - để bước tự động gán lại
    out[i] = { speaker: k, voice: hit.name, engine };
    used.add(hit.name.toLowerCase());
  });

  // --- Bước 2: gán tự động phần còn lại ------------------------------------
  const defaultName = (opts.defaultVoice ?? DEFAULT_TTS_VOICE).toLowerCase();
  let lastGender: TtsGender | null = null;
  for (let i = 0; i < keys.length; i++) {
    if (out[i]) {
      lastGender = byName.get(out[i]!.voice.toLowerCase())?.gender ?? lastGender;
      continue;
    }
    const k = keys[i];
    const f0 = opts.speakerF0?.[k] ?? 0;
    let free = pool.filter((v) => !used.has(v.name.toLowerCase()));
    // Hết giọng chưa dùng: thà trùng giọng còn hơn có người nói không có giọng
    if (free.length === 0) free = pool;

    const want = genderFromF0(f0);
    const scored = free.map((v) => {
      let tier: number;
      let dist: number;
      if (want !== "trung-tinh") {
        tier = v.gender === want ? 0 : v.gender === "trung-tinh" ? 1 : 2;
        // Giọng chưa có số đo (VieNeu, giọng Google mới) xếp sau giọng đã đo
        dist = v.f0 > 0 ? Math.abs(v.f0 - f0) : 10_000;
      } else {
        // Mù về cao độ: cố cho hai người liền nhau khác giới tính giọng, và ưu
        // tiên giọng mặc định cho người đầu tiên
        const differs = lastGender === null || v.gender !== lastGender;
        tier = differs ? 0 : 1;
        dist = v.name.toLowerCase() === defaultName && lastGender === null ? -1 : 0;
      }
      return { v, tier, dist };
    });
    scored.sort((a, b) => a.tier - b.tier || a.dist - b.dist || a.v.index - b.v.index);
    const pick = scored[0].v;
    out[i] = { speaker: k, voice: pick.name, engine };
    used.add(pick.name.toLowerCase());
    lastGender = pick.gender;
  }

  return out.map((a, i) => a ?? { speaker: keys[i], voice: pool[0].name, engine });
}

/** Giọng của một câu - không có nhãn thì rơi về gán chung, cùng lắm là gán đầu tiên */
export function voiceForCue(
  assignments: DubVoiceAssignment[],
  speaker: string | undefined,
): DubVoiceAssignment {
  const key = (speaker ?? "").trim();
  return (
    assignments.find((a) => a.speaker === key) ??
    assignments.find((a) => a.speaker === DUB_ALL_SPEAKERS) ??
    assignments[0]
  );
}

// ---------------------------------------------------------------------------
// Đo cao độ người nói trong video NGUỒN
// ---------------------------------------------------------------------------

/** Số mẫu tối đa lấy cho mỗi người nói - 6 đoạn là đủ để trung vị ổn định */
const F0_SAMPLES_PER_SPEAKER = 6;
/** Mỗi mẫu dài tối đa bấy nhiêu giây (dài hơn không chính xác hơn, chỉ chậm hơn) */
const F0_SAMPLE_MAX_SEC = 4;
/** Đoạn ngắn hơn thì bỏ - medianF0OfWav cần ít nhất ~0,13s tiếng thật */
const F0_SAMPLE_MIN_SEC = 0.8;

/**
 * Cao độ (F0 trung vị, Hz) của TỪNG người nói, đo trên chính audio của video
 * nguồn - đây là căn cứ để gán giọng nam vào người nói giọng nam.
 *
 * Đo trên NHIỀU đoạn rồi lấy trung vị chứ không đo một đoạn: một câu hỏi lên
 * giọng cuối câu có thể đẩy F0 của đoạn đó lệch hẳn, trung vị của 6 đoạn thì
 * không.
 *
 * Trả về map rỗng (hoặc thiếu người) khi không đo được - phía gán giọng đã có
 * đường đi cho ca "mù cao độ", không bao giờ đoán bừa.
 */
export async function measureSpeakerF0(input: {
  videoAbs: string;
  cues: TranslatedCue[];
  workDir: string;
  onLog?: (line: string) => void;
  isCanceled?: () => boolean;
}): Promise<Record<string, number>> {
  const bySpeaker = new Map<string, TranslatedCue[]>();
  for (const c of input.cues) {
    const k = (c.speaker ?? "").trim();
    if (!k) continue;
    const list = bySpeaker.get(k) ?? [];
    list.push(c);
    bySpeaker.set(k, list);
  }
  if (bySpeaker.size === 0) return {};

  ensureDir(input.workDir);
  const srcWav = path.join(input.workDir, "source-16k.wav");
  if (!fs.existsSync(srcWav)) {
    await extractAudioWav({
      videoAbs: input.videoAbs,
      outWavAbs: srcWav,
      isCanceled: input.isCanceled,
    });
  }

  const out: Record<string, number> = {};
  for (const [speaker, cues] of bySpeaker) {
    const picks = [...cues]
      .filter((c) => c.end - c.start >= F0_SAMPLE_MIN_SEC)
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, F0_SAMPLES_PER_SPEAKER);
    const measured: number[] = [];
    for (let i = 0; i < picks.length; i++) {
      if (input.isCanceled?.()) throw new Error("Job đã bị hủy");
      const c = picks[i];
      // Lùi 0,1s khỏi mốc bắt đầu: mốc của bộ bóc lời hay dính chút lặng đầu câu
      const ss = Math.max(0, c.start + 0.1);
      const dur = Math.min(F0_SAMPLE_MAX_SEC, c.end - ss);
      if (dur < F0_SAMPLE_MIN_SEC) continue;
      const clip = path.join(input.workDir, `f0-${safeName(speaker)}-${i}.wav`);
      await runFfmpeg(
        [
          "-ss",
          ss.toFixed(3),
          "-t",
          dur.toFixed(3),
          "-i",
          srcWav,
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          clip,
        ],
        { timeoutMs: 30_000, isCanceled: input.isCanceled },
      );
      const f0 = medianF0OfWav(clip);
      fs.rmSync(clip, { force: true });
      if (f0 > 0) measured.push(f0);
    }
    if (measured.length === 0) continue;
    measured.sort((a, b) => a - b);
    const median = measured[Math.floor(measured.length / 2)];
    out[speaker] = Math.round(median);
    input.onLog?.(
      `[dub] người nói "${speaker}": F0 ${Math.round(median)} Hz (${measured.length} mẫu) -> nghe như giọng ${genderFromF0(median)}`,
    );
  }
  return out;
}

/** Nhãn người nói -> tên file an toàn (nhãn có thể là chữ có dấu do Gemini đặt) */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "spk";
}

// ---------------------------------------------------------------------------
// Toán co giãn - HÀM THUẦN, kiểm tra được không cần gọi TTS
// ---------------------------------------------------------------------------

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Nhét một câu đã đọc (dài `naturalSec`) vào chỗ của nó.
 *
 *  - `spanSec` = độ dài câu GỐC (cue.end - cue.start).
 *  - `gapSec`  = khoảng nghỉ tới câu KẾ TIẾP (câu cuối thì tới hết video).
 *
 * Chỗ được phép chiếm = spanSec + tối đa DUB_BLEED_FREE_SEC đầu khoảng nghỉ.
 * Vượt quá mới co, và chỉ co tới DUB_TEMPO_MAX. Còn dài hơn nữa thì ĐỂ NÓ TRÀN
 * chứ tuyệt đối không cắt cụt: cắt là mất chữ, mà mất chữ thì người xem không
 * hiểu được câu - tệ hơn nhiều so với việc nghe hai câu chồng nhẹ lên nhau.
 */
export function fitCue(naturalSec: number, spanSec: number, gapSec: number): DubFit {
  const natural = Math.max(0, naturalSec);
  const span = Math.max(0.01, spanSec);
  const gap = Math.max(0, Number.isFinite(gapSec) ? gapSec : 0);
  const allowance = span + Math.min(gap, DUB_BLEED_FREE_SEC);
  // "Phòng" thật sự: tới lúc người kế tiếp mở miệng
  const room = span + gap;

  // Vùng chết kẹp thêm bằng DUB_OVERLAP_TOLERANCE_SEC: 2% của một câu dài là
  // một khoảng lấn thật sự nghe ra được
  const slack = Math.min(allowance * DUB_TEMPO_DEADBAND, DUB_OVERLAP_TOLERANCE_SEC);
  if (natural <= allowance + slack) {
    return {
      tempo: 1,
      finalSec: round3(natural),
      clipped: false,
      overflowed: natural > room + DUB_OVERLAP_TOLERANCE_SEC,
    };
  }
  const ideal = natural / allowance;
  // Làm tròn 3 chữ số TRƯỚC khi tính lại thời lượng: atempo nhận đúng chuỗi
  // toFixed(3), nên số báo cáo phải là số ffmpeg thật sự chạy
  const tempo = round3(Math.min(DUB_TEMPO_MAX, Math.max(DUB_TEMPO_MIN, ideal)));
  const finalSec = natural / tempo;
  return {
    tempo,
    finalSec: round3(finalSec),
    clipped: ideal > DUB_TEMPO_MAX + 1e-9,
    overflowed: finalSec > room + DUB_OVERLAP_TOLERANCE_SEC,
  };
}

/** Khoảng nghỉ từ cue i tới cue kế tiếp (câu cuối: tới hết video) */
export function gapAfter(cues: TranslatedCue[], i: number, videoDurationSec: number): number {
  const cur = cues[i];
  const next = cues[i + 1];
  const until = next ? next.start : Math.max(cur.end, videoDurationSec);
  return Math.max(0, until - cur.end);
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

async function runFfmpeg(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; isCanceled?: () => boolean },
): Promise<void> {
  let r: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    r = await execFileCaptureAll("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 300_000,
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
  if (r.timedOut) throw new Error("ffmpeg chạy quá lâu khi ghép track lồng tiếng - đã hủy");
  if (r.code !== 0) {
    const tail = r.stderr.split(/\r?\n/).slice(-12).join("\n");
    throw new Error(`ffmpeg thất bại khi ghép track lồng tiếng (mã ${r.code}):\n${tail}`);
  }
}

async function probeSeconds(absFile: string): Promise<number> {
  const ms = await ffprobeDurationMs(absFile);
  if (ms === null || ms <= 0) {
    throw new HttpError(
      503,
      "NO_FFPROBE",
      `Không đo được thời lượng ${path.basename(absFile)} bằng ffprobe - cài FFmpeg và thêm vào PATH.`,
    );
  }
  return ms / 1000;
}

// ---------------------------------------------------------------------------
// Tổng hợp một câu
// ---------------------------------------------------------------------------

/** Mã ngôn ngữ TTS suy từ ngôn ngữ ĐÍCH của phiên dịch ("vi" -> "vi-VN") */
export function ttsLanguageFor(targetLang: string): string {
  const want = (targetLang ?? "").trim().toLowerCase();
  if (!want) return DEFAULT_TTS_LANGUAGE;
  const exact = TTS_LANGUAGES.find((l) => l.code.toLowerCase() === want);
  if (exact) return exact.code;
  const base = want.split("-")[0];
  const hit = TTS_LANGUAGES.find((l) => l.code.toLowerCase().startsWith(`${base}-`));
  return hit ? hit.code : DEFAULT_TTS_LANGUAGE;
}

/** Chữ của một cue -> chữ gửi cho TTS: cue đã xuống dòng sẵn để hiện phụ đề */
export function cueSpeechText(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
}

export interface SynthDubCueInput {
  text: string;
  voice: string;
  engine: TtsEngine;
  model?: string | null;
  language?: string;
  /** Nơi để file trung gian (mỗi câu một thư mục riêng - synthScript ghi part-XXX ở đây) */
  workDir: string;
  outWavAbs: string;
  onLog?: (line: string) => void;
  isCanceled?: () => boolean;
}

/**
 * Đọc MỘT câu ra WAV 48kHz mono, chưa co giãn.
 *
 * Đi qua `synthScript` với đúng một đoạn chứ không gọi API trực tiếp: hàm đó đã
 * mang sẵn cắt lặng hai đầu, thử lại khi Gemini trả 200-không-có-tiếng, và
 * chuyển đổi định dạng. Cắt lặng hai đầu đặc biệt quan trọng ở đây: nếu để lại
 * ~0,25s lặng mỗi đầu thì mọi phép đo thời lượng đều dư nửa giây và ta sẽ co
 * giãn để chữa một khoảng lặng chứ không phải chữa lời nói.
 *
 * Một đoạn thì `synthScript` bỏ qua luôn khâu dò lệch giọng (cần >= 2 đoạn mới
 * so được) - đúng ý: chống lệch giọng ở đây là việc của bước gán giọng cố định.
 */
export async function synthDubCue(input: SynthDubCueInput): Promise<{ wavAbs: string; naturalSec: number }> {
  const text = cueSpeechText(input.text);
  if (!text) throw new HttpError(400, "DUB_EMPTY_CUE", "Câu rỗng - không có gì để đọc");
  /**
   * Gần như mọi cue phụ đề đều ngắn (2 dòng chữ) nên đi đúng một đoạn. Nhưng
   * người dùng SỬA TAY được bản dịch, và một cue bị dán quá dài mà gửi thẳng thì
   * Gemini đọc THIẾU trong im lặng (vẫn 200, vẫn finishReason STOP - đo được chỉ
   * đọc 38% ở mức 5000 ký tự). Quá trần thì chia đoạn đúng luật chung của hệ,
   * chấp nhận thêm nhịp nghỉ giữa đoạn - thà nghỉ một nhịp còn hơn mất chữ.
   */
  const chunks = text.length > TTS_CHUNK_MAX_CHARS ? chunkForTts(text) : [text];
  const res = await synthScript({
    chunks,
    voice: input.voice,
    engine: input.engine,
    model: input.model,
    language: input.language,
    workDir: input.workDir,
    outWavAbs: input.outWavAbs,
    onLog: input.onLog,
    isCanceled: input.isCanceled,
  });
  return { wavAbs: res.wavAbs, naturalSec: res.durationSec };
}

/**
 * Áp hệ số co lên file WAV của một câu, TẠI CHỖ.
 *
 * Dùng `applySpeedToWav` của tts.ts chứ không tự viết lệnh atempo: bản nghe thử
 * và bản dựng thật phải đi qua đúng một đường xử lý, nếu không thì nghe thử nói
 * dối. Trả về thời lượng ĐO LẠI, không phải natural/tempo - atempo làm tròn
 * theo mẫu nên số thật lệch số tính vài mili giây.
 */
export async function applyTempoToCue(wavAbs: string, tempo: number): Promise<number> {
  if (Math.abs(tempo - 1) < 0.001) return probeSeconds(wavAbs);
  const src = fs.readFileSync(wavAbs);
  const out = await applySpeedToWav(src, tempo);
  fs.writeFileSync(wavAbs, out);
  return probeSeconds(wavAbs);
}

// ---------------------------------------------------------------------------
// Lắp ráp: đặt từng câu ở MỐC TUYỆT ĐỐI trên một track lặng
// ---------------------------------------------------------------------------

interface Placement {
  /** Đường dẫn TƯƠNG ĐỐI so với cwd của ffmpeg - xem ghi chú ở mixPlacements */
  file: string;
  /** Mốc bắt đầu (giây) trong video nguồn */
  atSec: number;
  /** Âm lượng 0..1 */
  volume: number;
}

/**
 * Trộn một lô câu vào một track lặng dài `durationSec`.
 *
 * VÌ SAO adelay + amix chứ không phải concat: concat nối đuôi, mỗi mối nối sai
 * vài mili thì tới cuối bài lệch cả giây (sai số CỘNG DỒN). adelay đặt từng câu
 * ở mốc TUYỆT ĐỘI tính từ đầu track - sai số của câu này không truyền sang câu
 * kia, tối đa nửa mili do adelay chỉ nhận đơn vị mili giây.
 *
 * `normalize=0` là BẮT BUỘC: mặc định amix chia biên độ cho số đầu vào, tức là
 * trộn 80 câu thì mỗi câu nhỏ đi 80 lần - ra một file gần như im lặng.
 *
 * Danh sách file dùng TÊN TƯƠNG ĐỐI + chạy ffmpeg với cwd = thư mục chứa: đường
 * dẫn Windows có dấu \ và dấu : mà cú pháp filter của ffmpeg hiểu thành ký tự
 * đặc biệt (đúng cái bẫy mà phần ghép giọng đọc ở tts.ts đã tránh bằng cách này).
 */
async function mixPlacements(input: {
  places: Placement[];
  durationSec: number;
  cwd: string;
  outWavAbs: string;
  isCanceled?: () => boolean;
}): Promise<void> {
  const { places, durationSec, cwd } = input;
  const dur = Math.max(0.1, durationSec);
  const args: string[] = ["-f", "lavfi", "-i", `anullsrc=r=${OUT_SAMPLE_RATE}:cl=mono`];
  const lines: string[] = [`[0:a]atrim=end=${dur.toFixed(3)}[base]`];
  const labels: string[] = ["[base]"];

  places.forEach((p, i) => {
    args.push("-i", p.file);
    const delayMs = Math.max(0, Math.round(p.atSec * 1000));
    const label = `c${i}`;
    // aresample + aformat: ép mọi đầu vào về cùng một định dạng trước khi cộng.
    // amix tự chèn được, nhưng ghi rõ ra thì lỗi định dạng lộ ngay ở lệnh này
    // chứ không thành một file trộn nghe sai mà không ai biết vì sao.
    const vol = p.volume >= 0.999 ? "" : `,volume=${p.volume.toFixed(3)}`;
    lines.push(
      `[${i + 1}:a]aresample=${OUT_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono${vol},adelay=${delayMs}[${label}]`,
    );
    labels.push(`[${label}]`);
  });

  lines.push(
    `${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[mix]`,
  );

  // Kịch bản filter ghi ra FILE: một video 10 phút có hơn 200 câu, nhét cả đồ
  // thị filter vào dòng lệnh là vượt trần ~32k ký tự của Windows.
  const scriptName = `mix-${path.basename(input.outWavAbs, ".wav")}.filter`;
  fs.writeFileSync(path.join(cwd, scriptName), lines.join(";\n") + "\n", "utf8");

  await runFfmpeg(
    [
      ...args,
      "-filter_complex_script",
      scriptName,
      "-map",
      "[mix]",
      "-t",
      dur.toFixed(3),
      "-ar",
      String(OUT_SAMPLE_RATE),
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      input.outWavAbs,
    ],
    { cwd, timeoutMs: 600_000, isCanceled: input.isCanceled },
  );
  fs.rmSync(path.join(cwd, scriptName), { force: true });
}

/**
 * Trộn tất cả câu vào một track, chia lô khi quá nhiều (xem MIX_BATCH).
 * Mỗi lô cho ra một track ĐỦ ĐỘ DÀI video, nên trộn các lô lại với nhau là phép
 * cộng đúng từng mẫu - mốc tuyệt đối của từng câu không đổi.
 */
export async function mixDubTrack(input: {
  cues: Array<{ wavAbs: string; atSec: number }>;
  durationSec: number;
  workDir: string;
  outWavAbs: string;
  onLog?: (line: string) => void;
  isCanceled?: () => boolean;
}): Promise<void> {
  ensureDir(input.workDir);
  ensureDir(path.dirname(input.outWavAbs));
  const places: Placement[] = input.cues.map((c) => ({
    file: path.relative(input.workDir, c.wavAbs).split(path.sep).join("/"),
    atSec: c.atSec,
    volume: 1,
  }));

  if (places.length <= MIX_BATCH) {
    await mixPlacements({
      places,
      durationSec: input.durationSec,
      cwd: input.workDir,
      outWavAbs: input.outWavAbs,
      isCanceled: input.isCanceled,
    });
    return;
  }

  const parts: string[] = [];
  for (let i = 0; i < places.length; i += MIX_BATCH) {
    const partAbs = path.join(input.workDir, `mix-part-${parts.length}.wav`);
    input.onLog?.(
      `[dub] trộn lô ${parts.length + 1} (${Math.min(MIX_BATCH, places.length - i)} câu)`,
    );
    await mixPlacements({
      places: places.slice(i, i + MIX_BATCH),
      durationSec: input.durationSec,
      cwd: input.workDir,
      outWavAbs: partAbs,
      isCanceled: input.isCanceled,
    });
    parts.push(partAbs);
  }
  await mixPlacements({
    places: parts.map((p) => ({ file: path.basename(p), atSec: 0, volume: 1 })),
    durationSec: input.durationSec,
    cwd: input.workDir,
    outWavAbs: input.outWavAbs,
    isCanceled: input.isCanceled,
  });
  for (const p of parts) fs.rmSync(p, { force: true });
}

/**
 * Trộn tiếng GỐC chạy nhỏ bên dưới giọng lồng.
 *
 * Dùng khi người dùng muốn còn nghe được không khí gốc (tiếng cười, nhạc trong
 * video, ngữ điệu người thật). Số học chống rè ở DUB_VOLUME_WITH_BED - trần
 * tiếng gốc kẹp CỨNG tại đây chứ không tin số gọi vào.
 */
export async function mixOriginalUnder(input: {
  dubWavAbs: string;
  videoAbs: string;
  originalVolume: number;
  durationSec: number;
  workDir: string;
  outWavAbs: string;
  isCanceled?: () => boolean;
}): Promise<void> {
  ensureDir(input.workDir);
  const vol = Math.min(DUB_ORIGINAL_VOLUME_MAX, Math.max(0, input.originalVolume));
  const dur = Math.max(0.1, input.durationSec);
  await runFfmpeg(
    [
      "-i",
      input.dubWavAbs,
      "-i",
      input.videoAbs,
      "-filter_complex",
      `[0:a]volume=${DUB_VOLUME_WITH_BED.toFixed(3)},aresample=${OUT_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono[d];` +
        `[1:a]volume=${vol.toFixed(3)},aresample=${OUT_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono[o];` +
        `[d][o]amix=inputs=2:normalize=0:dropout_transition=0[mix]`,
      "-map",
      "[mix]",
      "-t",
      dur.toFixed(3),
      "-ar",
      String(OUT_SAMPLE_RATE),
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      input.outWavAbs,
    ],
    { timeoutMs: 600_000, isCanceled: input.isCanceled },
  );
}

// ---------------------------------------------------------------------------
// Hàm chính
// ---------------------------------------------------------------------------

export interface SynthesizeDubInput {
  cues: TranslatedCue[];
  assignments: DubVoiceAssignment[];
  engine: TtsEngine;
  model?: string | null;
  /** Mã ngôn ngữ TTS, vd "vi-VN" - xem ttsLanguageFor() */
  language?: string;
  /** Thời lượng video nguồn (giây) - track lồng tiếng dài ĐÚNG bằng đây */
  durationSec: number;
  /** Thư mục phiên: cue-XXX.wav + track ghép nằm ở đây */
  dubDir: string;
  outWavAbs: string;
  onProgress?: (done: number, total: number) => void;
  onLog?: (line: string) => void;
  isCanceled?: () => boolean;
}

/**
 * Lồng tiếng cả phiên: đọc từng câu -> co cho vừa chỗ -> đặt vào mốc tuyệt đối.
 *
 * VÌ SAO ĐỌC TỪNG CÂU MỘT (tốn nhiều lượt gọi API hơn hẳn đọc cả bài): phải có
 * được thời lượng của TỪNG câu để co riêng từng câu. Đọc cả bài rồi cắt ra thì
 * không biết chỗ nào là ranh giới câu, mà co cả bài bằng một hệ số thì câu nào
 * dịch dài sẽ vẫn tràn còn câu nào dịch ngắn lại bị ép nhanh vô cớ.
 */
export async function synthesizeDub(input: SynthesizeDubInput): Promise<DubResult> {
  const cues = input.cues;
  if (cues.length === 0) {
    throw new HttpError(400, "DUB_NO_CUES", "Chưa có câu nào để lồng tiếng");
  }
  if (input.assignments.length === 0) {
    throw new HttpError(400, "DUB_NO_VOICE", "Chưa gán giọng đọc cho người nói nào");
  }
  const dubDir = input.dubDir;
  const workDir = path.join(dubDir, "work");
  ensureDir(dubDir);
  ensureDir(workDir);

  const videoDur = input.durationSec > 0 ? input.durationSec : lastEnd(cues);
  const results: DubCueResult[] = [];
  let stretched = 0;
  let overflowed = 0;
  let clipped = 0;
  let minTempo = Number.POSITIVE_INFINITY;
  let maxTempo = 0;

  for (let i = 0; i < cues.length; i++) {
    if (input.isCanceled?.()) throw new Error("Job đã bị hủy");
    const cue = cues[i];
    const assign = voiceForCue(input.assignments, cue.speaker);
    const idx = String(i + 1).padStart(3, "0");
    const wavAbs = path.join(dubDir, `cue-${idx}.wav`);

    await synthDubCue({
      text: cue.text,
      voice: assign.voice,
      engine: assign.engine,
      model: input.model,
      language: input.language,
      workDir: path.join(workDir, `cue-${idx}`),
      outWavAbs: wavAbs,
      onLog: input.onLog,
      isCanceled: input.isCanceled,
    });
    const naturalSec = await probeSeconds(wavAbs);

    const span = cue.end - cue.start;
    const gap = gapAfter(cues, i, videoDur);
    const fit = fitCue(naturalSec, span, gap);
    const finalSec = await applyTempoToCue(wavAbs, fit.tempo);

    if (fit.tempo !== 1) {
      stretched++;
      minTempo = Math.min(minTempo, fit.tempo);
      maxTempo = Math.max(maxTempo, fit.tempo);
    }
    if (fit.clipped) clipped++;
    if (fit.overflowed) overflowed++;

    if (fit.overflowed) {
      input.onLog?.(
        `[dub] câu ${i + 1} (${cue.start.toFixed(2)}s) TRÀN: đọc ${naturalSec.toFixed(2)}s, ` +
          `chỗ trống ${(span + gap).toFixed(2)}s, đã co x${fit.tempo} còn ${finalSec.toFixed(2)}s ` +
          `-> lấn ${(finalSec - span - gap).toFixed(2)}s sang câu sau`,
      );
    } else if (fit.clipped) {
      input.onLog?.(
        `[dub] câu ${i + 1} (${cue.start.toFixed(2)}s) kẹp ở trần co x${DUB_TEMPO_MAX} - ` +
          `tràn ${(finalSec - span).toFixed(2)}s vào khoảng nghỉ phía sau`,
      );
    }

    const r: DubCueResult = {
      start: cue.start,
      end: cue.end,
      wavAbs,
      naturalSec: round3(naturalSec),
      finalSec: round3(finalSec),
      tempo: fit.tempo,
      clipped: fit.clipped,
      overflowed: fit.overflowed,
    };
    if (cue.speaker) r.speaker = cue.speaker;
    results.push(r);
    input.onProgress?.(i + 1, cues.length);
  }

  input.onLog?.(`[dub] trộn ${results.length} câu vào track lặng dài ${videoDur.toFixed(2)}s`);
  await mixDubTrack({
    cues: results.map((r) => ({ wavAbs: r.wavAbs, atSec: r.start })),
    durationSec: videoDur,
    workDir: dubDir,
    outWavAbs: input.outWavAbs,
    onLog: input.onLog,
    isCanceled: input.isCanceled,
  });
  const durationSec = await probeSeconds(input.outWavAbs);
  fs.rmSync(workDir, { recursive: true, force: true });

  const min = Number.isFinite(minTempo) ? minTempo : 1;
  const max = maxTempo > 0 ? maxTempo : 1;
  input.onLog?.(
    `[dub] xong: ${results.length} câu, ${stretched} câu phải co (x${min.toFixed(3)}-x${max.toFixed(3)}), ` +
      `${clipped} câu kẹp trần, ${overflowed} câu tràn sang câu sau, track dài ${durationSec.toFixed(2)}s`,
  );

  return {
    wavAbs: input.outWavAbs,
    durationSec: round3(durationSec),
    cues: results,
    assignments: input.assignments,
    stretched,
    overflowed,
    clipped,
    minTempo: round3(min),
    maxTempo: round3(max),
  };
}

function lastEnd(cues: TranslatedCue[]): number {
  let max = 0;
  for (const c of cues) max = Math.max(max, c.end);
  return max;
}
