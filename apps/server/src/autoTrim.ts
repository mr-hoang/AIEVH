import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { HttpError, audioCutFade, ensureDir, execFileCaptureAll } from "./util.js";

/**
 * Cắt khoảng lặng KHÔNG cần AI - đo bằng máy, quyết định bằng số.
 *
 * Trước đây việc này do agent tự gõ ffmpeg từng lần: mỗi video một ngưỡng dB
 * khác nhau, chọn theo cảm tính, không lặp lại được. Module này thay phần cơ
 * học đó bằng code: đo -> chọn ngưỡng -> cắt một lượt -> dời timestamp ->
 * nghiệm thu. Phần còn lại (đọc transcript tìm filler, câu nói hỏng, ý lặp)
 * vẫn là việc của AI - xem `deadWeight.ts`.
 *
 * NHỮNG SỐ ĐO THẬT làm nền cho module này (video-projects/demo1/assets/
 * face.cut.mp4, 158,8s, đã qua một lần cắt của quy trình cũ):
 *
 * - volumedetect: mean_volume -26,1 dB, max_volume -4,6 dB.
 * - silencedetect ở -40dB: 0 khoảng lặng. Ở -30dB: 13. Ở -25dB: 21.
 *   => NGƯỠNG CỐ ĐỊNH LÀ SAI. Đặt thấp quá thì không cắt được gì, đặt cao quá
 *   thì ăn vào tiếng nói. Ngưỡng phải dò theo từng file (xem pickThreshold).
 * - 13 khoảng lặng còn lại đều 0,45s-0,67s, tổng 6,7s = 4,2% thời lượng. Luật
 *   cũ "chỉ trượt khi còn khoảng lặng > 0,8s" cho file này ĐẬU, trong khi tai
 *   người nghe ra là đầy chỗ chết. Vì thế verifyTrim xét THÊM tỉ lệ tổng, và
 *   hạ trần khoảng lặng đơn lẻ xuống 0,50s (profile default).
 * - Luật cũ "chừa 0,18s mỗi mép" tạo ra một sàn cứng: một khoảng lặng bị cắt
 *   không bao giờ ngắn hơn 2 x 0,18 = 0,36s. Nên padSec và maxResidualSec
 *   phải đi cùng nhau, không đặt rời (xem effectiveMinSilence).
 *
 * ĐO TIẾP TRÊN BẢN GỐC (thanhtoan80.mov, 217,0s, 835 chữ có mốc thời gian) -
 * và đây là lý do phải có `words`:
 *
 * - Khoảng trống THẬT giữa các chữ (lấy từ transcript): 41 khoảng, tổng 28,2s.
 * - silencedetect ở -30dB (d=0,2) báo 48,6s. Chỉ 18,2s trong số đó nằm trong
 *   khoảng trống thật; 30,4s còn lại nằm NGAY BÊN TRONG chữ - khoảng nghỉ giữa
 *   hai âm tiết, phụ âm cuối không rung của tiếng Việt (c, t, p, ch). Mức âm
 *   thanh MỘT MÌNH không phân biệt được "đang nghỉ" với "đang nói nhỏ".
 * - Vì thế KHÔNG có ngưỡng nào cho tỉ lệ phủ quyết dưới 5%: đo được thấp nhất
 *   là 34,9% (-40dB) và lên tới 82,6% (-16dB); trên bản đã cắt là ~90% ở MỌI
 *   ngưỡng. Tỉ lệ phủ quyết là tính chất của người nói + bộ dò, không phải cái
 *   núm vặn được - dùng nó làm điều kiện chọn ngưỡng là bế tắc.
 * - Chỉ số CÓ điểm gãy rõ là "tỉ lệ chữ bị nuốt": bao nhiêu phần trăm chữ có
 *   TRUNG ĐIỂM rơi vào vùng bộ dò gọi là lặng. Đo trên cả hai file:
 *     -35dB 6,2%/4,1% | -30dB 9,9%/8,2% | -26dB 11,7%/10,3% | -22dB 14,7%/13,8%
 *     -20dB 20,2%/18,5% | -18dB 34,6%/31,6% | -16dB 62,4%/59,3%
 *   Phẳng suốt 13 dB rồi vọt lên từ -20dB. Đó là căn cứ của
 *   WORD_MIDPOINT_MAX_RATE.
 */

export type TrimAggressiveness = "natural" | "default" | "tight";

export interface SilenceRange {
  start: number;
  end: number;
  duration: number;
}

/**
 * Một chữ đã có mốc thời gian. Cố tình CHỈ có start/end: module này không được
 * biết transcript có hình dạng gì (segments, words, srcIndex...) - bên gọi tự
 * dàn phẳng rồi truyền vào. Nhờ vậy đổi bộ bóc băng không phải sửa ở đây.
 */
export interface WordSpan {
  start: number;
  end: number;
}

export interface TrimProfile {
  /** Khoảng lặng ngắn hơn mức này thì để yên (nhịp thở tự nhiên) */
  minSilenceSec: number;
  /** Chừa lại mỗi mép bao nhiêu giây khi cắt */
  padSec: number;
  /** Sau khi cắt, không khoảng lặng nào được dài hơn mức này */
  maxResidualSec: number;
  /** Tổng thời gian lặng còn lại tối đa, tính theo tỉ lệ thời lượng */
  maxResidualRatio: number;
}

export interface TrimAnalysis {
  durationSec: number;
  noiseFloorDb: number; // đo được, không phải hằng số
  thresholdDb: number; // ngưỡng đã chọn
  profile: TrimProfile;
  silences: SilenceRange[]; // các khoảng sẽ bị cắt (đã lọc theo minSilenceSec)
  keepRanges: Array<[number, number]>;
  removedSec: number;
  /**
   * NGOÀI SPEC (thêm, không thay): vì sao ngưỡng này được chọn. Bắt buộc phải
   * có chỗ ghi lại ca "không ngưỡng nào rơi vào dải hợp lý" - nếu nuốt đi thì
   * người đọc log không phân biệt được ngưỡng chọn đúng với ngưỡng chọn bừa.
   */
  thresholdNote?: string;
  /** NGOÀI SPEC: toàn bộ bảng dò ngưỡng, để log/báo cáo soi lại được */
  sweep?: Array<{ db: number; count: number; ratio: number; midpointRate: number }>;
  /**
   * Transcript đã phủ quyết bao nhiêu. Chỉ có khi truyền `words`.
   *
   * Phải phơi ra chứ không được im lặng: trên bản gốc đo được, transcript gạt
   * đi 47s trong số 70,3s mà tai máy gọi là "lặng" - con số lớn tới mức nếu
   * giấu đi thì không ai biết vì sao removedSec thấp hơn hẳn kỳ vọng.
   */
  wordGuard?: { droppedSec: number; droppedRanges: number };
}

export interface TrimVerification {
  residual: SilenceRange[];
  totalSilenceSec: number;
  ratio: number;
  longest: number;
  pass: boolean;
  reason?: string; // vì sao trượt, tiếng Việt
}

