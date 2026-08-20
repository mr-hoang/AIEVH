import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths, repoRoot } from "./config.js";
import { DUB_ORIGINAL_VOLUME_MAX, type DubVoiceAssignment } from "./dub.js";
import { DEFAULT_STT_PROVIDER, isSttProvider, type SttProvider } from "./stt.js";
import { DEFAULT_TTS_ENGINE, isTtsEngine, type TtsEngine } from "./ttsTypes.js";
import { HttpError, isKebabCase, nowIso } from "./util.js";

/**
 * Dịch video - phiên nhận một video, bóc lời, dịch, rồi ghép phụ đề (hoặc lồng
 * tiếng ở giai đoạn sau).
 *
 * HÌNH DẠNG GIỐNG TEXT TO VIDEO / AUTO CUT: đây là một phiên NGUỒN, không phải
 * Videos Project. Đĩa là nguồn sự thật: `translate-video/<id>/meta.json`, SQLite
 * chỉ giữ job của hàng đợi.
 *
 * Vì sao KHÔNG nhét vào Videos Project: ở đây không có gì để "dựng" cả - không
 * scene, không HyperFrames, không Style Design. Chỉ có đúng một video nguồn đi
 * qua ba bước tất định (bóc lời -> dịch -> ghép phụ đề). Trộn vào project sẽ bắt
 * trang project gánh thêm ba trạng thái chẳng liên quan gì tới việc dựng video.
 *
 * Vòng đời (job runner ghi trạng thái, route chỉ validate + đẩy job):
 *   draft -> (job step "transcribe") transcribing -> transcribed
 *         -> (POST /translate, đồng bộ)  translating -> translated
 *         -> (job step "render")         rendering   -> done
 */

// ------------------------------------------------------------------ Kiểu dữ liệu

/**
 * "subtitle" = ghép phụ đề dịch (giữ nguyên tiếng gốc, đốt chữ lên hình);
 * "dub"      = lồng tiếng (thay tiếng gốc bằng giọng đọc bản dịch, không đốt chữ);
 * "both"     = vừa lồng tiếng vừa đốt phụ đề, và HAI BÊN CHỌN NGÔN NGỮ RIÊNG.
 *
 * Vì sao "both" đáng có chứ không phải bật hai công tắc: nghe tiếng này mà đọc
 * chữ tiếng kia là nhu cầu thật (video tiếng Anh, lồng tiếng Việt cho người nhà
 * xem, phụ đề tiếng Anh giữ nguyên để học). Ba chế độ dùng CHUNG bước bóc lời,
 * khác nhau ở bước dịch (mấy bản dịch) và bước render (đốt chữ / thay tiếng).
 */
export type TranslateMode = "subtitle" | "dub" | "both";
export const TRANSLATE_MODES: TranslateMode[] = ["subtitle", "dub", "both"];

/** Chế độ này có đốt phụ đề lên hình không */
export function wantsSubtitle(mode: TranslateMode): boolean {
  return mode === "subtitle" || mode === "both";
}

/** Chế độ này có dựng track lồng tiếng không */
export function wantsDub(mode: TranslateMode): boolean {
  return mode === "dub" || mode === "both";
}

export type TranslateStatus =
  | "draft"
  | "transcribing"
  | "transcribed"
  | "translating"
  | "translated"
  | "rendering"
  | "done"
  | "failed";

/** Nền chữ phụ đề: mờ nền phía sau, khối đặc, hoặc không có gì */
export type SubtitleBackdrop = "blur" | "solid" | "none";
export const SUBTITLE_BACKDROPS: SubtitleBackdrop[] = ["blur", "solid", "none"];

/**
 * Font phụ đề là một ID TRONG DANH SÁCH CHO PHÉP, không phải tên family tự do.
 *
 * VÌ SAO: chữ vẽ trong DOM của Remotion chỉ dùng được font đã đăng ký sẵn
 * (@font-face từ public/, hoặc font hệ thống có trên MÁY RENDER). Gõ một family
 * lạ thì trình duyệt IM LẶNG rơi về font mặc định - và thứ hỏng đầu tiên khi rơi
 * font là DẤU TIẾNG VIỆT (ề, ỡ, ậ mất dấu hoặc lệch vị trí), mà lỗi đó chỉ lộ ra
 * sau khi render xong cả video. Chặn ở tầng validate rẻ hơn nhiều.
 *
 * ID PHẢI TRÙNG bảng font của bên render (SUBTITLE_FONTS trong
 * engines/remotion/src/components/SubtitleTrack.tsx): id lạ ở đó rơi về font
 * mặc định một cách im lặng, tức là lựa chọn của người dùng bị nuốt mất mà
 * không ai báo. `cssStack` chỉ để UI hiện đúng bản xem trước - server không vẽ chữ.
 *
 * Mọi stack bên render đều KẾT bằng font tiếng Việt đóng gói sẵn (Inter subset
 * vietnamese, xem components/vietnameseFont.ts), nên chữ có dấu luôn đúng kể cả
 * khi font đứng trước thiếu glyph.
 */
