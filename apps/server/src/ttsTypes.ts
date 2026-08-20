/**
 * Kiểu dùng chung cho MỌI engine giọng đọc.
 *
 * Hệ thống có hai engine chạy song song, cố ý không hợp nhất:
 *
 * - "gemini"  - gọi API Google. Chất lượng cao, 30 giọng, nhưng tốn tiền, cần
 *               mạng và cần GEMINI_API_KEY.
 * - "vieneu"  - VieNeu-TTS v3 Turbo chạy THẲNG TRÊN MÁY (Apache 2.0, cả code
 *               lẫn trọng số). Miễn phí, không cần mạng, và là engine DUY NHẤT
 *               nhân bản được giọng. Đổi lại: phải cài Python + gói `vieneu`.
 *
 * VÌ SAO KHÔNG BỎ GEMINI ĐI: máy yếu đọc chậm ngang thời gian thật (đo được RTF
 * ~1.0 trên CPU), còn Gemini trả về sau vài giây. Giữ cả hai để người dùng tự
 * chọn theo máy và theo túi tiền, không phải để trang trí.
 */

export type TtsEngine = "gemini" | "vieneu";

export const TTS_ENGINES: TtsEngine[] = ["gemini", "vieneu"];

export const DEFAULT_TTS_ENGINE: TtsEngine = "gemini";

export function isTtsEngine(v: unknown): v is TtsEngine {
  return v === "gemini" || v === "vieneu";
}

/**
 * Giới tính giọng. Với Gemini đây là số ĐO ĐƯỢC (đọc cùng một câu bằng cả 30
 * giọng rồi đo F0); với VieNeu thì chính gói Python khai báo sẵn.
 */
export type TtsGender = "nam" | "nu" | "trung-tinh";

/** Vùng miền giọng - chỉ VieNeu có; Gemini không phân vùng miền. */
export type TtsRegion = "bac" | "trung" | "nam";

/** Giọng dựng sẵn hay giọng người dùng tự nhân bản. */
export type TtsVoiceKind = "preset" | "cloned";

export interface TtsVoice {
  /** Engine sở hữu giọng này - hai engine có thể trùng tên giọng nên luôn đi cặp */
  engine: TtsEngine;
  /**
   * Định danh gửi lên khi tổng hợp. Với giọng nhân bản đây là `id` trong kho
   * (kebab-case), KHÔNG phải tên người dùng đặt - tên đó đổi được, mà đổi tên
   * thì phiên cũ phải vẫn đọc ra đúng giọng ấy.
   */
  name: string;
  /** Tên hiện lên màn hình. Giọng dựng sẵn thì trùng `name`; giọng nhân bản là tên người dùng đặt. */
  title: string;
  /**
   * Nhãn do SERVER sinh. Web ưu tiên bản dịch trong locale; nhãn này chỉ là lưới
   * an toàn cho giọng mà web chưa có key (vd Google thêm giọng mới).
   */
  label: string;
  gender: TtsGender;
  /** F0 trung vị đo được (Hz); 0 = chưa đo (giọng VieNeu và giọng mới) */
  f0: number;
  kind: TtsVoiceKind;
  /** Vùng miền - null với Gemini */
  region: TtsRegion | null;
  /**
   * Key mô tả chất giọng để web dịch, vd "kore" hay "tin-tuc".
   * null = không có mô tả, web hiện `label`.
   */
  timbreKey: string | null;
  /** Ghi chú người dùng nhập khi nhân bản - chỉ giọng cloned mới có */
  note: string;
}

/**
 * Một giọng đã nhân bản, lưu trong assets/voices/.
 *
 * File tham chiếu được GIỮ LẠI (không chỉ giữ embedding) vì engine phải nạp lại
 * nó mỗi lần khởi động tiến trình Python - và vì người dùng cần nghe lại xem
 * mình đã đưa mẫu nào vào.
 */
export interface ClonedVoice {
  id: string;
  name: string;
  gender: TtsGender;
  note: string;
  /** Đường dẫn tương đối repo tới file mẫu đã chuẩn hóa (48kHz mono WAV) */
  refFile: string;
  /** Thời lượng ĐO ĐƯỢC của mẫu (ffprobe) */
  refDurationSec: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mẫu tham chiếu nên dài bao nhiêu.
 *
 * Tài liệu VieNeu khuyên 3-8 giây. Ngắn hơn 3s thì embedding không đủ đặc trưng;
 * dài hơn nhiều cũng KHÔNG tốt hơn (model chỉ lấy phần đầu) mà lại chậm.
 * Trần cứng để chặn người dùng đưa cả file podcast 1 tiếng vào.
 */
export const CLONE_REF_MIN_SEC = 3;
export const CLONE_REF_IDEAL_MAX_SEC = 8;
export const CLONE_REF_MAX_SEC = 30;

/** Câu đọc thử - CỐ Ý NGẮN, xem ghi chú ở routes/tts.ts */
export const PREVIEW_TEXT: Record<"vi" | "en", string> = {
  vi: "Đây là hệ thống chỉnh sửa video bằng AI của Nguyễn Văn Hoàng",
  en: "This is an AI video editing system by Nguyen Van Hoang",
};

export function previewTextFor(lang: unknown): string {
  return lang === "en" ? PREVIEW_TEXT.en : PREVIEW_TEXT.vi;
}