/**
 * Ba mức mạnh tay. Con số lấy từ đo đạc ở đầu file, không phải đặt cho đẹp:
 *
 * - natural: chỉ đụng vào chỗ chết rõ ràng (>= 0,90s), chừa 0,18s mỗi mép cho
 *   nhịp thở. Dùng cho phỏng vấn, video kể chuyện - cắt sâu là mất chất người.
 * - default: 0,45s là mốc quy trình cũ đã dùng và nghe ổn; pad hạ xuống 0,12s
 *   (sàn cứng 0,24s thay vì 0,36s) để trần 0,50s còn chỗ thở.
 * - tight: TikTok/Shorts, cắt tới 0,30s, pad 0,08s (sàn cứng 0,16s).
 *
 * QUAN HỆ BẮT BUỘC GIỮA CÁC SỐ: 2 x padSec < maxResidualSec, nếu không thì
 * chính chỗ mình vừa cắt cũng trượt nghiệm thu (natural 0,36 < 0,80;
 * default 0,24 < 0,50; tight 0,16 < 0,35). Chỗ minSilenceSec lớn hơn
 * maxResidualSec được hòa giải ở effectiveMinSilence().
 */
export const TRIM_PROFILES: Record<TrimAggressiveness, TrimProfile> = {
  natural: { minSilenceSec: 0.9, padSec: 0.18, maxResidualSec: 0.8, maxResidualRatio: 0.06 },
  default: { minSilenceSec: 0.45, padSec: 0.12, maxResidualSec: 0.5, maxResidualRatio: 0.03 },
  tight: { minSilenceSec: 0.3, padSec: 0.08, maxResidualSec: 0.35, maxResidualRatio: 0.02 },
};

const DEFAULT_AGGRESSIVENESS: TrimAggressiveness = "default";

/**
 * Các ngưỡng đem ra dò. Dưới -45dB là nền nhiễu của mọi micro tử tế (file đo
 * được có mean -26,1dB), trên -20dB thì tỉ lệ chữ bị nuốt vọt lên (34,6% ở
 * -18dB, 62,4% ở -16dB) nên dò tiếp cũng không dùng được.
 *
 * Có -26 và -22 vì khi CÓ transcript thì vùng -30..-20 mới là vùng quyết định,
 * và bước nhảy 5dB ở đó bỏ phí thời gian cắt được thật: -22dB thu hồi 23,3s
 * khoảng trống so với 21,4s ở -26dB trên bản gốc.
 */
const CANDIDATE_DB = [-45, -40, -35, -30, -26, -22, -20] as const;

/**
 * Trần "tỉ lệ chữ bị nuốt" khi chọn ngưỡng lúc CÓ transcript.
 *
 * 15% = ranh giới giữa vùng phẳng và vùng vọt của bảng đo ở đầu file: từ -35dB
 * tới -22dB tỉ lệ này chỉ bò từ 6,2% lên 14,7% (bản gốc) và 4,1% lên 13,8%
 * (bản đã cắt), nhưng -20dB đã là 20,2%/18,5% và -16dB là 62,4%/59,3% - tới
 * mức đó thì bộ dò đang gọi phần lớn LỜI NÓI là im lặng, và mọi mốc biên nó
 * đưa ra đều hết tin được. Chốt 15% thì cả hai file đều chọn -22dB.
 *
 * Vì sao KHÔNG dùng "tỉ lệ phủ quyết < 5%" như dự kiến ban đầu: đo ra không
 * ngưỡng nào đạt (thấp nhất 34,9%, bản đã cắt ~90% ở mọi ngưỡng) - xem ghi chú
 * dài ở đầu file.
 */
const WORD_MIDPOINT_MAX_RATE = 0.15;

/**
 * Dải tỉ lệ lặng "hợp lý" của một video người nói.
 *
 * Dưới 2%: ngưỡng quá thấp, coi như không phát hiện được gì (file đo được ở
 * -40dB ra đúng 0%). Trên 35%: ngưỡng đã cao tới mức nuốt cả tiếng nói - một
 * người nói liên tục không thể im lặng quá một phần ba thời lượng.
 */
const SANE_RATIO_LO = 0.02;
const SANE_RATIO_HI = 0.35;

/**
 * Thời lượng tối thiểu dùng KHI DÒ ngưỡng (không phải khi cắt).
 *
 * Cố tình nhỏ hơn minSilenceSec của mọi profile (thấp nhất là 0,30s) để một
 * lần dò dùng chung cho cả ba mức: dò xong mới lọc theo profile. Nếu dò bằng
 * chính minSilenceSec thì mỗi profile phải dò lại từ đầu, tốn 3 lần ffmpeg mà
 * kết quả ngưỡng lẽ ra phải giống nhau (ngưỡng là tính chất của FILE, không
 * phải của profile).
 */
const SWEEP_MIN_DUR = 0.2;

/**
 * Chừa lại bao nhiêu giây ở khoảng lặng ĐẦU và CUỐI video.
 *
 * Không theo profile: video mở đầu bằng 1-2s im lặng là giết hook, đã gặp thật.
 * Đuôi im lặng cũng vậy - người xem tưởng video treo. 0,2s vừa đủ để không cụt
 * chữ đầu tiên.
 */
const EDGE_KEEP_SEC = 0.2;

/** Mảnh keep/cut ngắn hơn mức này thì bỏ - ffmpeg trim không xử lý nổi, mà tai cũng không nghe ra */
export const MIN_PIECE_SEC = 0.03;

/** Sai số khi so mốc với đầu/cuối file (silencedetect làm tròn theo frame audio) */
const EDGE_EPS = 0.05;

// ---------------------------------------------------------------------------
// Chạy ffmpeg (theo đúng lối tts.ts: execFileCaptureAll, đọc kết quả từ stderr)
// ---------------------------------------------------------------------------

/**
 * ffmpeg ghi mọi kết quả đo ra STDERR, và nhiều lệnh đo xong vẫn thoát mã khác
 * 0 - nên phải dùng execFileCaptureAll chứ không phải execFileCapture.
 */