export interface SubtitleFontOption {
  id: string;
  label: string;
  cssStack: string;
}

export const SUBTITLE_FONTS: SubtitleFontOption[] = [
  {
    id: "vietnamese",
    label: "Inter tiếng Việt (mặc định)",
    cssStack: "'CaptionInter', 'Segoe UI', sans-serif",
  },
  { id: "sans", label: "Arial / Helvetica", cssStack: "Arial, Helvetica, sans-serif" },
  {
    id: "serif",
    label: "Georgia / Times New Roman",
    cssStack: "Georgia, 'Times New Roman', serif",
  },
  { id: "mono", label: "Courier New / Consolas", cssStack: "'Courier New', Consolas, monospace" },
];

export const DEFAULT_SUBTITLE_FONT = "vietnamese";

export function isSubtitleFont(v: unknown): v is string {
  return typeof v === "string" && SUBTITLE_FONTS.some((f) => f.id === v);
}

/**
 * Kiểu chữ phụ đề. Mọi số đo tính theo KHUNG CHUẨN 1080x1920 - bên render tự
 * nhân theo kích thước thật của video nguồn. Một nguồn sự thật duy nhất, không
 * phải lưu hai bộ số cho video dọc và video ngang.
 */
export interface SubtitleStyle {
  /** id trong SUBTITLE_FONTS - KHÔNG phải tên family tự do (xem ghi chú trên) */
  fontFamily: string;
  fontSizePx: number;
  /** #rrggbb */
  color: string;
  backdrop: SubtitleBackdrop;
  /** Màu nền chữ - rgba() hoặc hex; chỉ có nghĩa khi backdrop != "none" */
  backdropColor: string;
  blurPx: number;
  /** Khoảng cách từ mép dưới khung */
  bottomPx: number;
}

/**
 * Khoảng cách mép dưới MẶC ĐỊNH - khác nhau theo hướng khung vì đơn vị tỉ lệ
 * của bên render cũng khác: video dọc chuẩn hóa theo cao 1920, video ngang theo
 * cao 1080 (xem SubtitleTrack.tsx). Nhét một con số cho cả hai là phụ đề của
 * video ngang bị đẩy lên gần giữa khung.
 *  - 320 (dọc): nằm trên vùng nút của TikTok/Reels (~288)
 *  - 130 (ngang): chuẩn của skill noti-youtube-edit
 */
export const DEFAULT_BOTTOM_PX = { vertical: 320, horizontal: 130 } as const;

export function defaultBottomPx(vertical: boolean): number {
  return vertical ? DEFAULT_BOTTOM_PX.vertical : DEFAULT_BOTTOM_PX.horizontal;
}

/** Giá trị này có phải MẶC ĐỊNH không (dùng để đổi theo hướng khung, xem route /source) */
export function isDefaultBottomPx(v: number): boolean {
  return v === DEFAULT_BOTTOM_PX.vertical || v === DEFAULT_BOTTOM_PX.horizontal;
}

/**
 * Mặc định TRÙNG KHỚP hằng số đang chạy của SubtitleTrack (và CaptionTrack):
 * "mặc định" phải là một thứ duy nhất ở cả hai đầu, nếu không thì bật/tắt việc
 * gửi subtitleStyle lại ra hai kiểu chữ khác nhau.
 */
export function defaultSubtitleStyle(): SubtitleStyle {
  return {
    fontFamily: DEFAULT_SUBTITLE_FONT,
    fontSizePx: 62,
    color: "rgba(255,255,255,0.92)",
    backdrop: "blur",
    backdropColor: "rgba(10,16,32,0.52)",
    blurPx: 20,
    bottomPx: DEFAULT_BOTTOM_PX.vertical,
  };
}

