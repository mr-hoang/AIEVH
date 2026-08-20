/**
 * Dò "mỡ thừa" trong transcript tiếng Việt - từ đệm, vấp, quay lại lấy nét (repeat take)
 * và những khoảng chần chừ mà silencedetect bỏ sót.
 *
 * VÌ SAO CÓ FILE NÀY: trước đây AI đọc cả transcript rồi "cảm thấy" chỗ nào thừa.
 * Cảm thấy thì không lặp lại được, không giải thích được, và mỗi lần chạy ra một
 * kết quả khác. Module này sinh ỨNG VIÊN một cách tất định (cùng transcript ->
 * cùng danh sách, cùng điểm tin cậy); AI chỉ còn việc DUYỆT hoặc TỪ CHỐI từng ứng
 * viên. Nhờ vậy mọi đề xuất cắt đều kèm lý do và ngữ cảnh để người/AI đối chiếu.
 *
 * TRIẾT LÝ: THÀ BỎ SÓT CÒN HƠN CẮT NHẦM. Một từ đệm sót lại chỉ làm video dài
 * thêm 0,4 giây; một từ thật bị cắt làm câu nói vô nghĩa và người xem nghe ra
 * ngay. Vì thế mọi ngưỡng ở đây đều nghiêng về phía dè dặt, và mọi tín hiệu mơ hồ
 * đều bị hạ điểm tin cậy thay vì được "cho qua".
 *
 * BÀI TOÁN NGÔN NGỮ RIÊNG CỦA TIẾNG VIỆT: từ đệm tiếng Việt gần như luôn TRÙNG
 * với từ có nghĩa. "đó", "ấy", "thế", "mà", "là" vừa là hư từ đệm vừa là chỉ định
 * từ / liên từ thật. Cắt theo danh sách từ là phá nát lời nói. Cho nên detector ở
 * đây KHÔNG bao giờ chỉ dựa vào mặt chữ: nó đòi thêm bằng chứng NGỮ CẢNH và
 * NGỮ ÂM (từ đứng một mình thành một cụm, kéo dài bất thường so với chính người
 * nói, lặp ngay lại, có ngắt trước và sau).
 *
 * Hàm thuần: không đọc file, không gọi ffmpeg, không đụng DB. Vào là transcript
 * đã parse, ra là báo cáo. Cố tình KHÔNG import transcript.ts dù file đó có sẵn
 * kiểu dữ liệu - import vào là kéo theo `fs`/`path`/`meta.js`, mất tính thuần.
 */

// ---------------------------------------------------------------------------
// Kiểu dữ liệu công khai
// ---------------------------------------------------------------------------

export type DeadWeightKind = "filler" | "stutter" | "repeat-take" | "hesitation";

export interface DeadWeightCandidate {
  kind: DeadWeightKind;
  start: number;
  end: number;
  /** Nguyên văn phần đề xuất cắt. Với "hesitation" thì không có chữ nào nên ghi mô tả khoảng lặng. */
  text: string;
  /** 0..1 - càng cao càng chắc là mỡ thừa */
  confidence: number;
  /** Tiếng Việt, giải thích vì sao đề xuất cắt (để người duyệt cãi lại được) */
  reason: string;
  /** Câu chứa nó, để người/AI duyệt hiểu ngữ cảnh */
  context: string;
}

export interface DeadWeightReport {
  candidates: DeadWeightCandidate[];
  /** Tổng thời lượng nếu cắt hết (các ứng viên đã được khử chồng lấn nên cộng thẳng) */
  totalSec: number;
  byKind: Record<DeadWeightKind, { count: number; sec: number }>;
}

const KINDS: DeadWeightKind[] = ["filler", "stutter", "repeat-take", "hesitation"];

// ---------------------------------------------------------------------------
// Từ điển - đã soi trên transcript thật (video-projects/demo1) chứ không bịa
// ---------------------------------------------------------------------------

/**
 * Từ đệm "cứng": thán từ thuần túy, không mang nghĩa từ vựng. An toàn khi đứng
 * tách khỏi câu. Vẫn KHÔNG cắt mù: "à" trong "à ơi", hay "ừ" là lời đồng ý dứt
 * khoát, đều là chữ thật - nên vẫn phải có ngắt hoặc bị kéo dài mới tính.
 */
const HARD_FILLERS = new Set([
  "ừm",
  "ừmm",
  "ưm",
  "ờ",
  "ờm",
  "à",
  "ừ",
  "ơ",
  "ehm",
  "hm",
  "hmm",
  "hử",
  "ừa",
  "ậm",
  "ừm ừm",
  "à ừ",
]);

/**
 * Từ đệm "mềm": chỉ định từ / tiểu từ, PHẦN LỚN các lần xuất hiện là nghĩa thật.
 * Chỉ được đề xuất khi đứng MỘT MÌNH thành nguyên một cụm (xem gate ở dưới).
 *
 * Đo trên transcript thật: 6 lần "Đó" đứng thành nguyên một segment, kéo dài
 * 0,36-0,62s cho 2 ký tự (0,18-0,31 s/ký tự) trong khi trung vị của chính người
 * nói là 0,055 s/ký tự - tức bị ngân dài gấp 3 tới 5 lần. Đó là tiếng "đó" chốt
 * câu, cắt đi lời nói không suy suyển. Còn "đó" trong "vài con AI đó",
 * "cái đó", "điều đó" thì tuyệt đối không đụng vào.
 */
const SOFT_FILLERS = new Set(["đó", "đấy", "ấy", "thế", "vậy"]);