async function runFfmpeg(
  args: string[],
  opts: { timeoutMs?: number; isCanceled?: () => boolean; allowNonZero?: boolean },
): Promise<string> {
  let r: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    r = await execFileCaptureAll("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], {
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
  if (r.timedOut) throw new Error("ffmpeg chạy quá lâu khi cắt khoảng lặng - đã hủy");
  if (r.code !== 0 && !opts.allowNonZero) {
    const tail = r.stderr.split(/\r?\n/).slice(-12).join("\n");
    throw new Error(`ffmpeg thất bại (mã ${r.code}):\n${tail}`);
  }
  return r.stderr;
}

async function runFfprobe(args: string[], isCanceled?: () => boolean): Promise<string> {
  let r: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    r = await execFileCaptureAll("ffprobe", ["-v", "error", ...args], {
      timeoutMs: 30_000,
      isCanceled,
    });
  } catch (err) {
    throw new HttpError(
      503,
      "NO_FFPROBE",
      `Không chạy được ffprobe - cài FFmpeg và thêm vào PATH. Chi tiết: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (r.canceled) throw new Error("Job đã bị hủy");
  if (r.timedOut) throw new Error("ffprobe chạy quá lâu - đã hủy");
  return r.stdout;
}

/** Thời lượng ĐO ĐƯỢC bằng ffprobe - không bao giờ suy ra từ thứ khác */
async function probeSeconds(fileAbs: string, isCanceled?: () => boolean): Promise<number> {
  const out = await runFfprobe(
    ["-show_entries", "format=duration", "-of", "csv=p=0", fileAbs],
    isCanceled,
  );
  const sec = parseFloat(out.trim());
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new HttpError(
      503,
      "TRIM_NO_DURATION",
      `Không đo được thời lượng của ${path.basename(fileAbs)} bằng ffprobe.`,
    );
  }
  return sec;
}

/** File có stream video / audio không - quyết định filter_complex dựng thế nào */
async function probeStreams(
  fileAbs: string,
  isCanceled?: () => boolean,
): Promise<{ hasVideo: boolean; hasAudio: boolean }> {
  const out = await runFfprobe(
    ["-show_entries", "stream=codec_type", "-of", "csv=p=0", fileAbs],
    isCanceled,
  );
  const kinds = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { hasVideo: kinds.includes("video"), hasAudio: kinds.includes("audio") };
}

// ---------------------------------------------------------------------------
// Đo khoảng lặng
// ---------------------------------------------------------------------------

/**
 * Bóc audio ra WAV 16kHz mono MỘT LẦN rồi mới đo nhiều lượt trên đó.
 *
 * Vì sao không đo thẳng trên MP4: mỗi lượt silencedetect phải giải mã lại cả
 * stream video (file thật 115 MB), nhân với 6 ngưỡng dò là 6 lần giải mã thừa.
 * WAV 16kHz mono của 158,8s chỉ ~5 MB và đọc gần như tức thì. 16kHz đủ xa cho
 * việc đo mức - không dùng để nghe.
 */
async function extractProbeWav(
  fileAbs: string,
  outWavAbs: string,
  isCanceled?: () => boolean,
): Promise<void> {
  await runFfmpeg(
    ["-i", fileAbs, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outWavAbs],
    { timeoutMs: 600_000, isCanceled },
  );
}

/** Đọc cặp silence_start / silence_end trong stderr của silencedetect */
function parseSilences(stderr: string, durationSec: number): SilenceRange[] {
  const out: SilenceRange[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) {
      open = Math.max(0, parseFloat(s[1]));
      continue;
    }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && open !== null) {
      const end = Math.min(durationSec, parseFloat(e[1]));
      if (end > open) out.push({ start: open, end, duration: end - open });
      open = null;
    }
  }
  // silencedetect luôn đóng khoảng lặng khi hết file, nhưng nếu ffmpeg bị cắt
  // ngang thì vẫn còn một khoảng mở - đóng nó ở cuối file cho khỏi mất đuôi.
  if (open !== null && durationSec > open) {
    out.push({ start: open, end: durationSec, duration: durationSec - open });
  }
  return out;
}

async function detectSilences(
  wavAbs: string,
  db: number,
  minDur: number,
  durationSec: number,
  isCanceled?: () => boolean,
): Promise<SilenceRange[]> {
  const stderr = await runFfmpeg(
    ["-i", wavAbs, "-af", `silencedetect=n=${db}dB:d=${minDur}`, "-f", "null", "-"],
    { timeoutMs: 300_000, isCanceled, allowNonZero: true },
  );
  return parseSilences(stderr, durationSec);
}

// ---------------------------------------------------------------------------
// Hàng rào transcript: chỉ khoảng TRỐNG GIỮA CHỮ mới được coi là chỗ cắt
// ---------------------------------------------------------------------------

/** Khoảng trống giữa các chữ = phần bù của các chữ trong [0, duration] */
function wordGapRanges(words: WordSpan[], durationSec: number): SilenceRange[] {
  const spans = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .map((w) => ({
      start: Math.max(0, w.start),
      end: Math.min(durationSec, w.end),
      duration: 0,
    }))
    .filter((w) => w.end > w.start);
  const merged = mergeRanges(spans as SilenceRange[]);
  const gaps: SilenceRange[] = [];
  let cursor = 0;
  for (const w of merged) {
    if (w.start - cursor > 1e-6) {
      gaps.push({ start: cursor, end: w.start, duration: w.start - cursor });
    }
    cursor = Math.max(cursor, w.end);
  }
  if (durationSec - cursor > 1e-6) {
    gaps.push({ start: cursor, end: durationSec, duration: durationSec - cursor });
  }
  return gaps;
}

/** Giao hai danh sách khoảng ĐÃ SẮP XẾP và không chồng nhau */
function intersectRanges(a: SilenceRange[], b: SilenceRange[]): SilenceRange[] {
  const out: SilenceRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i].start, b[j].start);
    const hi = Math.min(a[i].end, b[j].end);
    if (hi - lo > 1e-6) out.push({ start: lo, end: hi, duration: hi - lo });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

const totalSec = (ranges: SilenceRange[]): number => ranges.reduce((s, r) => s + r.duration, 0);

/**
 * Tỉ lệ chữ có TRUNG ĐIỂM rơi vào vùng bộ dò gọi là lặng.
 *
 * Lấy trung điểm chứ không lấy hai mép: mép chữ do bộ bóc băng đoán, sai vài
 * chục ms là bình thường; còn trung điểm mà đã nằm trong "khoảng lặng" thì
 * chắc chắn bộ dò đang gọi cả tiếng nói là im lặng.
 */
function midpointHitRate(words: WordSpan[], silences: SilenceRange[]): number {
  if (words.length === 0 || silences.length === 0) return 0;
  const sorted = [...silences].sort((x, y) => x.start - y.start);
  let hit = 0;
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    // Tìm tuyến tính là đủ: n chữ ~ 1000, n khoảng ~ 200, chạy trong vài ms
    if (sorted.some((s) => mid >= s.start && mid <= s.end)) hit++;
  }
  return hit / words.length;
}

interface SweepEntry {
  db: number;
  count: number;
  ratio: number;
  /** Khoảng lặng THÔ do ffmpeg báo */
  ranges: SilenceRange[];
  /** Phần khoảng lặng thô nằm trong khoảng trống giữa chữ (= chỗ được phép cắt) */
  guarded: SilenceRange[];
  midpointRate: number;
}

/**
 * Chọn ngưỡng dB theo chính file này. Hai luật, tùy có transcript hay không.
 *
 * KHÔNG CÓ transcript (luật cũ, giữ nguyên): đi từ ngưỡng YÊN NHẤT (-45dB)
 * lên, lấy ngưỡng ĐẦU TIÊN cho tỉ lệ lặng rơi vào dải hợp lý. An toàn nằm ở
 * chỗ chọn ngưỡng thấp - thà bỏ sót chỗ chết còn hơn cụt một chữ.
 *
 * CÓ transcript: an toàn đã do hàng rào chữ đảm nhiệm (không đời nào cắt vào
 * khoảng thời gian có chữ), nên chọn ngưỡng thấp chỉ còn tác dụng BỎ SÓT. Vì
 * thế đảo chiều: lấy ngưỡng MẠNH TAY NHẤT mà tỉ lệ chữ bị nuốt còn dưới trần.
 * Đo được: đổi từ luật cũ (-35dB) sang luật này (-22dB) thu hồi 23,3s khoảng
 * trống thay vì 14,2s, mà vẫn không đụng vào chữ nào.
 *
 * Transcript hỏng (mốc thời gian loạn, không ngưỡng nào dưới trần) thì lùi về
 * luật không-transcript và ghi rõ trong note - im lặng đổi luật là kiểu lỗi
 * không ai lần ra được.
 */
function pickThreshold(
  sweep: SweepEntry[],
  hasWords: boolean,
): { db: number; ranges: SilenceRange[]; note: string } {
  if (hasWords) {
    // Duyệt từ mạnh tay nhất về yên nhất
    for (const s of [...sweep].reverse()) {
      if (s.midpointRate > WORD_MIDPOINT_MAX_RATE) continue;
      return {
        db: s.db,
        ranges: s.guarded,
        note:
          `có transcript: lấy ngưỡng mạnh tay nhất còn an toàn ${s.db}dB ` +
          `(${(s.midpointRate * 100).toFixed(1)}% chữ bị nuốt, trần ${(WORD_MIDPOINT_MAX_RATE * 100).toFixed(0)}%); ` +
          `${totalSec(s.ranges).toFixed(1)}s tai máy gọi là lặng, transcript cho phép cắt ${totalSec(s.guarded).toFixed(1)}s`,
      };
    }
  }

  const inBand = sweep.find((s) => s.ratio >= SANE_RATIO_LO && s.ratio <= SANE_RATIO_HI);
  const prefix = hasWords
    ? "CÓ transcript nhưng không ngưỡng nào giữ được tỉ lệ chữ bị nuốt dưới trần (mốc thời gian của transcript nhiều khả năng sai) - lùi về luật đo bằng tai máy: "
    : "";
  if (inBand) {
    return {
      db: inBand.db,
      ranges: hasWords ? inBand.guarded : inBand.ranges,
      note:
        `${prefix}ngưỡng yên nhất còn đo được lượng lặng hợp lý: ${inBand.db}dB ` +
        `(${(inBand.ratio * 100).toFixed(1)}% thời lượng, ${inBand.count} khoảng)`,
    };
  }
  const distance = (r: number): number =>
    r < SANE_RATIO_LO ? SANE_RATIO_LO - r : r - SANE_RATIO_HI;
  const best = [...sweep].sort((a, b) => distance(a.ratio) - distance(b.ratio))[0];
  const why =
    best.ratio < SANE_RATIO_LO
      ? "không ngưỡng nào đo đủ 2% lặng - file gần như không có chỗ chết, hoặc nền quá ồn"
      : "mọi ngưỡng đều đo trên 35% lặng - nền rất yên hoặc giọng rất nhỏ, cắt sâu dễ ăn vào tiếng";
  return {
    db: best.db,
    ranges: hasWords ? best.guarded : best.ranges,
    note: `${prefix}KHÔNG có ngưỡng nào rơi vào dải hợp lý (${why}); lấy ngưỡng gần dải nhất: ${best.db}dB (${(best.ratio * 100).toFixed(1)}%)`,
  };
}

/**
 * Nền nhiễu ĐO THẬT: mức trung bình BÊN TRONG các khoảng lặng đã tìm được.
 *
 * Không lấy mean_volume của cả file (file đo được: -26,1dB) vì con số đó là
 * trung bình của cả tiếng nói lẫn khoảng lặng - dùng nó làm "nền nhiễu" là sai
 * hàng chục dB. Cách đúng là đo lại chỉ trên phần lặng bằng aselect.
 *
 * Không có khoảng lặng nào để đo thì lùi về mean_volume của cả file và trả về
 * nó (đó là CẬN TRÊN của nền nhiễu, an toàn hơn là bịa một hằng số).
 */
async function measureNoiseFloorDb(
  wavAbs: string,
  silences: SilenceRange[],
  fallbackMeanDb: number,
  isCanceled?: () => boolean,
): Promise<number> {
  const sample = silences.slice(0, 30);
  if (sample.length === 0) return fallbackMeanDb;
  const expr = sample
    .map((s) => `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`)
    .join("+");
  const stderr = await runFfmpeg(
    ["-i", wavAbs, "-af", `aselect='${expr}',volumedetect`, "-f", "null", "-"],
    { timeoutMs: 300_000, isCanceled, allowNonZero: true },
  );
  const mean = parseFloat(stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)?.[1] ?? "");
  return Number.isFinite(mean) ? mean : fallbackMeanDb;
}

/** mean_volume / max_volume của cả file - một lượt volumedetect */
async function measureVolume(
  wavAbs: string,
  isCanceled?: () => boolean,
): Promise<{ meanDb: number; maxDb: number }> {
  const stderr = await runFfmpeg(["-i", wavAbs, "-af", "volumedetect", "-f", "null", "-"], {
    timeoutMs: 300_000,
    isCanceled,
    allowNonZero: true,
  });
  const mean = parseFloat(stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)?.[1] ?? "");
  const max = parseFloat(stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/)?.[1] ?? "");
  return {
    meanDb: Number.isFinite(mean) ? mean : -30,
    maxDb: Number.isFinite(max) ? max : 0,
  };
}

/** File tạm cho một lượt đo - tên có pid + thời gian để hai job song song không đè nhau */
function tmpWavPath(tag: string): string {
  ensureDir(paths.uploadTmpDir);
  return path.join(
    paths.uploadTmpDir,
    `autotrim-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`,
  );
}

interface Detection {
  durationSec: number;
  thresholdDb: number;
  noiseFloorDb: number;
  /** Khoảng được phép cắt: đã qua hàng rào transcript nếu có truyền `words` */
  raw: SilenceRange[];
  note: string;
  sweep: Array<{ db: number; count: number; ratio: number; midpointRate: number }>;
  guarded: boolean;
  wordGuard: { droppedSec: number; droppedRanges: number };
}

/**
 * Toàn bộ khâu ĐO của module: bóc WAV -> volumedetect -> dò 7 ngưỡng -> giao
 * với khoảng trống giữa chữ (nếu có transcript) -> chọn ngưỡng -> đo nền nhiễu
 * trong chính các khoảng lặng đó.
 *
 * Dùng chung cho analyzeSilence (file gốc) và verifyTrim (file đã cắt) - phải
 * là CÙNG một cách đo, nếu không thì nghiệm thu đang chấm bằng một cái thước
 * khác cái thước đã dùng để cắt. Chính vì dùng chung nên verifyTrim BẮT BUỘC
 * phải nhận `words` (đã dời mốc) mới hết thiên vị - xem ghi chú ở verifyTrim.
 */
async function detect(
  fileAbs: string,
  isCanceled?: () => boolean,
  words?: WordSpan[],
): Promise<Detection> {
  if (!fs.existsSync(fileAbs)) {
    throw new HttpError(404, "TRIM_FILE_NOT_FOUND", `Không thấy file: ${fileAbs}`);
  }
  const wordList = (words ?? []).filter(
    (w) => Number.isFinite(w?.start) && Number.isFinite(w?.end) && w.end > w.start,
  );
  const hasWords = wordList.length > 0;
  const wavAbs = tmpWavPath("probe");
  try {
    await extractProbeWav(fileAbs, wavAbs, isCanceled);
    const durationSec = await probeSeconds(wavAbs, isCanceled);
    const { meanDb } = await measureVolume(wavAbs, isCanceled);
    const gaps = hasWords ? wordGapRanges(wordList, durationSec) : [];

    const sweep: SweepEntry[] = [];
    for (const db of CANDIDATE_DB) {
      if (isCanceled?.()) throw new Error("Job đã bị hủy");
      const ranges = await detectSilences(wavAbs, db, SWEEP_MIN_DUR, durationSec, isCanceled);
      const merged = mergeRanges(ranges);
      sweep.push({
        db,
        count: ranges.length,
        ratio: totalSec(ranges) / durationSec,
        ranges,
        guarded: hasWords ? intersectRanges(merged, gaps) : merged,
        midpointRate: hasWords ? midpointHitRate(wordList, merged) : 0,
      });
    }

    const picked = pickThreshold(sweep, hasWords);
    const chosen = sweep.find((s) => s.db === picked.db);
    const droppedSec = chosen ? Math.max(0, totalSec(chosen.ranges) - totalSec(picked.ranges)) : 0;
    // "Khoảng bị phủ quyết" = khoảng tai máy báo lặng mà transcript cắt bớt
    // hoặc gạt hẳn. Đếm theo khoảng THÔ để con số nói đúng chuyện đã xảy ra.
    const droppedRanges =
      chosen && hasWords
        ? chosen.ranges.filter((r) => {
            const kept = totalSec(intersectRanges([r], picked.ranges));
            return r.duration - kept > 1e-3;
          }).length
        : 0;

    const noiseFloorDb = await measureNoiseFloorDb(wavAbs, picked.ranges, meanDb, isCanceled);
    return {
      durationSec,
      thresholdDb: picked.db,
      noiseFloorDb,
      raw: picked.ranges,
      note: picked.note,
      sweep: sweep.map(({ db, count, ratio, midpointRate }) => ({
        db,
        count,
        ratio,
        midpointRate,
      })),
      guarded: hasWords,
      wordGuard: { droppedSec: round3(droppedSec), droppedRanges },
    };
  } finally {
    // Luôn dọn file tạm, kể cả khi ffmpeg lỗi hay job bị hủy giữa chừng
    fs.rmSync(wavAbs, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Từ khoảng lặng ra danh sách cắt / giữ
// ---------------------------------------------------------------------------

function resolveProfile(aggressiveness?: TrimAggressiveness): TrimProfile {
  return TRIM_PROFILES[aggressiveness ?? DEFAULT_AGGRESSIVENESS] ?? TRIM_PROFILES.default;
}

/**
 * Mốc lặng tối thiểu THỰC SỰ đem ra cắt.
 *
 * Vì sao không dùng thẳng profile.minSilenceSec: profile natural để
 * minSilenceSec 0,90s trong khi maxResidualSec chỉ 0,80s - một khoảng lặng
 * 0,85s sẽ được "để yên" rồi lại làm chính bước nghiệm thu trượt. Hai con số
 * đó phải được hòa giải ở ĐÂY chứ không phải sửa profile (profile là thứ người
 * dùng đọc và hiểu: "natural = chỉ cắt chỗ chết gần một giây").
 */
function effectiveMinSilence(p: TrimProfile): number {
  return Math.min(p.minSilenceSec, p.maxResidualSec);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Gộp các khoảng chồng/liền nhau rồi sắp xếp - ffmpeg trim không chịu được khoảng chồng */
function mergeRanges(ranges: SilenceRange[]): SilenceRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: SilenceRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) {
      if (r.end > last.end) {
        last.end = r.end;
        last.duration = last.end - last.start;
      }
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

/**
 * Khoảng lặng đo được -> khoảng SẼ CẮT.
 *
 * Ba luật khác nhau cho ba vị trí:
 * - Đầu video: cắt sạch chỉ chừa EDGE_KEEP_SEC, bất kể profile. Mở đầu bằng
 *   im lặng là giết hook - đây là lỗi đã gặp thật, không phải giả định.
 * - Cuối video: y hệt, người xem tưởng video treo.
 * - Giữa: chỉ đụng vào khoảng >= effectiveMinSilence, và chừa padSec mỗi mép
 *   để không cụt hơi thở (cắt sát 0 nghe như robot).
 */
function buildCutRanges(
  raw: SilenceRange[],
  durationSec: number,
  p: TrimProfile,
): SilenceRange[] {
  const minSil = effectiveMinSilence(p);
  const cuts: SilenceRange[] = [];
  for (const s of raw) {
    const atHead = s.start <= EDGE_EPS;
    const atTail = s.end >= durationSec - EDGE_EPS;
    let start: number;
    let end: number;
    if (atHead && atTail) {
      // Cả file là một khoảng lặng - không có gì để cứu, bỏ qua cho applyTrim
      // báo "không cắt được" thay vì tạo ra file rỗng.
      continue;
    } else if (atHead) {
      start = 0;
      end = s.end - EDGE_KEEP_SEC;
    } else if (atTail) {
      start = s.start + EDGE_KEEP_SEC;
      end = durationSec;
    } else {
      if (s.duration < minSil) continue;
      start = s.start + p.padSec;
      end = s.end - p.padSec;
    }
    start = Math.max(0, round3(start));
    end = Math.min(durationSec, round3(end));
    if (end - start >= MIN_PIECE_SEC) cuts.push({ start, end, duration: round3(end - start) });
  }
  return mergeRanges(cuts);
}

/**
 * Lưới an toàn cuối cùng: bỏ mọi khoảng cắt có chứa TRUNG ĐIỂM của một chữ.
 *
 * Về lý thuyết không bao giờ chạm tới, vì khoảng cắt đã được giao với phần bù
 * của các chữ ở bước trước. Giữ lại vì đây là luật bất khả xâm phạm của cả
 * tính năng ("không bao giờ cắt vào chỗ có tiếng nói"), và một bất biến chỉ
 * đáng tin khi có chỗ kiểm tra nó - mai kia ai đó sửa buildCutRanges thì cái
 * lưới này bắt được, còn hơn để người dùng nghe thấy một chữ bị nuốt.
 */
function guardMidpoints(cuts: SilenceRange[], words: WordSpan[]): SilenceRange[] {
  if (words.length === 0) return cuts;
  const mids = words
    .filter((w) => Number.isFinite(w?.start) && Number.isFinite(w?.end) && w.end > w.start)
    .map((w) => (w.start + w.end) / 2)
    .sort((a, b) => a - b);
  return cuts.filter((c) => !mids.some((m) => m >= c.start && m <= c.end));
}

/**
 * Phần bù của danh sách cắt trong [0, durationSec].
 *
 * Export vì job auto-trim phải tính lại phần giữ sau khi trộn thêm ứng viên do
 * người duyệt - hai nơi cùng một phép tính thì phải dùng chung một hàm, chép ra
 * làm bản thứ hai là sớm muộn cũng lệch MIN_PIECE_SEC.
 */
export function toKeepRanges(cuts: SilenceRange[], durationSec: number): Array<[number, number]> {
  const keep: Array<[number, number]> = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start - cursor >= MIN_PIECE_SEC) keep.push([round3(cursor), round3(c.start)]);
    cursor = Math.max(cursor, c.end);
  }
  if (durationSec - cursor >= MIN_PIECE_SEC) keep.push([round3(cursor), round3(durationSec)]);
  return keep;
}

/**
 * Đo và lên phương án cắt khoảng lặng - KHÔNG đụng vào file nào.
 *
 * Tách hẳn khỏi applyTrim để gọi được ở chế độ xem trước: web UI hiện được
 * "sẽ cắt bao nhiêu giây" trước khi người dùng bấm đồng ý.
 */
export async function analyzeSilence(
  fileAbs: string,
  aggressiveness?: TrimAggressiveness,
  opts?: {
    isCanceled?: () => boolean;
    /**
     * Danh sách chữ ĐÃ DÀN PHẲNG của chính file này. Truyền vào thì chỉ khoảng
     * TRỐNG GIỮA CHỮ mới được cắt - mức âm thanh một mình không phân biệt được
     * "đang nghỉ" với "đang nói nhỏ" (đo được: 30,4s trong 48,6s mà ffmpeg gọi
     * là lặng thật ra nằm bên trong chữ). Bỏ trống thì giữ nguyên hành vi cũ
     * chỉ-nghe-âm-thanh, cho những bên gọi chưa có transcript.
     */
    words?: WordSpan[];
  },
): Promise<TrimAnalysis> {
  const profile = resolveProfile(aggressiveness);
  const d = await detect(fileAbs, opts?.isCanceled, opts?.words);
  const cuts = guardMidpoints(
    buildCutRanges(d.raw, d.durationSec, profile),
    opts?.words ?? [],
  );
  const keepRanges = toKeepRanges(cuts, d.durationSec);
  const keptSec = keepRanges.reduce((s, [a, b]) => s + (b - a), 0);
  return {
    durationSec: round3(d.durationSec),
    noiseFloorDb: Math.round(d.noiseFloorDb * 10) / 10,
    thresholdDb: d.thresholdDb,
    profile,
    silences: cuts,
    keepRanges,
    removedSec: round3(Math.max(0, d.durationSec - keptSec)),
    thresholdNote: d.note,
    sweep: d.sweep,
    ...(d.guarded ? { wordGuard: d.wordGuard } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cắt
// ---------------------------------------------------------------------------

/**
 * Ghép filter_complex cho MỘT lượt ffmpeg duy nhất.
 *
 * TUYỆT ĐỐI KHÔNG cắt thành nhiều file rồi concat ở lượt sau: mỗi lượt là một
 * lần encode lại, hai lượt là mất chất gấp đôi mà chẳng được gì. trim/atrim +
 * setpts/asetpts + concat làm trọn trong một lệnh.
 *
 * setpts=PTS-STARTPTS là bắt buộc ở MỖI mảnh: không có nó, mảnh thứ hai giữ
 * nguyên timestamp gốc và concat sẽ đẩy ra một video có khoảng trống đúng bằng
 * phần vừa cắt - tức là không cắt được gì.
 *
 * afade ở hai đầu MỌI mảnh cũng bắt buộc, vì lý do khác: xem audioCutFade().
 * Thiếu nó thì mỗi mối nối là một tiếng "tách", và một video cắt mức tight có
 * hàng trăm mối.
 */
export function buildTrimFilter(
  keepRanges: Array<[number, number]>,
  hasVideo: boolean,
  hasAudio: boolean,
): { filter: string; maps: string[] } {
  const parts: string[] = [];
  const labels: string[] = [];
  keepRanges.forEach(([s, e], i) => {
    const from = s.toFixed(3);
    const to = e.toFixed(3);
    if (hasVideo) {
      parts.push(`[0:v]trim=start=${from}:end=${to},setpts=PTS-STARTPTS[v${i}]`);
    }
    if (hasAudio) {
      // Độ dài tính từ chuỗi ĐÃ làm tròn, đúng bằng cái ffmpeg sẽ cắt ra - lấy
      // e - s thô thì mốc fade ra lệch khỏi mép mảnh vài phần nghìn giây.
      const fade = audioCutFade(Number(to) - Number(from));
      parts.push(
        `[0:a]atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS${fade ? `,${fade}` : ""}[a${i}]`,
      );
    }
    labels.push(`${hasVideo ? `[v${i}]` : ""}${hasAudio ? `[a${i}]` : ""}`);
  });
  const outLabels = `${hasVideo ? "[vout]" : ""}${hasAudio ? "[aout]" : ""}`;
  parts.push(
    `${labels.join("")}concat=n=${keepRanges.length}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${outLabels}`,
  );
  const maps: string[] = [];
  if (hasVideo) maps.push("-map", "[vout]");
  if (hasAudio) maps.push("-map", "[aout]");
  return { filter: parts.join(";"), maps };
}

/**
 * Trên 24000 ký tự thì đẩy filter qua file (-/filter_complex).
 *
 * Windows giới hạn dòng lệnh ~32767 ký tự và ffmpeg ĐỨT NGANG chứ không báo
 * lỗi rõ ràng khi vượt. Mỗi mảnh keep tốn ~110 ký tự, nên khoảng 200 mảnh trở
 * lên là chạm trần - hoàn toàn có thật với video 20 phút cắt mức tight.
 */
const FILTER_INLINE_MAX = 24_000;

/**
 * Cắt thật: một lượt ffmpeg, encode lại sạch sẽ.
 *
 * LƯU Ý VỀ HỢP ĐỒNG: keepRanges rỗng hoặc phủ trọn file thì hàm này KHÔNG tạo
 * ra outAbs - không có gì để cắt thì bản sao encode lại chỉ làm giảm chất và
 * tốn thời gian. Bên gọi phải tự dùng file gốc trong ca đó (xem removedSec của
 * analyzeSilence để biết trước).
 */
export async function applyTrim(
  fileAbs: string,
  keepRanges: Array<[number, number]>,
  outAbs: string,
  opts?: { isCanceled?: () => boolean; onLog?: (l: string) => void },
): Promise<void> {
  const log = opts?.onLog ?? ((): void => {});
  if (!fs.existsSync(fileAbs)) {
    throw new HttpError(404, "TRIM_FILE_NOT_FOUND", `Không thấy file: ${fileAbs}`);
  }
  if (keepRanges.length === 0) {
    log("[trim] Không có đoạn nào để giữ - bỏ qua, giữ nguyên file gốc.");
    return;
  }
  const durationSec = await probeSeconds(fileAbs, opts?.isCanceled);
  const keptSec = keepRanges.reduce((s, [a, b]) => s + (b - a), 0);
  // Phủ trọn file (sai số 0,05s) = không cắt được gì
  if (keepRanges.length === 1 && keptSec >= durationSec - EDGE_EPS) {
    log(
      `[trim] Không có khoảng lặng nào đáng cắt (giữ ${keptSec.toFixed(2)}s/${durationSec.toFixed(2)}s) - bỏ qua encode.`,
    );
    return;
  }

  const { hasVideo, hasAudio } = await probeStreams(fileAbs, opts?.isCanceled);
  if (!hasVideo && !hasAudio) {
    throw new HttpError(
      400,
      "TRIM_NO_STREAM",
      `File ${path.basename(fileAbs)} không có stream video lẫn audio - không cắt được.`,
    );
  }
  const { filter, maps } = buildTrimFilter(keepRanges, hasVideo, hasAudio);
  ensureDir(path.dirname(outAbs));

  let scriptAbs: string | null = null;
  const filterArgs: string[] =
    filter.length <= FILTER_INLINE_MAX ? ["-filter_complex", filter] : [];
  try {
    if (filterArgs.length === 0) {
      scriptAbs = path.join(
        paths.uploadTmpDir,
        `autotrim-filter-${process.pid}-${Date.now()}.txt`,
      );
      ensureDir(paths.uploadTmpDir);
      fs.writeFileSync(scriptAbs, filter, "utf8");
      filterArgs.push("-filter_complex_script", scriptAbs);
      log(`[trim] Filter dài ${filter.length} ký tự - đẩy qua file tạm cho khỏi vượt trần lệnh.`);
    }

    log(
      `[trim] Cắt ${keepRanges.length} đoạn giữ lại, ${keptSec.toFixed(2)}s/${durationSec.toFixed(2)}s ` +
        `(bỏ ${(durationSec - keptSec).toFixed(2)}s).`,
    );
    // Thời lượng thực tế quyết định timeout: encode x264 veryfast nhanh hơn
    // thời gian thật nhiều lần, nhưng máy yếu + 4K thì không - cho dư 4x.
    const timeoutMs = Math.min(3_600_000, 300_000 + Math.ceil(keptSec) * 4_000);
    await runFfmpeg(
      [
        "-i",
        fileAbs,
        ...filterArgs,
        ...maps,
        // crf 20 (thấp hơn một bậc so với bước reframe dùng 21): đây là bản
        // TRUNG GIAN, còn bị Remotion encode lại lần nữa ở khâu lắp ráp, nên
        // để dư chút chất cho khỏi cộng dồn mất mát.
        ...(hasVideo
          ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
          : []),
        ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
        "-movflags",
        "+faststart",
        outAbs,
      ],
      { timeoutMs, isCanceled: opts?.isCanceled },
    );
    const outSec = await probeSeconds(outAbs, opts?.isCanceled);
    log(`[trim] Xong: ${path.basename(outAbs)} dài ${outSec.toFixed(2)}s (dự kiến ${keptSec.toFixed(2)}s).`);
  } finally {
    if (scriptAbs) fs.rmSync(scriptAbs, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Dời timestamp của transcript theo đúng nhát cắt
// ---------------------------------------------------------------------------

interface WordLike {
  start?: number;
  end?: number;
  [k: string]: unknown;
}
interface SegmentLike {
  start?: number;
  end?: number;
  words?: WordLike[];
  [k: string]: unknown;
}
interface TranscriptLike {
  duration?: number;
  segments?: SegmentLike[];
  [k: string]: unknown;
}

/**
 * Bảng quy đổi mốc thời gian cũ -> mới.
 *
 * Mỗi đoạn giữ lại có một "offset" là tổng thời lượng các đoạn giữ TRƯỚC nó;
 * mốc t nằm trong đoạn [s,e] thứ k đổi thành offset_k + (t - s). Nói cách khác
 * lượng dời (shift) không phải một hằng số mà tăng dần theo từng nhát cắt -
 * đây chính là chỗ quy trình gõ tay hay sai: trừ đi một hằng số duy nhất thì
 * nửa sau của transcript lệch dần đến vài giây.
 */
function buildMapper(keepRanges: Array<[number, number]>): {
  ranges: Array<{ start: number; end: number; offset: number }>;
  totalSec: number;
} {
  const sorted = [...keepRanges].sort((a, b) => a[0] - b[0]);
  const ranges: Array<{ start: number; end: number; offset: number }> = [];
  let offset = 0;
  for (const [s, e] of sorted) {
    if (e <= s) continue;
    ranges.push({ start: s, end: e, offset });
    offset += e - s;
  }
  return { ranges, totalSec: offset };
}

/**
 * Dời một mốc. dir quyết định cách xử lý mốc rơi ĐÚNG vào phần bị cắt:
 * - "start": kéo tới đầu đoạn giữ kế tiếp (chữ bắt đầu trong chỗ bị cắt thì
 *   coi như bắt đầu ngay khi tiếng nói quay lại)
 * - "end": kéo lùi về cuối đoạn giữ trước đó
 * Trả null khi không còn đoạn giữ nào ở phía đó.
 */
function mapTime(
  t: number,
  ranges: Array<{ start: number; end: number; offset: number }>,
  dir: "start" | "end",
): number | null {
  for (const r of ranges) {
    if (t >= r.start && t <= r.end) return round3(r.offset + (t - r.start));
  }
  if (dir === "start") {
    const next = ranges.find((r) => r.start > t);
    return next ? round3(next.offset) : null;
  }
  let prev: { start: number; end: number; offset: number } | null = null;
  for (const r of ranges) if (r.end < t) prev = r;
  return prev ? round3(prev.offset + (prev.end - prev.start)) : null;
}

/** [a,b] có phần chung thật sự (> 0) với một đoạn giữ nào không */
function survives(
  a: number,
  b: number,
  ranges: Array<{ start: number; end: number; offset: number }>,
): boolean {
  for (const r of ranges) {
    const lo = Math.max(a, r.start);
    const hi = Math.min(b, r.end);
    if (hi - lo > 1e-6) return true;
    // Chữ dài 0 giây (một số bộ bóc băng trả start == end) vẫn phải giữ nếu
    // nó nằm trong đoạn giữ - so sánh "> 0" ở trên sẽ loại oan.
    if (a === b && a >= r.start && a <= r.end) return true;
  }
  return false;
}

/**
 * Dời toàn bộ timestamp của transcript sang hệ thời gian của file ĐÃ CẮT.
 *
 * Bắt buộc chạy ngay sau applyTrim: mọi thứ phía sau (phụ đề, key nổi bật,
 * sound effect, zoom) đều bám vào transcript, để lệch một lần là lệch hết.
 *
 * Chữ / câu nằm TRỌN trong phần bị cắt thì biến mất; câu nào còn chữ sống thì
 * start/end của câu được ép về đúng biên chữ còn lại (giữ nguyên start cũ sẽ
 * ra một câu bắt đầu trước cả chữ đầu tiên của chính nó).
 *
 * Mọi trường khác (text, srcIndex, confidence, speaker...) được sao nguyên -
 * hàm này chỉ biết về start/end/words/segments.
 */
export function remapWordTimestamps<T>(transcript: T, keepRanges: Array<[number, number]>): T {
  const src = transcript as unknown as TranscriptLike;
  const { ranges, totalSec } = buildMapper(keepRanges);
  if (!src || typeof src !== "object" || !Array.isArray(src.segments)) return transcript;
  // Không có đoạn giữ nào (chưa cắt gì / danh sách rỗng) -> trả nguyên vẹn,
  // đúng với hợp đồng "không cắt thì không đụng" của applyTrim.
  if (ranges.length === 0) return transcript;

  const segments: SegmentLike[] = [];
  for (const seg of src.segments) {
    const words = Array.isArray(seg.words) ? seg.words : null;
    if (words && words.length > 0) {
      const kept: WordLike[] = [];
      for (const w of words) {
        const ws = typeof w.start === "number" ? w.start : null;
        const we = typeof w.end === "number" ? w.end : ws;
        if (ws === null || we === null) continue;
        if (!survives(ws, we, ranges)) continue;
        const ns = mapTime(ws, ranges, "start");
        const ne = mapTime(we, ranges, "end");
        if (ns === null || ne === null) continue;
        kept.push({ ...w, start: ns, end: Math.max(ns, ne) });
      }
      if (kept.length === 0) continue; // cả câu nằm trong phần bị cắt
      const first = kept[0].start as number;
      const last = kept[kept.length - 1].end as number;
      segments.push({ ...seg, start: first, end: Math.max(first, last), words: kept });
      continue;
    }
    // Câu không kèm word timestamp: xử như một "chữ" dài bằng cả câu
    const ss = typeof seg.start === "number" ? seg.start : null;
    const se = typeof seg.end === "number" ? seg.end : ss;
    if (ss === null || se === null) {
      segments.push({ ...seg });
      continue;
    }
    if (!survives(ss, se, ranges)) continue;
    const ns = mapTime(ss, ranges, "start");
    const ne = mapTime(se, ranges, "end");
    if (ns === null || ne === null) continue;
    segments.push({ ...seg, start: ns, end: Math.max(ns, ne) });
  }

  const out: TranscriptLike = { ...src, segments };
  // duration của transcript phải khớp file mới, nếu không thì bước dựng sau
  // lại đi kéo timeline theo con số cũ (dài hơn thật vài giây).
  if (typeof src.duration === "number") out.duration = round3(totalSec);
  return out as unknown as T;
}

// ---------------------------------------------------------------------------
// Nghiệm thu
// ---------------------------------------------------------------------------

/**
 * Khoảng lặng ngắn hơn mức này KHÔNG tính là chỗ chết khi nghiệm thu.
 *
 * Lấy min(maxResidualSec, minSilenceSec-hiệu-lực) chứ không phải một hằng số:
 * với profile default thì mốc là 0,45s - đúng bằng thứ mà bước cắt hứa sẽ xử
 * lý, nên nghiệm thu đang chấm ĐÚNG lời hứa của chính profile đó. Đếm cả nhịp
 * ngắt 0,2-0,3s vào "chỗ chết" thì video nào cũng trượt, mà đó lại là nhịp nói
 * bình thường của con người.
 */
function residualFloor(p: TrimProfile): number {
  return Math.min(p.maxResidualSec, effectiveMinSilence(p));
}

/**
 * Đo lại file ĐÃ CẮT và chấm đậu/trượt theo profile.
 *
 * Hai điều kiện, trượt một là trượt cả:
 * 1. longest > maxResidualSec - còn một chỗ chết dài lộ liễu.
 * 2. ratio > maxResidualRatio - không chỗ nào quá dài nhưng cộng lại vẫn nặng.
 *
 * Điều kiện (2) mới là thứ luật cũ thiếu: file đo được có 13 khoảng lặng
 * 0,45-0,67s, không cái nào chạm mốc 0,8s của luật cũ nên "đậu", trong khi
 * tổng 6,7s = 4,2% thời lượng và tai người nghe ra ngay là video lê thê.
 *
 * PHẢI TRUYỀN `words` (mốc đã dời sang hệ thời gian của file đã cắt - lấy từ
 * remapWordTimestamps). Không truyền thì kết quả KHÔNG ĐÁNG TIN, và phải nói
 * rõ là không đáng tin theo CẢ HAI CHIỀU - đã đo được cả hai:
 *
 * - Chấm đậu oan (vòng luẩn quẩn): trên face.cut.mp4, luật không-transcript
 *   chọn -35dB, cắt được 3 chỗ, rồi nghiệm thu cũng bằng -35dB và tự chấm
 *   mình đậu, trong khi tai người vẫn nghe ra chỗ chết.
 * - Chấm trượt oan: trên bản cắt từ thanhtoan80.mov, nghiệm thu không
 *   transcript báo còn 4,56s lặng và TRƯỢT, còn nghiệm thu có transcript đo ra
 *   0,00s và đậu. 4,56s đó là tiếng nói nhỏ nằm bên trong chữ, không phải chỗ
 *   chết - không có gì để cắt thêm cả.
 *
 * Nói cách khác chế độ không-transcript không phải "dễ dãi", nó là ĐOÁN MÒ.
 * Chỉ dùng khi thật sự không có transcript, và `reason` luôn nói ra điều đó
 * kể cả khi đậu.
 */
export async function verifyTrim(
  fileAbs: string,
  aggressiveness?: TrimAggressiveness,
  opts?: {
    isCanceled?: () => boolean;
    /** Chữ của CHÍNH file đã cắt - phải là bản đã dời mốc, không phải bản gốc */
    words?: WordSpan[];
  },
): Promise<TrimVerification> {
  const profile = resolveProfile(aggressiveness);
  const d = await detect(fileAbs, opts?.isCanceled, opts?.words);
  const floor = residualFloor(profile);
  const residual = d.raw
    .filter((s) => s.duration >= floor)
    .map((s) => ({ start: round3(s.start), end: round3(s.end), duration: round3(s.duration) }));
  const totalSilenceSec = round3(residual.reduce((sum, s) => sum + s.duration, 0));
  const ratio = d.durationSec > 0 ? totalSilenceSec / d.durationSec : 0;
  const longest = residual.reduce((m, s) => Math.max(m, s.duration), 0);

  const fails: string[] = [];
  if (longest > profile.maxResidualSec) {
    const worst = residual.find((s) => s.duration === longest);
    fails.push(
      `còn khoảng lặng ${longest.toFixed(2)}s (trần ${profile.maxResidualSec}s)` +
        (worst ? ` tại ${worst.start.toFixed(2)}s` : ""),
    );
  }
  if (ratio > profile.maxResidualRatio) {
    fails.push(
      `tổng lặng ${totalSilenceSec.toFixed(2)}s = ${(ratio * 100).toFixed(1)}% thời lượng ` +
        `(trần ${(profile.maxResidualRatio * 100).toFixed(0)}%)`,
    );
  }
  const pass = fails.length === 0;
  const how = d.guarded
    ? `Đo ở ngưỡng ${d.thresholdDb}dB có đối chiếu transcript (${d.wordGuard.droppedSec}s tai máy gọi là lặng nhưng thật ra là tiếng nói nhỏ, đã loại)`
    : `Đo ở ngưỡng ${d.thresholdDb}dB, KHÔNG có transcript nên chỉ nghe mức âm thanh - con số này không đáng tin theo cả hai chiều (vừa có thể chấm đậu oan vì tự chấm bằng chính ngưỡng đã dùng để cắt, vừa có thể chấm trượt oan vì đếm cả tiếng nói nhỏ trong chữ là lặng). Truyền words đã dời mốc để đo thật`;
  return {
    residual,
    totalSilenceSec,
    ratio: Math.round(ratio * 10000) / 10000,
    longest: round3(longest),
    pass,
    ...(pass && d.guarded
      ? {}
      : {
          reason: pass
            ? `Đạt ở mức "${aggressiveness ?? DEFAULT_AGGRESSIVENESS}", NHƯNG chưa chắc chắn: ${how}.`
            : `Chưa đạt ở mức "${aggressiveness ?? DEFAULT_AGGRESSIVENESS}": ${fails.join("; ")}. ` +
              `${how}, nền nhiễu ${d.noiseFloorDb.toFixed(1)}dB, chỉ tính khoảng lặng >= ${floor}s.`,
        }),
  };
}