/** Một câu phụ đề đã dịch. `start`/`end` là GIÂY trong video NGUỒN. */
export interface TranslatedCue {
  start: number;
  end: number;
  /**
   * Bản dịch sang `targetLang` - chữ ĐỌC LÊN MÀN HÌNH. Đã xuống dòng sẵn bằng
   * "\n" (tối đa 2 dòng - xem segmentsToCues).
   */
  text: string;
  /**
   * Bản dịch sang `dubLang` - chữ ĐỌC THÀNH TIẾNG, chỉ có khi ngôn ngữ lồng
   * tiếng KHÁC ngôn ngữ phụ đề (mode "both"). Thiếu thì bước lồng tiếng đọc
   * `text` - đúng hành vi của mọi phiên có trước tính năng hai ngôn ngữ.
   */
  dubText?: string;
  /** Câu gốc, giữ lại để người dùng đối chiếu và để dịch lại không mất nguồn */
  original?: string;
  /** Nhãn người nói - giai đoạn 2 (lồng tiếng), chưa dùng ở đường phụ đề */
  speaker?: string;
}

/**
 * Kết quả bóc lời của LẦN CHẠY GẦN NHẤT - khác `sttProvider` (là LỰA CHỌN của
 * người dùng cho lần chạy TIẾP THEO). Hai thứ này phải tách nhau: người dùng đổi
 * lựa chọn sang Soniox nhưng chưa bấm bóc lời lại thì transcript đang có vẫn là
 * của whisper, UI phải nói đúng thứ đang có trên đĩa.
 *
 * null = chưa bóc lời lần nào (hoặc transcript có từ trước khi có tính năng này).
 */
export interface TranscriptInfo {
  /** Provider ĐÃ THỰC SỰ chạy ra transcript đang nằm trên đĩa */
  provider: SttProvider;
  /** Ngôn ngữ provider NHẬN RA được */
  language: string;
  /** Có nhãn người nói không - bước lồng tiếng cần biết để gán giọng nam/nữ */
  diarized: boolean;
  /** Các nhãn người nói tìm thấy ("1","2" của Soniox; "A","B" của Gemini) */
  speakers: string[];
  /** Có mốc thời gian từng TỪ không (Gemini thì không - phụ đề chia theo dấu câu) */
  wordTimestamps: boolean;
}

/**
 * Cấu hình LỒNG TIẾNG của phiên (chỉ có nghĩa khi mode = "dub").
 *
 * Vì sao giọng của từng người nói nằm ở ĐÂY chứ không tính lại mỗi lần chạy:
 * gán tự động chỉ là ĐỀ XUẤT (đo cao độ giọng gốc rồi chọn giọng cùng giới tính),
 * còn người dùng phải sửa được - và đã sửa thì lần render sau phải giữ nguyên,
 * nếu không thì mỗi lần chạy lại là một video khác giọng.
 */
export interface DubSettings {
  engine: TtsEngine;
  /** Model TTS (chỉ Gemini) - null = model mặc định của hệ thống */
  model: string | null;
  /**
   * Mã ngôn ngữ đọc, vd "vi-VN". null = tự suy từ `targetLang` (xem
   * ttsLanguageFor ở dub.ts) - mặc định đúng cho mọi phiên, khỏi phải chọn tay.
   */
  language: string | null;
  /**
   * Người nói -> tên giọng. Khóa "" nghĩa là "mọi câu" (transcript không phân
   * vai). Rỗng = chưa gán, bước render sẽ tự gán rồi ghi ngược lại vào đây.
   */
  voices: Record<string, string>;
  /** Còn nghe được tiếng gốc chạy nhỏ bên dưới giọng lồng không */
  keepOriginal: boolean;
  /** Âm lượng tiếng gốc khi keepOriginal (0..0.15 - xem mixOriginalUnder) */
  originalVolume: number;
}

/**
 * Kết quả lồng tiếng của LẦN CHẠY GẦN NHẤT - khác `dub` (là LỰA CHỌN cho lần
 * chạy tiếp theo), đúng cách `transcriptInfo` khác `sttProvider`.
 *
 * `stretched`/`overflowed`/tempo là thứ người dùng nhìn vào để biết bản lồng
 * tiếng có ổn không TRƯỚC KHI ngồi xem hết video: nhiều câu tràn nghĩa là bản
 * dịch dài quá so với lời gốc, phải rút gọn chữ chứ không phải chỉnh máy móc.
 */
export interface DubInfo {
  /** Track lồng tiếng đã ghép (đường dẫn tương đối repo) */
  file: string;
  durationSec: number;
  cues: number;
  /** Số câu phải co giãn (tempo != 1) */
  stretched: number;
  /** Số câu tràn sang mốc câu KẾ TIẾP dù đã co hết mức */
  overflowed: number;
  /** Số câu bị kẹp ở trần co (tràn qua mốc kết thúc của chính nó) */
  clipped: number;
  minTempo: number;
  maxTempo: number;
  /** Giọng ĐÃ dùng thật cho lần chạy này */
  assignments: DubVoiceAssignment[];
  /** Cao độ đo được của từng người nói trong video gốc (Hz) - căn cứ gán giọng */
  speakerF0: Record<string, number>;
  /**
   * Vân tay của đầu vào đã sinh ra track này (xem dubSignature). Khớp thì lần
   * render sau DÙNG LẠI file cũ - đọc lại cả bài bằng Gemini là tốn tiền thật,
   * không được phép tính phí người dùng chỉ vì họ bấm render lần hai.
   */
  signature: string;
  createdAt: string;
}