/**
 * Cụm đệm nhiều từ. Cũng chỉ tính khi chiếm trọn một cụm - "Tức là mình lấy số
 * lượt thanh toán..." là câu thật, còn "Tức là" đứng trơ một mình rồi người nói
 * đổi ý nói lại thì mới là mỡ thừa.
 *
 * Danh sách gồm phần yêu cầu sẵn cộng những cụm ĐO ĐƯỢC trên transcript thật:
 * "hoặc là", "tóm lại là", "bởi vì là", "toàn bộ là" - đều là câu bỏ dở rồi nói lại.
 */
const PHRASE_FILLERS = new Set([
  "kiểu như",
  "kiểu là",
  "kiểu kiểu",
  "đại loại là",
  "đại loại",
  "nói chung là",
  "nói chung",
  "thật ra thì",
  "thật ra là",
  "thì là",
  "cái là",
  "tóm lại là",
  "tóm lại",
  "cái mà",
  "thế thì là",
]);

/**
 * Cụm đứng một mình NHƯNG mang quan hệ logic thật (chọn lựa, nguyên nhân, giải
 * thích). Đứng trơ một mình thì THƯỜNG là câu bỏ dở, nhưng KHÔNG PHẢI LÚC NÀO CŨNG:
 * đã soi tay trên demo1 và thấy đúng một ca cắt nhầm - "…có thể là ok ứng dụng
 * nó / Hoặc là / Tham khảo để tìm cách…" là phép chọn lựa THẬT, cắt "Hoặc là" đi
 * là mất vế "hoặc". Trong khi "Còn trường hợp mà mọi người có thể nghe / Hoặc là /
 * Còn trường hợp mà người AI không ứng dụng được…" thì đúng là câu bỏ dở.
 *
 * Mặt chữ không phân biệt được hai ca này, chỉ ngữ nghĩa mới phân biệt được - mà
 * ngữ nghĩa là việc của bước DUYỆT. Nên chúng bị hạ điểm nền để rơi vào vùng
 * "phải đọc kỹ" thay vì vùng "gần như chắc chắn", và câu lý do nói thẳng điều đó.
 */
const CONNECTOR_FILLERS = new Set([
  "hoặc là",
  "bởi vì là",
  "tức là",
  "với lại là",
  "nói cách khác là",
  "thì là vì",
]);

/**
 * Đứng ngay trước "đó/ấy/thế/đấy" thì đó là chỉ định từ, KHÔNG BAO GIỜ cắt:
 * anh ấy, chị ấy, cô ấy, ông ấy, bà ấy, người ấy, cái ấy, chỗ ấy, hôm ấy,
 * lúc ấy, việc ấy, cái đó, chỗ đó, lúc đó, hôm đó, người đó, ở đó, từ đó,
 * do đó, điều đó, như thế, vì thế...
 */
const REFERENT_BEFORE = new Set([
  "anh",
  "chị",
  "cô",
  "ông",
  "bà",
  "em",
  "chú",
  "bác",
  "thầy",
  "cháu",
  "bạn",
  "người",
  "con",
  "cái",
  "chỗ",
  "nơi",
  "hôm",
  "lúc",
  "ngày",
  "đêm",
  "buổi",
  "năm",
  "việc",
  "chuyện",
  "điều",
  "thứ",
  "số",
  "phía",
  "bên",
  "đằng",
  "ở",
  "từ",
  "do",
  "vì",
  "như",
  "tại",
  "đến",
  "với",
  "của",
  "này",
  "kia",
  "nọ",
  "trong",
  "ngoài",
  "trước",
  "sau",
  "mức",
  "thế",
  "vậy",
]);

/**
 * Đứng ngay sau "Đó," ở đầu cụm thì "đó" là chủ ngữ thật ("Đó là cái landing"),
 * không phải tiếng chốt câu.
 */
const SUBJECT_AFTER = new Set(["là", "thì", "mà", "nên", "chính", "cũng", "chưa", "không"]);

/**
 * Từ láy đôi hợp lệ của tiếng Việt - lặp liền nhau là ĐÚNG CHÍNH TẢ, không phải
 * vấp. Bỏ danh sách này đi là "từ từ", "dần dần", "luôn luôn" bị cắt mất một nửa.
 */
const REDUPLICATIONS = new Set([
  "từ",
  "dần",
  "luôn",
  "mãi",
  "ngày",
  "người",
  "nhà",
  "đều",
  "xa",
  "xanh",
  "đo",
  "tim",
  "khe",
  "thoang",
  "lâng",
  "nao",
  "hây",
  "vừa",
  "càng",
  "ai",
  "gì",
  "nào",
  "đâu",
  "mỗi",
  "từng",
  "nhiều",
  "ít",
  "hơi",
  "rất",
  "thỉnh",
  "lăm",
  "phăng",
  "nhè",
  "cỏn",
]);

// ---------------------------------------------------------------------------
// Ngưỡng - phần lớn suy ra từ chính người nói, hằng số chỉ là sàn an toàn
// ---------------------------------------------------------------------------

/** Mức tin cậy tối thiểu mặc định của ứng viên trả về */
const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Kéo dài gấp bao nhiêu lần trung vị s/ký tự của CHÍNH người nói thì coi là ngân.
 * Không hằng số tuyệt đối: người nói nhanh và người nói chậm lệch nhau 2-3 lần,
 * lấy số cứng là hoặc bắt oan hoặc bỏ sót toàn bộ.
 */
const ELONGATION_STRONG = 3;
const ELONGATION_MILD = 2;

/** Dưới ngần này từ đo được thì trung vị s/ký tự không đáng tin -> bỏ hẳn tín hiệu ngân */
const MIN_WORDS_FOR_DPC = 20;

/**
 * Sàn cứng cho ngưỡng "chần chừ". Ngưỡng thật lấy từ phân bố quãng nghỉ của chính
 * người nói (xem gapStats), nhưng không bao giờ được tụt dưới mức này: nhịp ngắt
 * nghỉ bình thường giữa hai ý cũng dài 0,6-0,8s, cắt vào là lời nói dồn cục.
 */
