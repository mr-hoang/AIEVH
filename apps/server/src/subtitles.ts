import type { TranscriptSegment, TranscriptWord } from "./transcript.js";

/**
 * Sinh phụ đề (.srt/.vtt) từ transcript của project.
 *
 * Vì sao không dump thẳng mỗi segment thành một cue: faster-whisper hay trả
 * segment dài 10-15 giây, 150+ ký tự - dán nguyên lên màn hình thì người xem
 * đọc không kịp và chữ tràn khung. Ở đây segment dài bị chia nhỏ theo timestamp
 * TỪNG TỪ (chính xác nhất), chỉ khi transcript không có `words` mới fallback
 * chia theo dấu câu + chia đều thời lượng theo tỉ lệ ký tự.
 *
 * Nguyên tắc với tiếng Việt: mọi phép cắt đều rơi vào ranh giới TỪ (khoảng
 * trắng) hoặc ranh giới word timestamp - không bao giờ cắt giữa một từ, nên
 * không có chuyện mất/cụt dấu.
 */

export interface SubtitleCue {
  /** giây */
  start: number;
  /** giây */
  end: number;
  /** Text đã xuống dòng sẵn (tối đa 2 dòng, ngăn bằng "\n") */
  text: string;
}

export interface CueOptions {
  /** Số ký tự tối đa một dòng phụ đề */
  maxCharsPerLine?: number;
  /** Số dòng tối đa mỗi cue */
  maxLines?: number;
  /** Segment dài hơn ngần này (giây) thì phải chia nhỏ */
  maxDurationSec?: number;
  /** Cue ngắn hơn ngần này (giây) thì kéo dài end (không đè cue sau) */
  minDurationSec?: number;
}

const DEFAULTS = {
  maxCharsPerLine: 42,
  maxLines: 2,
  maxDurationSec: 7,
  minDurationSec: 0.8,
};

/** Đếm theo code point - transcript có thể ở dạng NFD nên .length không đáng tin */
function len(s: string): number {
  return Array.from(s).length;
}

/** trim + gộp mọi chuỗi khoảng trắng thành 1 - KHÔNG đụng tới ký tự có dấu */
function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Ghép token thành câu. faster-whisper trả token đã kèm khoảng trắng đầu
 * (" xin", " chào"); bản khác trả token trần - dò một lần rồi chọn cách nối,
 * nếu không sẽ dính chữ hoặc thừa khoảng trắng.
 */
function joinWords(words: TranscriptWord[]): string {
  const hasLeadingSpace = words.some((w) => /^\s/.test(w.word));
  return normText(words.map((w) => w.word).join(hasLeadingSpace ? "" : " "));
}