export interface TranslateVideoSource {
  /** Đường dẫn tương đối repo tới file nguồn - null = chưa upload */
  relPath: string | null;
  durationSec: number | null;
  /** Kích thước SAU KHI giải mã (đã áp cờ xoay - xem probeVideo ở reframe.ts) */
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface TranslateVideoMeta {
  id: string;
  name: string;
  /** true = tên do server tự đặt tạm; bước upload nguồn thay bằng tên file thật */
  autoNamed: boolean;
  source: TranslateVideoSource;
  /** "auto" hoặc mã ngôn ngữ whisper ("vi", "en", "ja"...) */
  sourceLang: string;
  /** Mã ngôn ngữ đích ("vi" | "en" | ...) - ngôn ngữ của PHỤ ĐỀ (`cue.text`) */
  targetLang: string;
  /**
   * Ngôn ngữ LỒNG TIẾNG khi khác phụ đề. null = đọc đúng ngôn ngữ phụ đề.
   *
   * Vì sao null chứ không chép sẵn `targetLang` vào: chép sẵn thì đổi ngôn ngữ
   * phụ đề xong ngôn ngữ đọc vẫn đứng im ở giá trị cũ mà không ai nhận ra, và
   * mọi phiên cũ (chưa có field này) sẽ phải đoán xem "bằng nhau" là cố ý hay
   * chỉ là giá trị mặc định.
   */
  dubLang: string | null;
  mode: TranslateMode;
  /**
   * AI nào bóc lời cho lần chạy TIẾP THEO. Mặc định "local" (faster-whisper trên
   * máy) - giữ nguyên hành vi cũ cho mọi phiên đã có. Provider nào dùng được
   * trên máy này thì hỏi `sttCapabilities()` (GET /api/translate-video/stt-providers).
   */
  sttProvider: SttProvider;
  /** Transcript GỐC (đường dẫn tương đối repo) - do provider ở `transcriptInfo` bóc */
  transcriptFile: string | null;
  /** Provider nào đã thực sự chạy + có phân vai người nói không - xem TranscriptInfo */
  transcriptInfo: TranscriptInfo | null;
  /** Bản dịch - sửa tay được trên UI qua PATCH */
  cues: TranslatedCue[];
  subtitleStyle: SubtitleStyle;
  /** Lựa chọn lồng tiếng cho lần chạy TIẾP THEO (chỉ dùng khi mode = "dub") */
  dub: DubSettings;
  /** Track lồng tiếng ĐÃ dựng + số liệu chất lượng; null = chưa lồng tiếng lần nào */
  dubInfo: DubInfo | null;
  /** Video đã ghép phụ đề / đã lồng tiếng (đường dẫn tương đối repo) */
  outputFile: string | null;
  status: TranslateStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ Đường dẫn

export function translateVideoDirOf(id: string): string {
  return path.join(paths.translateVideoDir, id);
}

export function translateVideoMetaPathOf(id: string): string {
  return path.join(translateVideoDirOf(id), "meta.json");
}

export function translateVideoExists(id: string): boolean {
  return isKebabCase(id) && fs.existsSync(translateVideoMetaPathOf(id));
}

/** transcript.json của phiên - whisper ghi ra đây, bước dịch đọc lại từ đây */
export function transcriptPathOf(id: string): string {
  return path.join(translateVideoDirOf(id), "transcript.json");
}

/** File video đã ghép phụ đề / đã lồng tiếng */
export function outputPathOf(id: string): string {
  return path.join(translateVideoDirOf(id), "output.mp4");
}

/**
 * Thư mục làm việc của bước lồng tiếng: cue-XXX.wav của từng câu + track ghép.
 * Giữ lại từng câu chứ không xóa: hỏng chỗ nào thì nghe đúng câu đó là ra ngay,
 * và trộn lại track không phải đọc lại (mà đọc lại là tốn tiền).
 */
export function dubDirOf(id: string): string {
  return path.join(translateVideoDirOf(id), "dub");
}

/** Track lồng tiếng đã ghép - dài đúng bằng video nguồn */
export function dubWavPathOf(id: string): string {
  return path.join(dubDirOf(id), "dub.wav");
}

/** Track lồng tiếng ĐÃ trộn tiếng gốc chạy nhỏ bên dưới (khi keepOriginal) */
export function dubMixPathOf(id: string): string {
  return path.join(dubDirOf(id), "dub-mix.wav");
}

/**
 * Đường dẫn tuyệt đối của video nguồn. Ném lỗi rõ ràng nếu chưa upload hoặc
 * file đã bị xóa - job và route đều cần đúng một thông báo này.
 */
export function sourceAbsOf(meta: TranslateVideoMeta): string {
  if (!meta.source.relPath) {
    throw new HttpError(
      400,
      "NO_SOURCE",
      `Phiên "${meta.id}" chưa có video nguồn - upload file trước.`,
    );
  }
  const abs = path.join(repoRoot, meta.source.relPath);
  if (!fs.existsSync(abs)) {
    throw new HttpError(
      404,
      "SOURCE_NOT_FOUND",
      `Không thấy video nguồn "${meta.source.relPath}" - file đã bị xóa hoặc di chuyển khỏi repo.`,
    );
  }
  return abs;
}

// ------------------------------------------------------------------ Chuẩn hóa

function posNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Mã ngôn ngữ: chữ cái/số/gạch ngang, tối đa 16 ký tự (né chuỗi rác từ client) */
const LANG_RE = /^[A-Za-z0-9-]{2,16}$/;

export function normLang(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim();
  if (!v) return fallback;
  // Whisper nhận mã thường; "vi-VN" cũng chấp nhận để UI khỏi phải biết luật
  return LANG_RE.test(v) ? v.toLowerCase() : fallback;
}

/** Màu: #rgb/#rrggbb/#rrggbbaa hoặc rgb()/rgba() - chặn chuỗi lọt thẳng vào CSS */
const COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/;

function normColor(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim();
  return COLOR_RE.test(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function numInRange(raw: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.round(clamp(raw, lo, hi) * 100) / 100;
}

/**
 * Kiểu chữ phụ đề đã kiểm - field nào sai/thiếu thì giữ giá trị cũ (fallback),
 * không bao giờ ném lỗi: đây là thứ hiển thị, sai một con số không đáng làm hỏng
 * cả phiên. Riêng `fontFamily` sai thì rơi về font mặc định (xem SUBTITLE_FONTS).
 */
export function normSubtitleStyle(raw: unknown, fallback: SubtitleStyle): SubtitleStyle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const o = raw as Record<string, unknown>;
  return {
    fontFamily: isSubtitleFont(o.fontFamily) ? o.fontFamily : fallback.fontFamily,
    // Dưới 16px là không đọc nổi, trên 200px thì một câu chiếm nửa khung
    fontSizePx: numInRange(o.fontSizePx, 16, 200, fallback.fontSizePx),
    color: normColor(o.color, fallback.color),
    backdrop: SUBTITLE_BACKDROPS.includes(o.backdrop as SubtitleBackdrop)
      ? (o.backdrop as SubtitleBackdrop)
      : fallback.backdrop,
    backdropColor: normColor(o.backdropColor, fallback.backdropColor),
    blurPx: numInRange(o.blurPx, 0, 80, fallback.blurPx),
    bottomPx: numInRange(o.bottomPx, 0, 1600, fallback.bottomPx),
  };
}

/** Bỏ \r (file .srt dán từ Windows) nhưng GIỮ \n - cue đã xuống dòng sẵn */
function normCueText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();
}

/**
 * Danh sách cue đã kiểm: bỏ cue không có chữ hoặc mốc thời gian vô nghĩa, sắp
 * xếp theo thời gian. Cue hỏng bị BỎ chứ không ném lỗi cả mảng - người dùng sửa
 * tay trên UI, một dòng lỗi không được chặn 200 dòng đúng.
 */
export function normCues(raw: unknown): TranslatedCue[] {
  if (!Array.isArray(raw)) return [];
  const out: TranslatedCue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const start = typeof o.start === "number" && Number.isFinite(o.start) ? Math.max(0, o.start) : null;
    const end = typeof o.end === "number" && Number.isFinite(o.end) ? Math.max(0, o.end) : null;
    const text = normCueText(o.text);
    if (start === null || end === null || end <= start || !text) continue;
    const cue: TranslatedCue = {
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text,
    };
    const dubText = normCueText(o.dubText);
    if (dubText) cue.dubText = dubText;
    const original = normCueText(o.original);
    if (original) cue.original = original;
    if (typeof o.speaker === "string" && o.speaker.trim()) cue.speaker = o.speaker.trim();
    out.push(cue);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Ngôn ngữ THỰC SỰ dùng để đọc thành tiếng - `dubLang` nếu có, không thì đúng
 * ngôn ngữ phụ đề. Mọi nơi cần "đọc bằng tiếng gì" phải đi qua đây, đừng đọc
 * thẳng `meta.dubLang` (null nghĩa là "giống phụ đề", không phải "chưa có").
 */
export function effectiveDubLang(meta: TranslateVideoMeta): string {
  return meta.dubLang ?? meta.targetLang;
}

/** Phụ đề và lồng tiếng có đang dùng hai ngôn ngữ khác nhau không */
export function dubLangDiffers(meta: TranslateVideoMeta): boolean {
  return effectiveDubLang(meta) !== meta.targetLang;
}

/**
 * Câu để ĐỌC THÀNH TIẾNG: lấy `dubText` khi có, không thì `text`.
 *
 * Trả về đúng shape TranslatedCue để dùng lại nguyên các hàm sẵn có (synthesizeDub,
 * dubSignature, fitCue) mà không phải dạy chúng biết về hai ngôn ngữ - bước lồng
 * tiếng chỉ cần "chữ nào đọc", không cần biết chữ ấy từ đâu ra.
 */
export function dubCuesOf(meta: TranslateVideoMeta): TranslatedCue[] {
  return meta.cues.map((c) => (c.dubText ? { ...c, text: c.dubText } : c));
}

/**
 * Kết quả bóc lời đọc từ đĩa. Field nào sai kiểu thì lùi về giá trị an toàn chứ
 * KHÔNG ném lỗi - đây là thông tin hiển thị, không đáng làm hỏng cả phiên.
 * Provider lạ (file cũ, hoặc provider đã bị gỡ) -> coi như chưa có thông tin.
 */
export function normTranscriptInfo(raw: unknown): TranscriptInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isSttProvider(o.provider)) return null;
  const speakers = Array.isArray(o.speakers)
    ? o.speakers.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  return {
    provider: o.provider,
    language: typeof o.language === "string" && o.language.trim() ? o.language.trim() : "und",
    diarized: o.diarized === true,
    speakers,
    wordTimestamps: o.wordTimestamps === true,
  };
}

/** Provider bóc lời hợp lệ; giá trị lạ -> fallback (không ném lỗi khi ĐỌC đĩa) */
export function normSttProvider(raw: unknown, fallback: SttProvider): SttProvider {
  return isSttProvider(raw) ? raw : fallback;
}

/**
 * Tên giọng hợp lệ: chặn ký tự đường dẫn và độ dài, KHÔNG ép về ASCII.
 * Giọng Gemini là tên Latin không dấu, nhưng giọng offline có thể là tên tiếng
 * Việt CÓ DẤU ("Minh Đức") hoặc id kebab của giọng nhân bản - ép ASCII là loại
 * mất nửa số giọng dùng được (xem cùng luật ở routes/tts.ts).
 */
export function isDubVoiceName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 80 && !/[\\/\r\n\0]/.test(v);
}