const HESITATION_FLOOR_SEC = 0.8;

/** Không đo được đủ quãng nghỉ dương thì dùng ngưỡng cứng rộng rãi này */
const HESITATION_FALLBACK_SEC = 1.5;

/** Chừa hai đầu khoảng lặng khi cắt - cắt sát quá là cụt phụ âm đầu/đuôi từ */
const HESITATION_PAD_SEC = 0.12;

/** Khoảng lặng còn lại sau khi chừa hai đầu mà ngắn hơn ngần này thì cắt không bõ */
const HESITATION_MIN_CUT_SEC = 0.3;

/** Hai lần vấp cách nhau quá lâu thì không còn là vấp nữa */
const STUTTER_MAX_GAP_SEC = 1.5;

/** Lấy nét lại phải xảy ra trong cửa sổ này mới coi là nói lại, xa hơn là nhắc lại có chủ ý */
const REPEAT_WINDOW_SEC = 15;

/** Tối đa bao nhiêu cụm chen giữa lần nói hỏng và lần nói lại */
const REPEAT_MAX_INTERVENING_UNITS = 2;

/** Tỉ lệ trùng tối thiểu (LCS trên token) để coi là cùng một câu nói lại */
const REPEAT_MIN_SIMILARITY = 0.75;

/** Chỗ trùng phải bắt đầu trong ngần này token đầu của câu nói lại (neo đầu câu) */
const REPEAT_ANCHOR_MAX_OFFSET = 2;

// ---------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Số giây viết theo lối tiếng Việt (dấu phẩy thập phân) để nhét vào câu lý do */
function fmtSec(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

/**
 * Chuẩn hóa một token để so sánh: NFC (transcript thật đang là NFC, nhưng file
 * do công cụ khác sinh ra có thể là NFD -> "đó" sẽ không khớp "đó"), viết thường,
 * bỏ mọi thứ không phải chữ/số. Trả "" nếu token chỉ có dấu câu hoặc số lẻ như ".000".
 */
function normToken(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[clamp(Math.floor(p * (sortedAsc.length - 1)), 0, sortedAsc.length - 1)];
}

/**
 * Dãy con chung dài nhất - đo "câu sau có chứa gần đủ câu trước không".
 * Trả kèm `firstB` = vị trí token ĐẦU TIÊN của b được khớp; đó là mốc để biết
 * lần nói lại có bắt đầu ngay từ đầu câu sau hay chỉ trùng lạc ở giữa.
 */
function lcsMatch(a: string[], b: string[]): { len: number; firstB: number } {
  if (a.length === 0 || b.length === 0) return { len: 0, firstB: -1 };
  const w = b.length + 1;
  const dp = new Int32Array((a.length + 1) * w);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i * w + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * w + (j - 1)] + 1
          : Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)]);
    }
  }
  // Lần ngược để lấy vị trí khớp đầu tiên trong b
  let i = a.length;
  let j = b.length;
  let firstB = -1;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && dp[i * w + j] === dp[(i - 1) * w + (j - 1)] + 1) {
      firstB = j - 1;
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + (j - 1)]) {
      i--;
    } else {
      j--;
    }
  }
  return { len: dp[a.length * w + b.length], firstB };
}

// ---------------------------------------------------------------------------
// Parse phòng thủ - transcript hỏng thì trả báo cáo rỗng, KHÔNG BAO GIỜ throw
// ---------------------------------------------------------------------------

interface PWord {
  raw: string;
  norm: string;
  start: number;
  end: number;
  /** Chỉ số cụm (segment) chứa từ này */
  unit: number;
  /** Vị trí trong cụm */
  posInUnit: number;
  /** Chỉ số trong mảng từ toàn cục */
  gi: number;
}

interface PUnit {
  index: number;
  start: number;
  end: number;
  text: string;
  /** Rỗng nếu segment không có mốc thời gian từng từ */
  words: PWord[];
  /** Token đã chuẩn hóa - luôn có, kể cả khi segment chỉ có `text` */
  tokens: string[];
  /** true khi có mốc thời gian từng từ (mới chạy được các detector mức từ) */
  timed: boolean;
}

/** Lấy mảng segment thô từ mọi dạng transcript đã gặp trong repo */
function rawSegments(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (Array.isArray(o.segments)) return o.segments;
    // Dạng chỉ có mảng từ: gom tạm thành MỘT cụm; các detector mức cụm sẽ yếu đi
    // nhưng thà yếu còn hơn vỡ.
    if (Array.isArray(o.words)) return [{ words: o.words }];
  }
  return [];
}