/** Cắt một đoạn quá dài tại khoảng trắng (greedy). Từ đơn dài hơn max thì giữ nguyên. */
function hardWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const token of text.split(" ")) {
    if (!token) continue;
    const next = cur ? `${cur} ${token}` : token;
    if (cur && len(next) > maxChars) {
      out.push(cur);
      cur = token;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Chia segment dựa trên word timestamp - mốc cue lấy từ từ đầu và từ cuối của nhóm */
function splitByWords(
  seg: TranscriptSegment,
  maxChars: number,
  maxDur: number,
): SubtitleCue[] {
  const groups: TranscriptWord[][] = [];
  let cur: TranscriptWord[] = [];
  for (const w of seg.words) {
    if (cur.length === 0) {
      cur = [w];
      continue;
    }
    const tooLong = len(joinWords([...cur, w])) > maxChars;
    // Chặn thêm theo thời lượng: nói chậm thì ít ký tự vẫn có thể chiếm 10 giây
    const tooLate = w.end - cur[0].start > maxDur;
    if (tooLong || tooLate) {
      groups.push(cur);
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  if (cur.length > 0) groups.push(cur);

  const cues: SubtitleCue[] = [];
  for (const g of groups) {
    const text = joinWords(g);
    if (!text) continue;
    cues.push({ start: g[0].start, end: Math.max(g[g.length - 1].end, g[0].start), text });
  }
  return cues;
}

/**
 * Không có word timestamp: chia theo dấu câu (. , ? ! ;) rồi gom lại cho tới
 * maxChars, thời lượng chia đều theo tỉ lệ số ký tự của từng phần.
 */
function splitByPunctuation(seg: TranscriptSegment, maxChars: number): SubtitleCue[] {
  const text = normText(seg.text);
  if (!text) return [];

  const pieces = text.split(/(?<=[.,?!;])\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (const p of pieces) {
    const last = chunks.length > 0 ? chunks[chunks.length - 1] : null;
    if (last !== null && len(`${last} ${p}`) <= maxChars) {
      chunks[chunks.length - 1] = `${last} ${p}`;
    } else if (len(p) <= maxChars) {
      chunks.push(p);
    } else {
      chunks.push(...hardWrap(p, maxChars));
    }
  }
  if (chunks.length === 0) return [];

  const totalChars = chunks.reduce((a, c) => a + len(c), 0) || 1;
  const span = Math.max(0, seg.end - seg.start);
  const cues: SubtitleCue[] = [];
  let t = seg.start;
  chunks.forEach((chunk, i) => {
    const isLast = i === chunks.length - 1;
    // Cue cuối lấy đúng seg.end để không lệch do làm tròn số thực
    const end = isLast ? Math.max(seg.end, t) : t + (span * len(chunk)) / totalChars;
    cues.push({ start: t, end, text: chunk });
    t = end;
  });
  return cues;
}

/** Xuống dòng tại khoảng trắng GẦN GIỮA nhất - hai dòng cân nhau, dễ đọc */
function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string {
  if (maxLines < 2 || len(text) <= maxCharsPerLine) return text;
  const chars = Array.from(text);
  const mid = Math.floor(chars.length / 2);
  let best = -1;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== " ") continue;
    if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  }
  if (best < 0) return text; // một từ duy nhất - thà để dài còn hơn cắt giữa từ
  return `${chars.slice(0, best).join("")}\n${chars.slice(best + 1).join("")}`;
}

/**
 * Transcript → danh sách cue đã chuẩn hóa (chia nhỏ, đủ thời lượng tối thiểu,
 * không chồng nhau, đã xuống dòng).
 */
export function segmentsToCues(
  segments: TranscriptSegment[],
  opts: CueOptions = {},
): SubtitleCue[] {
  const maxCharsPerLine = opts.maxCharsPerLine ?? DEFAULTS.maxCharsPerLine;
  const maxLines = opts.maxLines ?? DEFAULTS.maxLines;
  const maxDur = opts.maxDurationSec ?? DEFAULTS.maxDurationSec;
  const minDur = opts.minDurationSec ?? DEFAULTS.minDurationSec;
  const maxChars = maxCharsPerLine * Math.max(1, maxLines);

  const raw: SubtitleCue[] = [];
  for (const seg of segments) {
    const text = normText(seg.text);
    if (!text) continue;
    const tooLong = seg.end - seg.start > maxDur || len(text) > maxChars;
    if (!tooLong) {
      raw.push({ start: seg.start, end: Math.max(seg.end, seg.start), text });
      continue;
    }
    const split =
      seg.words.length > 0
        ? splitByWords(seg, maxChars, maxDur)
        : splitByPunctuation(seg, maxChars);
    // Chia hụt (segment lạ) thì thà giữ nguyên cue gốc còn hơn mất thoại
    if (split.length === 0) raw.push({ start: seg.start, end: Math.max(seg.end, seg.start), text });
    else raw.push(...split);
  }

  raw.sort((a, b) => a.start - b.start);

  // Kéo dài cue quá ngắn nhưng KHÔNG cho đè lên cue kế tiếp
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c.end - c.start >= minDur) continue;
    const nextStart = i + 1 < raw.length ? raw[i + 1].start : Number.POSITIVE_INFINITY;
    c.end = Math.max(c.start, Math.min(c.start + minDur, nextStart));
  }

  return raw.map((c) => ({
    start: c.start,
    end: c.end,
    text: wrapLines(c.text, maxCharsPerLine, maxLines),
  }));
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** SRT dùng dấu phẩy trước mili giây, VTT dùng dấu chấm */
function formatTime(sec: number, msSep: "," | "."): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms, 3)}`;
}

export function cuesToSrt(cues: SubtitleCue[]): string {
  const blocks = cues.map(
    (c, i) =>
      `${i + 1}\n${formatTime(c.start, ",")} --> ${formatTime(c.end, ",")}\n${c.text}\n`,
  );
  // join("\n") → giữa 2 block có đúng một dòng trống, file kết thúc bằng newline
  return blocks.join("\n");
}

export function cuesToVtt(cues: SubtitleCue[]): string {
  const blocks = cues.map(
    (c) => `${formatTime(c.start, ".")} --> ${formatTime(c.end, ".")}\n${c.text}\n`,
  );
  return `WEBVTT\n\n${blocks.join("\n")}`;
}