/**
 * Âm lượng tiếng gốc chạy nền. Trần lấy THẲNG từ dub.ts chứ không chép lại số:
 * đó là một hằng số AN TOÀN (chống rè), mà hằng số an toàn có hai bản sao thì
 * sớm muộn cũng có một bản bị nới ra mà bên kia không biết.
 */
export { DUB_ORIGINAL_VOLUME_MAX };
export const DEFAULT_DUB_ORIGINAL_VOLUME = 0.1;

export function defaultDubSettings(): DubSettings {
  return {
    engine: DEFAULT_TTS_ENGINE,
    model: null,
    // null = suy từ targetLang: người dùng đã chọn dịch sang tiếng gì thì đọc
    // bằng tiếng đó, bắt chọn lần nữa chỉ tổ thêm một chỗ để chọn sai
    language: null,
    voices: {},
    // Mặc định TẮT: lồng tiếng là để THAY tiếng gốc. Bật sẵn thì mọi video đều
    // nghe lùng bùng hai lớp tiếng, mà đó là thứ chỉ một số video cần.
    keepOriginal: false,
    originalVolume: DEFAULT_DUB_ORIGINAL_VOLUME,
  };
}

/**
 * Cấu hình lồng tiếng đã kiểm - field sai/thiếu thì giữ giá trị cũ, KHÔNG ném
 * lỗi (đây là lựa chọn hiển thị, không đáng làm hỏng cả phiên khi đọc đĩa).
 * Riêng tên giọng sai định dạng thì BỎ hẳn khỏi map thay vì giữ rác: giữ lại
 * chỉ để bước tổng hợp chết ở giữa chừng với một thông báo khó hiểu hơn.
 */