function parseUnits(input: unknown): PUnit[] {
  const units: PUnit[] = [];
  let gi = 0;
  for (const rawSeg of rawSegments(input)) {
    if (!rawSeg || typeof rawSeg !== "object") continue;
    const seg = rawSeg as Record<string, unknown>;
    const index = units.length;
    const words: PWord[] = [];
    const rawWords = Array.isArray(seg.words) ? seg.words : [];
    for (const rawWord of rawWords) {
      if (!rawWord || typeof rawWord !== "object") continue;
      const w = rawWord as Record<string, unknown>;
      const raw = str(w.word) || str(w.text);
      const start = num(w.start);
      const end = num(w.end);
      if (!raw.trim() || start === null || end === null) continue;
      // Mốc lộn ngược hoặc âm là dữ liệu hỏng - bỏ từ đó, đừng đoán
      if (start < 0 || end < start) continue;
      words.push({
        raw: raw.trim(),
        norm: normToken(raw),
        start,
        end,
        unit: index,
        posInUnit: words.length,
        gi: 0,
      });
    }
    const text = str(seg.text).trim() || words.map((w) => w.raw).join(" ");
    const segStart = num(seg.start);
    const segEnd = num(seg.end);
    const start = segStart !== null && segStart >= 0 ? segStart : (words[0]?.start ?? null);
    const end = segEnd !== null ? segEnd : (words[words.length - 1]?.end ?? null);
    if (start === null || end === null || end < start) {
      // Không có mốc thời gian nào dùng được -> cụm này vô dụng với việc cắt
      if (words.length === 0) continue;
    }
    const unitStart = start ?? words[0].start;
    const unitEnd = end ?? words[words.length - 1].end;
    if (!Number.isFinite(unitStart) || !Number.isFinite(unitEnd) || unitEnd < unitStart) continue;
    const tokens =
      words.length > 0
        ? words.map((w) => w.norm).filter(Boolean)
        : text
            .split(/\s+/)
            .map(normToken)
            .filter(Boolean);
    if (tokens.length === 0) continue;
    for (const w of words) w.gi = gi++;
    units.push({
      index,
      start: unitStart,
      end: unitEnd,
      text,
      words,
      tokens,
      timed: words.length > 0,
    });
  }
  // Đánh lại chỉ số cụm cho khớp vị trí thật trong mảng (đã bỏ bớt cụm hỏng)
  units.forEach((u, i) => {
    u.index = i;
    for (const w of u.words) w.unit = i;
  });
  return units;
}

// ---------------------------------------------------------------------------
// Số đo của CHÍNH người nói - mọi ngưỡng động đều lấy từ đây
// ---------------------------------------------------------------------------

interface SpeakerStats {
  /** Trung vị giây/ký tự - mốc để biết một từ có bị ngân dài bất thường không */
  medianDpc: number;
  /** Có đủ dữ liệu để tin medianDpc không */
  dpcUsable: boolean;
  /** Ngưỡng coi là "có ngắt" giữa hai từ */
  pauseSec: number;
  /** Ngưỡng coi là "chần chừ" */
  hesitationSec: number;
}

function computeStats(words: PWord[], gaps: Array<number | null>): SpeakerStats {
  const dpc: number[] = [];
  for (const w of words) {
    const letters = w.norm.replace(/\p{N}+/gu, "").length;
    const dur = w.end - w.start;
    if (letters > 0 && dur > 0) dpc.push(dur / letters);
  }
  const medianDpc = median(dpc);

  /**
   * ĐO THẬT trên transcript demo1: 834 quãng giữa từ thì 795 quãng BẰNG 0 - máy
   * nhận dạng nối end của từ trước vào start của từ sau, chỉ chừa quãng thật ở
   * ranh giới câu. Vì thế lấy phân vị trên TOÀN BỘ quãng là vô nghĩa (p90 = 0).
   * Phải lấy phân vị trên các quãng DƯƠNG, tức phân bố của những lần người này
   * thật sự ngừng lời.
   */
  const positive = gaps.filter((g): g is number => g !== null && g > 0.0001).sort((a, b) => a - b);
  const pauseSec = positive.length >= 8 ? clamp(percentile(positive, 0.5), 0.2, 0.6) : 0.35;
  const hesitationSec =
    positive.length >= 8
      ? Math.max(HESITATION_FLOOR_SEC, percentile(positive, 0.9) * 1.2)
      : HESITATION_FALLBACK_SEC;

  return {
    medianDpc,
    dpcUsable: dpc.length >= MIN_WORDS_FOR_DPC && medianDpc > 0,
    pauseSec,
    hesitationSec,
  };
}

// ---------------------------------------------------------------------------
// Bộ khung dò
// ---------------------------------------------------------------------------

interface Ctx {
  units: PUnit[];
  words: PWord[];
  /**
   * gaps[i] = quãng lặng trước words[i]. null nghĩa là KHÔNG BIẾT (từ đầu tiên,
   * hoặc phía trước có cụm thiếu mốc thời gian) - không được suy diễn thành 0.
   */
  gaps: Array<number | null>;
  stats: SpeakerStats;
}

function buildCtx(units: PUnit[]): Ctx {
  const words: PWord[] = [];
  for (const u of units) for (const w of u.words) words.push(w);
  const gaps: Array<number | null> = [];
  for (let i = 0; i < words.length; i++) {
    if (i === 0) {
      gaps.push(null);
      continue;
    }
    const prev = words[i - 1];
    // Có cụm thiếu mốc chen giữa -> quãng tính ra là bịa, để null
    if (words[i].unit - prev.unit > 1) {
      gaps.push(null);
      continue;
    }
    gaps.push(Math.max(0, words[i].start - prev.end));
  }
  return { units, words, gaps, stats: computeStats(words, gaps) };
}

function gapBefore(ctx: Ctx, gi: number): number | null {
  return ctx.gaps[gi] ?? null;
}

function gapAfter(ctx: Ctx, gi: number): number | null {
  return gi + 1 < ctx.words.length ? (ctx.gaps[gi + 1] ?? null) : null;
}

/**
 * Ngữ cảnh cho người duyệt đọc. Cụm ngắn (từ đệm đứng một mình) thì bản thân
 * cụm KHÔNG nói lên gì - context "Hoặc là" thì duyệt kiểu gì? Nên với cụm ngắn
 * phải kèm cụm trước và cụm sau. Chính nhờ vậy mà người duyệt thấy ngay
 * "…ok ứng dụng nó … Hoặc là … Tham khảo để tìm cách…" là phép chọn lựa thật
 * chứ không phải câu bỏ dở.
 */
function unitContext(ctx: Ctx, index: number): string {
  const u = ctx.units[index];
  if (!u) return "";
  if (u.tokens.length > 5) return u.text;
  return [ctx.units[index - 1]?.text, u.text, ctx.units[index + 1]?.text]
    .filter((s): s is string => !!s)
    .join(" … ");
}

/** Tỉ lệ ngân dài của từ so với chính người nói; 1 = bình thường, 0 = không đo được */
function elongation(ctx: Ctx, w: PWord): number {
  if (!ctx.stats.dpcUsable) return 1;
  const letters = w.norm.replace(/\p{N}+/gu, "").length;
  const dur = w.end - w.start;
  if (letters <= 0 || dur <= 0) return 1;
  return dur / letters / ctx.stats.medianDpc;
}

interface RawCandidate {
  kind: DeadWeightKind;
  start: number;
  end: number;
  text: string;
  confidence: number;
  reason: string;
  context: string;
}

// ---------------------------------------------------------------------------
// 1. Từ đệm
// ---------------------------------------------------------------------------

/**
 * Chấm điểm một ứng viên từ đệm theo BAO NHIÊU tín hiệu cùng chỉ về một hướng.
 * Chỉ mặt chữ thôi thì không đủ - mọi từ đệm mềm đều phải có ít nhất một tín
 * hiệu ngữ cảnh, và điểm tăng dần theo số tín hiệu gom được.
 */
function scoreFiller(input: {
  base: number;
  standalone: boolean;
  breakBefore: boolean;
  breakAfter: boolean;
  gapBeforeSec: number;
  gapAfterSec: number;
  pauseSec: number;
  elongation: number;
  commaAfter: boolean;
  repeatedRightAfter: boolean;
}): { confidence: number; signals: string[] } {
  const signals: string[] = [];
  let c = input.base;
  if (input.standalone) {
    c += 0.28;
    signals.push("đứng một mình thành nguyên một cụm");
  } else if (input.breakBefore && input.breakAfter) {
    c += 0.2;
    signals.push("có ngắt cả trước lẫn sau");
  }
  if (input.gapBeforeSec >= input.pauseSec) {
    c += 0.08;
    signals.push(`im lặng ${fmtSec(input.gapBeforeSec)}s ngay trước`);
  }
  if (input.gapAfterSec >= input.pauseSec) {
    c += 0.08;
    signals.push(`im lặng ${fmtSec(input.gapAfterSec)}s ngay sau`);
  }
  if (input.elongation >= ELONGATION_STRONG) {
    c += 0.28;
    signals.push(`bị ngân dài gấp ${input.elongation.toFixed(1)} lần nhịp đọc thường của chính người nói`);
  } else if (input.elongation >= ELONGATION_MILD) {
    c += 0.18;
    signals.push(`dài gấp ${input.elongation.toFixed(1)} lần nhịp đọc thường của chính người nói`);
  }
  if (input.commaAfter) {
    c += 0.08;
    signals.push("có dấu phẩy ngay sau");
  }
  if (input.repeatedRightAfter) {
    c += 0.12;
    signals.push("nói lại ngay từ đó lần nữa");
  }
  return { confidence: clamp(c, 0, 0.97), signals };
}