export function normDubSettings(raw: unknown, fallback: DubSettings): DubSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const o = raw as Record<string, unknown>;

  let voices = fallback.voices;
  if (o.voices && typeof o.voices === "object" && !Array.isArray(o.voices)) {
    voices = {};
    for (const [k, v] of Object.entries(o.voices as Record<string, unknown>)) {
      // Khóa "" là hợp lệ CÓ CHỦ Ý: nghĩa là "một giọng cho cả video"
      if (typeof k !== "string" || k.length > 80) continue;
      if (isDubVoiceName(v)) voices[k] = v.trim();
    }
  }

  return {
    engine: isTtsEngine(o.engine) ? o.engine : fallback.engine,
    model:
      typeof o.model === "string" && o.model.trim()
        ? o.model.trim().slice(0, 80)
        : o.model === null
          ? null
          : fallback.model,
    language:
      typeof o.language === "string" && LANG_RE.test(o.language.trim())
        ? o.language.trim()
        : o.language === null
          ? null
          : fallback.language,
    voices,
    keepOriginal: typeof o.keepOriginal === "boolean" ? o.keepOriginal : fallback.keepOriginal,
    originalVolume: numInRange(
      o.originalVolume,
      0,
      DUB_ORIGINAL_VOLUME_MAX,
      fallback.originalVolume,
    ),
  };
}