function fillerCandidates(ctx: Ctx): RawCandidate[] {
  const out: RawCandidate[] = [];
  const { pauseSec } = ctx.stats;

  const push = (
    unit: PUnit,
    span: PWord[],
    base: number,
    label: string,
    opts: { standalone: boolean; commaAfter?: boolean; tail?: string },
  ): void => {
    const first = span[0];
    const last = span[span.length - 1];
    const gb = gapBefore(ctx, first.gi);
    const ga = gapAfter(ctx, last.gi);
    const breakBefore = first.posInUnit === 0 || (gb !== null && gb >= pauseSec);
    const breakAfter = last.posInUnit === unit.words.length - 1 || (ga !== null && ga >= pauseSec);
    const elong = Math.max(...span.map((w) => elongation(ctx, w)));
    const nextWord = ctx.words[last.gi + 1];
    const repeatedRightAfter = !!nextWord && nextWord.norm === first.norm;

    const { confidence, signals } = scoreFiller({
      base,
      standalone: opts.standalone,
      breakBefore,
      breakAfter,
      gapBeforeSec: gb ?? 0,
      gapAfterSec: ga ?? 0,
      pauseSec,
      elongation: elong,
      commaAfter: opts.commaAfter ?? false,
      repeatedRightAfter,
    });

    const text = span.map((w) => w.raw).join(" ");
    out.push({
      kind: "filler",
      start: first.start,
      end: last.end,
      text,
      confidence,
      reason: `${label}: ${signals.join("; ")}. ${opts.tail ?? "Bỏ đi câu vẫn đủ nghĩa."}`,
      context: unitContext(ctx, unit.index),
    });
  };

  for (const unit of ctx.units) {
    if (!unit.timed) continue;
    const joined = unit.tokens.join(" ");

    // (A) Cả cụm chỉ là một từ/cụm đệm. Đây là ca chắc chắn nhất và cũng là ca
    //     duy nhất được phép đụng tới từ đệm MỀM ("đó", "ấy", "thế"...).
    if (HARD_FILLERS.has(joined)) {
      push(unit, unit.words, 0.55, `"${unit.text}" là thán từ đệm`, { standalone: true });
      continue;
    }
    if (unit.words.length === 1 && SOFT_FILLERS.has(joined)) {
      // Chặn kép: nhỡ máy nhận dạng tách "cái | đó" thành hai cụm dính nhau thì
      // vẫn không được cắt. Chỉ chặn khi hai từ dính sát (không có ngắt thật).
      const gb = gapBefore(ctx, unit.words[0].gi);
      const prev = ctx.words[unit.words[0].gi - 1];
      if (prev && (gb === null || gb < 0.25) && REFERENT_BEFORE.has(prev.norm)) continue;
      push(unit, unit.words, 0.3, `"${unit.text}" đứng trơ một mình nên là tiếng đệm chốt câu, không phải chỉ định từ`, {
        standalone: true,
      });
      continue;
    }
    if (PHRASE_FILLERS.has(joined)) {
      push(unit, unit.words, 0.3, `"${unit.text}" là cụm đệm bỏ lửng, người nói đổi ý nói lại`, {
        standalone: true,
      });
      continue;
    }
    if (CONNECTOR_FILLERS.has(joined)) {
      push(
        unit,
        unit.words,
        0.15,
        `"${unit.text}" đứng trơ một mình, nhiều khả năng là câu bỏ dở`,
        {
          standalone: true,
          tail:
            `CẦN ĐỌC KỸ NGỮ CẢNH TRƯỚC KHI DUYỆT: cụm này cũng có thể đang nối hai vế thật ` +
            `(chọn lựa/nguyên nhân), cắt vào là mất hẳn một vế.`,
        },
      );
      continue;
    }

    // (B) Thán từ cứng nằm lẫn trong câu - vẫn cắt được nhưng phải có ngắt hoặc
    //     bị ngân dài, nếu không thì có thể là chữ thật ("à" trong "à ơi").
    for (const w of unit.words) {
      if (!HARD_FILLERS.has(w.norm)) continue;
      const gb = gapBefore(ctx, w.gi) ?? 0;
      const ga = gapAfter(ctx, w.gi) ?? 0;
      const elong = elongation(ctx, w);
      const hasBreak = gb >= pauseSec || ga >= pauseSec || elong >= ELONGATION_MILD;
      if (!hasBreak) continue;
      push(unit, [w], 0.45, `"${w.raw}" là thán từ đệm chen giữa câu`, { standalone: false });
    }

    // (C) "Đó," / "Đấy," mở đầu cụm rồi ngắt phẩy - tiếng chốt câu trước bị máy
    //     nhận dạng gắn sang cụm sau. Loại trừ "Đó là...", "Đó thì..." vì lúc đó
    //     nó là chủ ngữ thật.
    const first = unit.words[0];
    if (first && unit.words.length > 1 && SOFT_FILLERS.has(first.norm)) {
      const commaAfter = /[,;:]$/.test(first.raw.trim());
      const next = unit.words[1];
      if (commaAfter && !SUBJECT_AFTER.has(next.norm)) {
        push(unit, [first], 0.3, `"${first.raw}" mở đầu cụm rồi ngắt ngay, là tiếng chốt câu trước`, {
          standalone: false,
          commaAfter: true,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Vấp (stutter)
// ---------------------------------------------------------------------------

/**
 * Một chuỗi 1-3 từ bật ra hai lần LIỀN NHAU: "cái cái này", "thì thì",
 * "hôm nay hôm nay". Cắt lượt ĐẦU, giữ lượt sau vì lượt sau mới là lượt nói trót lọt.
 *
 * BA LUẬT ĐÃ PHẢI SIẾT LẠI SAU KHI ĐO TRÊN TRANSCRIPT THẬT - đừng nới ra:
 *
 * 1. CHỈ lặp LIỀN KỀ, không xét lặp cách 2 token. Bản đầu có xét cách 2 token và
 *    10/11 ứng viên sinh ra là cắt nhầm: "không retargeting, không remarketing"
 *    (điệp ngữ có chủ ý, cắt mất chữ "không" là đảo ngược nghĩa),
 *    "của mình để mình chạy", "có nghe có thể", "xem lại cái video nhé | Video này..."
 *    (cắt xong còn "xem lại cái nhé"). Trong tiếng Việt lặp cách quãng là nhịp
 *    văn nói bình thường, không phải vấp.
 *
 * 2. CHỈ khớp token y hệt, KHÔNG khớp tiền tố. Tiếng Việt đơn âm nên tiền tố của
 *    một tiếng gần như luôn là một tiếng khác có nghĩa: "là" là tiền tố của
 *    "làm", "có" của "cóc". Luật tiền tố đã đẻ ra ứng viên cắt "là" trong
 *    "Và mình thấy là | Nó làm việc..." - sai hẳn.
 *
 * 3. Lượt đầu mà kết thúc bằng dấu câu thì bỏ qua: "đến một lần, lần thứ hai nữa"
 *    là phép liệt kê, không phải vấp; cắt đi thành "đến một lần thứ hai nữa",
 *    đổi nghĩa.
 *
 * Từ láy đôi ("từ từ", "dần dần", "luôn luôn") lặp liền là ĐÚNG chính tả -> chặn
 * bằng REDUPLICATIONS.
 */
function stutterCandidates(ctx: Ctx): RawCandidate[] {
  const out: RawCandidate[] = [];
  const words = ctx.words;
  const taken = new Set<number>();
  for (let i = 0; i < words.length - 1; i++) {
    if (taken.has(i)) continue;
    // Ưu tiên chuỗi dài trước: "cái này cái này" là vấp cả cụm chứ không phải hai vấp lẻ
    for (let len = 3; len >= 1; len--) {
      const end2 = i + 2 * len;
      if (end2 > words.length) continue;
      const first = words.slice(i, i + len);
      const second = words.slice(i + len, end2);
      if (first.some((w) => !w.norm) || second.some((w) => !w.norm)) continue;
      if (!first.every((w, k) => w.norm === second[k].norm)) continue;
      // Chữ số lặp ("8 8") gần như luôn là số thật bị tách, không phải vấp
      if (first.every((w) => /^\p{N}+$/u.test(w.norm))) continue;
      if (len === 1 && REDUPLICATIONS.has(first[0].norm)) continue;
      // Dấu câu chen giữa hai lượt -> liệt kê/điệp ngữ, không phải vấp
      if (/[,;:.!?…]$/.test(first[len - 1].raw.trim())) continue;
      const gap = second[0].start - first[len - 1].end;
      if (gap > STUTTER_MAX_GAP_SEC) continue;

      const unit = ctx.units[first[0].unit];
      const firstText = first.map((w) => w.raw).join(" ");
      const secondText = second.map((w) => w.raw).join(" ");
      // Cắt tới sát chỗ lượt sau bắt đầu để nuốt luôn quãng lặng giữa hai lượt
      const cutEnd = Math.max(first[len - 1].end, second[0].start);
      if (cutEnd <= first[0].start) continue;
      // CHỈ đánh dấu lượt ĐẦU đã dùng, không đánh dấu lượt sau. Vấp ba lần
      // ("cái cái cái") phải sinh ra hai lệnh cắt liền kề chứ không phải một;
      // và quan trọng hơn: đánh dấu cả lượt sau sẽ nuốt mất ứng viên kế tiếp
      // (đã đo được ca "…Tự lên cái | Cái cái" làm mất hẳn vấp "Cái cái").
      for (let k = i; k < i + len; k++) taken.add(k);
      out.push({
        kind: "stutter",
        start: first[0].start,
        end: cutEnd,
        text: firstText,
        confidence: len >= 2 ? 0.82 : 0.78,
        reason:
          `Vấp: "${firstText}" bật ra hai lần liền nhau ("${firstText} ${secondText}") - ` +
          `cắt lượt đầu, giữ lượt sau.`,
        context: unitContext(ctx, first[0].unit),
      });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Nói lại (repeat take)
// ---------------------------------------------------------------------------

/**
 * Người nói bỏ dở một câu rồi nói lại đầy đủ hơn. Cắt lần TRƯỚC, giữ lần SAU.
 *
 * Cách nhận: cụm A và một cụm B đứng sau trong vòng 15 giây, B DÀI HƠN HOẶC BẰNG
 * A, và gần như trọn A nằm trong B theo đúng thứ tự (đo bằng LCS trên token đã
 * chuẩn hóa, không đòi khớp từng chữ vì máy nhận dạng hay đổi hư từ đầu câu:
 * "Là mình đang ở bên Đức" -> "Mình đang ở bên Đức rồi").
 *
 * Ràng buộc quan trọng nhất là SỐ CỤM CHEN GIỮA phải nhỏ (tối đa 2). Nói lại vì
 * hỏng thì nói lại NGAY; còn nhắc lại sau vài câu là nhấn mạnh có chủ ý ("...mình
 * không phô mô nhé" ... "Nội dung này không phô mô") - cắt vào là giết chủ ý của
 * người nói. Điều kiện B >= A về số token chặn ca cắt nhầm câu dài thành câu cụt.
 *
 * Ràng buộc thứ hai là NEO ĐẦU CÂU: chỗ trùng phải bắt đầu trong 2 token đầu của
 * B. Đã đo được ca cắt nhầm khi thiếu ràng buộc này: "Ai ứng dụng được thì tốt"
 * (câu hoàn chỉnh) trùng 83% với phần GIỮA của "Còn trường hợp mà người AI không
 * ứng dụng được ok thì...". Nói lại vì hỏng thì bao giờ cũng nói lại TỪ ĐẦU, nên
 * trùng ở giữa câu sau là trùng ngẫu nhiên chứ không phải nói lại.
 */
function repeatTakeCandidates(ctx: Ctx): RawCandidate[] {
  const out: RawCandidate[] = [];
  const units = ctx.units;
  for (let a = 0; a < units.length; a++) {
    const A = units[a];
    if (A.tokens.length < 2) continue;
    let best: { b: number; sim: number; prefix: boolean; skipped: number } | null = null;
    for (let b = a + 1; b <= a + 1 + REPEAT_MAX_INTERVENING_UNITS && b < units.length; b++) {
      const B = units[b];
      if (B.start - A.end > REPEAT_WINDOW_SEC) break;
      if (B.tokens.length < A.tokens.length) continue;
      const prefix = A.tokens.every((t, i) => B.tokens[i] === t);
      const m = lcsMatch(A.tokens, B.tokens);
      const sim = prefix ? 1 : m.len / A.tokens.length;
      if (sim < REPEAT_MIN_SIMILARITY) continue;
      // Neo đầu câu - xem ghi chú ở đầu hàm
      if (!prefix && m.firstB > REPEAT_ANCHOR_MAX_OFFSET) continue;
      // Cụm 2 token chỉ được tính khi lần sau lặp lại ĐÚNG y nguyên phần đầu
      if (A.tokens.length < 3 && !prefix) continue;
      if (!best || sim > best.sim) best = { b, sim, prefix, skipped: b - a - 1 };
    }
    if (!best) continue;

    const B = units[best.b];
    let confidence = 0.45;
    confidence += 0.35 * clamp((best.sim - REPEAT_MIN_SIMILARITY) / (1 - REPEAT_MIN_SIMILARITY), 0, 1);
    if (best.skipped === 0) confidence += 0.12;
    else if (best.skipped === 1) confidence += 0.06;
    if (best.prefix) confidence += 0.1;
    // Câu bỏ dở rất ngắn thì bằng chứng mỏng hơn - hạ điểm cho người duyệt cân nhắc
    if (A.tokens.length < 3) confidence -= 0.15;
    confidence = clamp(confidence, 0, 0.95);

    out.push({
      kind: "repeat-take",
      start: A.start,
      end: A.end,
      text: A.text,
      confidence,
      reason:
        `Nói lại: câu này được nói lại đầy đủ hơn sau ${fmtSec(B.start - A.end)}s thành "${B.text}" ` +
        `(trùng ${Math.round(best.sim * 100)}%${best.prefix ? ", lặp nguyên phần đầu" : ""}). ` +
        `Cắt lần nói hỏng ở đây, giữ lần sau.`,
      context: `${A.text} … ${B.text}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Chần chừ (hesitation)
// ---------------------------------------------------------------------------

/**
 * Quãng giữa hai từ dài bất thường. Khác với silencedetect ở chỗ: phòng thu
 * không thật sự im (tiếng thở, tiếng "ừ" tắt dần, tiếng bàn phím) nên ngưỡng dB
 * không bắt được, nhưng transcript thì thấy rõ là không có chữ nào.
 *
 * Ngưỡng lấy từ phân bố của CHÍNH người nói chứ không phải hằng số: p90 của các
 * quãng nghỉ DƯƠNG nhân 1,2 (tức "vượt hẳn mức nghỉ thường ngày của người này"),
 * và không bao giờ thấp hơn sàn 0,8s. Trên demo1: p90 = 1,00s -> ngưỡng 1,20s.
 *
 * Luôn chừa 0,12s mỗi đầu. Cắt sát mép từ là nuốt mất phụ âm đầu/cuối - lỗi này
 * nghe ra ngay còn khó sửa hơn là để thừa nửa giây.
 */
function hesitationCandidates(ctx: Ctx): RawCandidate[] {
  const out: RawCandidate[] = [];
  const th = ctx.stats.hesitationSec;
  for (let i = 1; i < ctx.words.length; i++) {
    const g = ctx.gaps[i];
    if (g === null || g < th) continue;
    const prev = ctx.words[i - 1];
    const next = ctx.words[i];
    const start = prev.end + HESITATION_PAD_SEC;
    const end = next.start - HESITATION_PAD_SEC;
    if (end - start < HESITATION_MIN_CUT_SEC) continue;
    const over = clamp((g - th) / th, 0, 1);
    const prevUnit = ctx.units[prev.unit];
    const nextUnit = ctx.units[next.unit];
    out.push({
      kind: "hesitation",
      start,
      end,
      text: `(im lặng ${fmtSec(g)}s)`,
      confidence: clamp(0.5 + 0.4 * over, 0, 0.9),
      reason:
        `Chần chừ: ngừng ${fmtSec(g)}s giữa "${prev.raw}" và "${next.raw}", vượt ngưỡng ` +
        `${fmtSec(th)}s tính từ chính nhịp nghỉ của người nói. Cắt phần giữa, chừa ` +
        `${fmtSec(HESITATION_PAD_SEC)}s mỗi đầu cho khỏi cụt tiếng.`,
      context:
        prevUnit && nextUnit && prevUnit !== nextUnit
          ? `${prevUnit.text} … ${nextUnit.text}`
          : (prevUnit?.text ?? ""),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gom báo cáo
// ---------------------------------------------------------------------------

function emptyByKind(): Record<DeadWeightKind, { count: number; sec: number }> {
  return {
    filler: { count: 0, sec: 0 },
    stutter: { count: 0, sec: 0 },
    "repeat-take": { count: 0, sec: 0 },
    hesitation: { count: 0, sec: 0 },
  };
}

function emptyReport(): DeadWeightReport {
  return { candidates: [], totalSec: 0, byKind: emptyByKind() };
}

/**
 * Tìm mỡ thừa trong transcript.
 *
 * Trả về danh sách ứng viên ĐÃ khử chồng lấn: hai ứng viên đè lên nhau thì giữ
 * cái tin cậy hơn. Lý do: danh sách này đi thẳng vào bước duyệt rồi thành lệnh
 * cắt, mà hai lệnh cắt chồng nhau vừa cộng sai thời lượng vừa dễ làm lệch
 * timestamp khi remap transcript sau khi cắt.
 *
 * KHÔNG BAO GIỜ throw: transcript hỏng, thiếu trường, sai kiểu đều trả báo cáo rỗng.
 */
export function findDeadWeight(
  transcript: unknown,
  opts?: {
    /** Chỉ trả ứng viên từ mức tin cậy này trở lên (mặc định 0.5) */
    minConfidence?: number;
  },
): DeadWeightReport {
  try {
    const minConfidence = clamp(
      typeof opts?.minConfidence === "number" && Number.isFinite(opts.minConfidence)
        ? opts.minConfidence
        : DEFAULT_MIN_CONFIDENCE,
      0,
      1,
    );

    const units = parseUnits(transcript);
    if (units.length === 0) return emptyReport();
    const ctx = buildCtx(units);

    const raw = [
      ...fillerCandidates(ctx),
      ...stutterCandidates(ctx),
      ...repeatTakeCandidates(ctx),
      ...hesitationCandidates(ctx),
    ].filter((c) => c.end > c.start && c.confidence >= minConfidence);

    // Khử chồng lấn: xét theo độ tin cậy giảm dần, ứng viên nào đè lên một ứng
    // viên đã chọn thì loại. Ưu tiên độ tin cậy chứ không ưu tiên thứ tự thời gian.
    const kept: RawCandidate[] = [];
    for (const c of [...raw].sort((a, b) => b.confidence - a.confidence || a.start - b.start)) {
      if (kept.some((k) => c.start < k.end && k.start < c.end)) continue;
      kept.push(c);
    }
    kept.sort((a, b) => a.start - b.start);

    const byKind = emptyByKind();
    const candidates: DeadWeightCandidate[] = kept.map((c) => {
      const start = round2(c.start);
      const end = round2(c.end);
      const sec = Math.max(0, end - start);
      byKind[c.kind].count += 1;
      byKind[c.kind].sec += sec;
      return {
        kind: c.kind,
        start,
        end,
        text: c.text,
        confidence: Math.round(c.confidence * 100) / 100,
        reason: c.reason,
        context: c.context,
      };
    });
    for (const k of KINDS) byKind[k].sec = round2(byKind[k].sec);

    return {
      candidates,
      totalSec: round2(candidates.reduce((s, c) => s + (c.end - c.start), 0)),
      byKind,
    };
  } catch {
    // Đầu vào là `unknown` - mọi bất ngờ đều thành báo cáo rỗng, không làm sập
    // job cắt chỉ vì một file transcript lạ.
    return emptyReport();
  }
}