/** Kết quả lồng tiếng đọc từ đĩa - thiếu field cốt lõi thì coi như chưa có */
export function normDubInfo(raw: unknown): DubInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.file !== "string" || !o.file) return null;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const assignments: DubVoiceAssignment[] = [];
  if (Array.isArray(o.assignments)) {
    for (const a of o.assignments) {
      if (!a || typeof a !== "object") continue;
      const x = a as Record<string, unknown>;
      if (typeof x.speaker !== "string" || !isDubVoiceName(x.voice)) continue;
      assignments.push({
        speaker: x.speaker,
        voice: x.voice.trim(),
        engine: isTtsEngine(x.engine) ? x.engine : DEFAULT_TTS_ENGINE,
      });
    }
  }
  const speakerF0: Record<string, number> = {};
  if (o.speakerF0 && typeof o.speakerF0 === "object" && !Array.isArray(o.speakerF0)) {
    for (const [k, v] of Object.entries(o.speakerF0 as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) speakerF0[k] = v;
    }
  }
  return {
    file: o.file,
    durationSec: num(o.durationSec),
    cues: num(o.cues),
    stretched: num(o.stretched),
    overflowed: num(o.overflowed),
    clipped: num(o.clipped),
    minTempo: num(o.minTempo) || 1,
    maxTempo: num(o.maxTempo) || 1,
    assignments,
    speakerF0,
    signature: typeof o.signature === "string" ? o.signature : "",
    createdAt: typeof o.createdAt === "string" ? o.createdAt : nowIso(),
  };
}

/**
 * Vân tay của đầu vào lồng tiếng: đổi một chữ trong bản dịch, đổi mốc thời gian,
 * đổi giọng/engine/model/ngôn ngữ -> đổi vân tay -> phải đọc lại.
 *
 * KHÔNG tính `keepOriginal`/`originalVolume` vào: hai thứ đó chỉ ảnh hưởng khâu
 * TRỘN cuối, không ảnh hưởng tiếng đọc ra. Tính vào là người dùng gạt thử một
 * công tắc rồi phải trả tiền đọc lại cả bài - đó là cách chắc chắn nhất để
 * người ta không dám thử gì nữa.
 */
export function dubSignature(input: {
  cues: TranslatedCue[];
  assignments: DubVoiceAssignment[];
  engine: TtsEngine;
  model: string | null;
  language: string;
}): string {
  const h = crypto.createHash("sha1");
  h.update(`${input.engine}|${input.model ?? ""}|${input.language}\n`);
  for (const a of [...input.assignments].sort((x, y) => x.speaker.localeCompare(y.speaker))) {
    h.update(`v:${a.speaker}=${a.engine}:${a.voice}\n`);
  }
  for (const c of input.cues) {
    h.update(`c:${c.start}-${c.end}|${c.speaker ?? ""}|${c.text}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------ Đọc/ghi

export function defaultTranslateVideoMeta(id: string, name: string): TranslateVideoMeta {
  const now = nowIso();
  return {
    id,
    name,
    autoNamed: false,
    source: { relPath: null, durationSec: null, width: null, height: null, fps: null },
    sourceLang: "auto",
    targetLang: "vi",
    // null = đọc đúng ngôn ngữ phụ đề; chỉ mode "both" mới đặt khác đi
    dubLang: null,
    mode: "subtitle",
    // Mặc định = hành vi cũ: bóc lời trên máy, không tốn tiền, không cần mạng
    sttProvider: DEFAULT_STT_PROVIDER,
    transcriptFile: null,
    transcriptInfo: null,
    cues: [],
    subtitleStyle: defaultSubtitleStyle(),
    dub: defaultDubSettings(),
    dubInfo: null,
    outputFile: null,
    status: "draft",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

const TRANSLATE_STATUSES: TranslateStatus[] = [
  "draft",
  "transcribing",
  "transcribed",
  "translating",
  "translated",
  "rendering",
  "done",
  "failed",
];

/** Đọc meta từ đĩa, vá field thiếu bằng mặc định (file trên đĩa không tin kiểu) */
export function readTranslateVideo(id: string): TranslateVideoMeta {
  if (!isKebabCase(id)) {
    throw new HttpError(400, "INVALID_ID", `Id phiên dịch không hợp lệ: ${id}`);
  }
  const file = translateVideoMetaPathOf(id);
  if (!fs.existsSync(file)) {
    throw new HttpError(404, "NOT_FOUND", `Không tìm thấy phiên dịch "${id}"`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(500, "META_INVALID", `meta.json của phiên dịch "${id}" hỏng`);
  }

  const base = defaultTranslateVideoMeta(id, typeof raw.name === "string" ? raw.name : id);
  const src = (raw.source ?? {}) as Record<string, unknown>;
  const status = raw.status;

  return {
    ...base,
    autoNamed: raw.autoNamed === true,
    source: {
      relPath: typeof src.relPath === "string" && src.relPath ? src.relPath : null,
      durationSec: posNum(src.durationSec),
      width: posNum(src.width),
      height: posNum(src.height),
      fps: posNum(src.fps),
    },
    sourceLang: normLang(raw.sourceLang, base.sourceLang),
    targetLang: normLang(raw.targetLang, base.targetLang),
    // Chỉ nhận khi meta ghi rõ một mã ngôn ngữ; thiếu/null/rác đều là "giống phụ đề"
    dubLang:
      typeof raw.dubLang === "string" && LANG_RE.test(raw.dubLang.trim())
        ? raw.dubLang.trim().toLowerCase()
        : null,
    mode: TRANSLATE_MODES.includes(raw.mode as TranslateMode)
      ? (raw.mode as TranslateMode)
      : base.mode,
    sttProvider: normSttProvider(raw.sttProvider, base.sttProvider),
    transcriptFile: typeof raw.transcriptFile === "string" ? raw.transcriptFile : null,
    transcriptInfo: normTranscriptInfo(raw.transcriptInfo),
    cues: normCues(raw.cues),
    subtitleStyle: normSubtitleStyle(raw.subtitleStyle, base.subtitleStyle),
    dub: normDubSettings(raw.dub, base.dub),
    dubInfo: normDubInfo(raw.dubInfo),
    outputFile: typeof raw.outputFile === "string" ? raw.outputFile : null,
    status: TRANSLATE_STATUSES.includes(status as TranslateStatus)
      ? (status as TranslateStatus)
      : base.status,
    error: typeof raw.error === "string" ? raw.error : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
  };
}

export function writeTranslateVideo(meta: TranslateVideoMeta): void {
  fs.mkdirSync(translateVideoDirOf(meta.id), { recursive: true });
  const next: TranslateVideoMeta = { ...meta, updatedAt: nowIso() };
  fs.writeFileSync(
    translateVideoMetaPathOf(meta.id),
    JSON.stringify(next, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Vá một phần meta rồi ghi - ĐỌC LẠI TỪ ĐĨA trước khi ghi để không đè mất thay
 * đổi song song (job đang chạy trong khi người dùng sửa cue trên UI).
 */
export function patchTranslateVideo(
  id: string,
  patch: Partial<TranslateVideoMeta>,
): TranslateVideoMeta {
  const cur = readTranslateVideo(id);
  const next: TranslateVideoMeta = { ...cur, ...patch };
  writeTranslateVideo(next);
  return next;
}

/** Danh sách phiên dịch, mới cập nhật trước */
export function scanTranslateVideos(): TranslateVideoMeta[] {
  if (!fs.existsSync(paths.translateVideoDir)) return [];
  const out: TranslateVideoMeta[] = [];
  for (const entry of fs.readdirSync(paths.translateVideoDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !translateVideoExists(entry.name)) continue;
    try {
      out.push(readTranslateVideo(entry.name));
    } catch {
      // meta.json hỏng - bỏ qua một phiên còn hơn làm chết cả danh sách
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
