import fs from "node:fs";
import path from "node:path";
import type { StyleDesign } from "./styles.js";
import { addTokenUsage } from "./db.js";
import type { ImageAspect, ImageKind, ImageTextPosition } from "./imageMeta.js";
import type { VideoStyle } from "./videoStyles.js";
import { hasAntigravityCli } from "./config.js";
import { generateSubscriptionImage } from "./subscriptionImage.js";
import { ensureDir } from "./util.js";

/**
 * Gọi Gemini tạo ảnh nền (gemini-3.1-flash-image - "Nano Banana 2").
 * Endpoint + shape body/response đã verify trong docs/API.md mục "AI Providers & chọn model".
 * Chữ (tiêu đề, CTA...) KHÔNG để Gemini vẽ - Remotion đặt ở bước compose.
 */

/** Các model tạo ảnh khả dụng - UI cho chọn, meta.model lưu lựa chọn */
export const IMAGE_MODELS = [
  { id: "gemini-3.1-flash-image", label: "Nano Banana 2 (khuyên dùng) - gemini-3.1-flash-image" },
  { id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite (rẻ, nhanh) - gemini-3.1-flash-lite-image" },
  { id: "gemini-3-pro-image", label: "Nano Banana Pro (cao cấp, 4K) - gemini-3-pro-image" },
] as const;

export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";

function geminiEndpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`;
}

/** GOOGLE_API_KEY thắng nếu có cả hai (theo hợp đồng API) */
export function geminiApiKey(): string | null {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || null;
}

const KIND_PHRASES: Record<ImageKind, string> = {
  background: "clean background scene",
  "3d": "3D illustration render",
  character: "character illustration",
  texture: "liquid glass texture",
  product: "product concept shot",
  concept: "advertising concept",
};

/**
 * Vùng Remotion sẽ đặt chữ theo tỉ lệ khung (khớp layout composition Poster) -
 * dặn Gemini chừa vùng đó thoáng để chữ đặt lên không bị rối.
 */
/**
 * Hướng dẫn bố cục - QUAN TRỌNG: một cảnh THỐNG NHẤT phủ toàn khung, KHÔNG chia đôi.
 * Vùng chữ chỉ giảm độ chi tiết/tương phản dần (falloff), atmosphere vẫn tràn qua.
 */
const NEGATIVE_SPACE: Record<ImageAspect, string> = {
  "9:16":
    "Compose ONE unified scene filling the ENTIRE frame. Main subject in the upper two thirds; toward the lower third, gradually reduce detail and contrast (soft atmospheric falloff) so a headline can sit there - but atmosphere, lighting and background texture must continue through that area. Never leave an empty band, never split the image into zones.",
  "4:5":
    "Compose ONE unified scene filling the ENTIRE frame; gradually reduce detail toward the lower third with soft atmospheric falloff - background atmosphere must continue through it. No empty band, no split.",
  "16:9":
    "Compose ONE unified scene filling the ENTIRE frame. Main subject slightly RIGHT of center; visual elements, lighting and atmosphere must FLOW ACROSS the whole frame including the left side - on the left third only gradually reduce detail and contrast (soft falloff, darker, fewer elements) so a headline can sit there. STRICTLY FORBIDDEN: an empty left half, a hard vertical split, or two visually separate zones.",
  "1:1":
    "Compose ONE unified scene filling the ENTIRE frame; gradually reduce detail toward the center-bottom with soft falloff - atmosphere continues through it. No empty zones, no split.",
};

/**
 * Bố cục cho ẢNH MINH HỌA VIDEO - khác hẳn Poster: trên video, KEY CHÍNH nằm
 * band TRÊN (skill key-layout + HighlightTrack) và caption/key liên quan nằm
 * band DƯỚI. Dùng bảng Poster (chủ thể 2/3 trên, chừa 1/3 dưới cho headline)
 * là chủ thể chui thẳng vào gầm thẻ key và bị che mất - lỗi đã gặp thật.
 * Chủ thể phải nằm GIỮA khung theo chiều dọc, hai mép trên/dưới chỉ là
 * atmosphere tiếp diễn.
 */
const NEGATIVE_SPACE_VIDEO: Record<ImageAspect, string> = {
  "9:16":
    "Compose ONE unified scene filling the ENTIRE frame. Main subject VERTICALLY CENTERED, contained within the middle 55% of the frame: the TOP ~15% and BOTTOM ~20% of the image will be covered by overlay cards and captions, so keep both of those bands as low-detail atmospheric continuation (soft falloff, fewer elements, lower contrast) - lighting, atmosphere and background texture must still flow through them. Never place the subject or any important detail near the top or bottom edge, never leave an empty band, never split the image into zones.",
  "16:9":
    "Compose ONE unified scene filling the ENTIRE frame. Main subject CENTERED, contained within the middle 60% of the frame height: the TOP ~12% and BOTTOM ~18% will be covered by overlay cards and captions, so keep those horizontal bands as low-detail atmospheric continuation (soft falloff, fewer elements, lower contrast) with lighting and texture flowing through. Never place important detail near the top or bottom edge, never leave an empty band, never split the image into zones.",
  "4:5":
    "Compose ONE unified scene filling the ENTIRE frame. Main subject vertically centered; keep the top and bottom ~15% as low-detail atmospheric continuation (soft falloff) for overlay text - atmosphere must flow through. No empty band, no split.",
  "1:1":
    "Compose ONE unified scene filling the ENTIRE frame. Main subject centered; keep the top and bottom edges low-detail with soft atmospheric falloff for overlay text - atmosphere continues through. No empty zones, no split.",
};

/**
 * Bố cục ảnh minh họa video khi người dùng CHỌN vị trí chủ thể (lưới 3x3 trong
 * brief, giống bộ chọn vị trí chữ của image project). "auto" không đi qua đây -
 * nó dùng bảng NEGATIVE_SPACE_VIDEO ở trên (giữa khung, chừa cả hai band).
 * Vị trí do người dùng chỉ định thì tôn trọng tuyệt đối, chỉ giữ thêm quy tắc
 * band nào KHÔNG chứa chủ thể vẫn phải thoáng cho caption/thẻ key đè lên.
 */
function videoSubjectGuidance(position: Exclude<ImageTextPosition, "auto">): string {
  const [vert, horiz] = position.split("-") as [
    "top" | "middle" | "bottom",
    "left" | "center" | "right",
  ];
  const vertPhrase =
    vert === "top" ? "upper third" : vert === "bottom" ? "lower third" : "vertical center";
  const horizPhrase =
    horiz === "left" ? "left side" : horiz === "right" ? "right side" : "horizontal center";
  const parts = [
    `Compose ONE unified scene filling the ENTIRE frame. Main subject placed in the ${vertPhrase} of the frame, toward the ${horizPhrase}.`,
    "The rest of the frame is continuous atmosphere with soft falloff (fewer elements, lower contrast) - lighting and background texture must flow across the whole frame.",
  ];
  // Band không chứa chủ thể vẫn phải thoáng: caption luôn nằm đáy video,
  // thẻ key hay nằm mép trên - trừ khi người dùng chủ động đặt chủ thể vào đó.
  if (vert !== "bottom") {
    parts.push("Keep the BOTTOM ~18% of the image low-detail - captions will overlay there.");
  }
  if (vert !== "top") {
    parts.push("Keep the TOP ~12% of the image low-detail - overlay cards may sit there.");
  }
  parts.push("Never leave an empty band, never split the image into zones.");
  return parts.join(" ");
}

/**
 * Build prompt tiếng Anh: yêu cầu người dùng + kind + Design System + quy tắc điều phối
 * với Remotion (Gemini chỉ làm NỀN; chữ/icon/logo/thành phần đồ họa do Remotion đặt).
 */
export function buildImagePrompt(input: {
  prompt: string;
  kind: ImageKind;
  aspect: ImageAspect;
  design: StyleDesign;
  /** true = cho phép Gemini vẽ chữ tiếng Việt vào ảnh (mặc định false - chữ do Remotion đặt) */
  allowText?: boolean;
  /** Phong cách dựng video - null = giữ chỉ đạo mỹ thuật mặc định (ảnh quảng cáo) */
  videoStyle?: VideoStyle | null;
  /**
   * Bố cục vùng chừa chữ. "poster" (mặc định) = layout composition Poster
   * (headline 1/3 dưới); "video" = ảnh minh họa video (key band trên, caption
   * band dưới → chủ thể GIỮA khung). Route /api/illustrations luôn truyền "video".
   */
  layout?: "poster" | "video";
  /**
   * Vị trí chủ thể do người dùng chọn (brief.illustrationPosition, lưới 3x3).
   * Chỉ có tác dụng với layout "video"; "auto"/bỏ trống = giữa khung an toàn.
   */
  subjectPosition?: ImageTextPosition;
}): string {
  const { design } = input;
  const c = design.colors;
  const allowText = input.allowText === true;
  // Người dùng CHỦ ĐỘNG xin logo/icon trong prompt (vd "có logo meta, tiktok...") →
  // cho phép icon/logo trang trí, nhưng CHỮ thì tuyệt đối không (Remotion đặt).
  const wantsLogos = /\b(logo|icon|biểu tượng)\b/i.test(input.prompt);

  const parts: string[] = [
    // Ràng buộc chữ đặt ĐẦU TIÊN - model tuân thủ tốt hơn khi ràng buộc đứng trước nội dung
    allowText
      ? "Text in the image IS allowed and should reinforce the message: short Vietnamese phrase(s) (3–6 words max), spelled EXACTLY as provided in the prompt, large clean typography matching the brand style, correct Vietnamese diacritics, no lorem ipsum, no gibberish, no extra unrelated text."
      : "Create a BACKGROUND IMAGE ONLY - it must contain ZERO typography: no text, no words, no letters, no numbers, no captions, no headlines anywhere. The headline will be added later by a design tool.",
    `A ${KIND_PHRASES[input.kind]} for the brand "${design.name}".`,
  ];
  if (input.prompt.trim()) parts.push(input.prompt.trim());
  // Phong cách "loose" có bảng màu ruột của nó (mực tàu đen trắng, Đông Hồ màu
  // khoáng, ảnh chụp thật) - ép bảng màu thương hiệu vào là mất luôn phong cách,
  // nên hạ xuống thành màu điểm nhấn thay vì bỏ hẳn ràng buộc thương hiệu.
  const loosePalette = input.videoStyle?.palette === "loose";
  parts.push(
    loosePalette
      ? `Brand colours appear only as accents where they fit naturally: primary ${c.primary}, secondary ${c.secondary}, accent ${c.accent}. The artistic style's own traditional palette leads.`
      : `Use the brand color palette: primary ${c.primary}, secondary ${c.secondary}, dark background ${c.background}, accent ${c.accent}.`,
  );
  if (!loosePalette) {
    parts.push(
      "STRICT BRAND COMPLIANCE: this style guide is mandatory - stay within the palette above (plus its neutral tints/shades); do not introduce a different color scheme even if the scene description implies one.",
    );
  }
  // Tone + hiệu ứng của Style Design chỉ áp khi KHÔNG có phong cách dựng.
  // Có phong cách dựng mà vẫn đẩy "Liquid glass 3D" / "Smooth color gradients"
  // vào cùng prompt với "Avoid: no gradients" (flat-vector) hay "mực tàu trên
  // giấy dó" là hai chỉ dẫn đá nhau - ảnh ra nửa nọ nửa kia, đúng thứ CLAUDE.md
  // muc 5.6 cấm. Tone cũng vậy: nó tả một ngôn ngữ hình ảnh khác thì phải
  // nhường (phía chữ editPrompt.ts đã làm y hệt). Màu + font vẫn cưỡng chế ở trên.
  if (!input.videoStyle) {
    if (design.tone.trim()) parts.push(`Brand tone and mood: ${design.tone.trim()}.`);
    // Hiệu ứng của style - áp vào chất liệu hình ảnh
    if (design.effects.liquidGlass) {
      parts.push(
        "Liquid glass aesthetic: translucent glassy 3D elements, soft refractions, subtle glow.",
      );
    }
    if (design.effects.gradient) {
      parts.push("Smooth color gradients blending the brand palette across lighting and surfaces.");
    }
  }
  // Chỉ đạo mỹ thuật: phong cách dựng THAY THẾ hẳn câu mặc định, không cộng vào.
  // Cộng vào thì "ảnh quảng cáo bóng bẩy, chiều sâu điện ảnh" đánh nhau với
  // "giấy gấp phẳng" hay "mực tàu trên giấy dó" - ra một thứ nửa nọ nửa kia.
  if (input.videoStyle) {
    parts.push(input.videoStyle.art, `Avoid: ${input.videoStyle.avoid}.`);
  } else {
    parts.push("High quality, professional advertising background, cohesive lighting, cinematic depth.");
  }
  const subjectPos = input.subjectPosition ?? "auto";
  parts.push(
    input.layout === "video"
      ? subjectPos === "auto"
        ? NEGATIVE_SPACE_VIDEO[input.aspect]
        : videoSubjectGuidance(subjectPos)
      : NEGATIVE_SPACE[input.aspect],
  );
  // Style CÓ file logo thật -> tuyệt đối không để model vẽ logo thương hiệu.
  //
  // ĐO ĐƯỢC, ĐỪNG NỚI RA: chỉ THÊM một câu cấm là KHÔNG đủ. Lần thử đầu vẫn
  // giữ dòng "cho phép logo trang trí" bên dưới, và với prompt "bức tường có
  // tên thương hiệu" model có thể tự vẽ monogram sai - tức là nó theo
  // dòng CHO PHÉP và bỏ dòng CẤM. Hai câu đá nhau thì model chọn câu dễ hơn.
  // Nên khi đã có file logo thật: bỏ HẲN nhánh cho phép, và nhắc lại lệnh cấm ở
  // cuối prompt (chỗ model bám nhất, đúng như cách chặn chữ ở dưới).
  const hasRealLogo = Boolean(design.logoPath);
  if (hasRealLogo) {
    parts.push(
      `Do NOT draw, invent, recreate or approximate any logo, wordmark, monogram, emblem or brand name for "${design.name}" anywhere in this image - not large, not small, not blurred, not on a wall, sign, plaque, screen, product, badge or reflection. Where a logo would naturally appear, render that surface as CLEAN AND COMPLETELY EMPTY (a blank wall, a blank plaque, a blank screen). The real logo is composited afterwards from an actual file by the design tool.`,
    );
  } else if (wantsLogos) {
    parts.push(
      "Decorative brand logos/icons requested above are allowed, but keep them small, fully inside the frame with generous margins, away from the reserved clean text area, and never cropped at the edges.",
    );
  } else {
    parts.push(
      "No logos, no icons, no UI elements, no buttons, no charts - pure scenic/abstract background.",
    );
  }
  parts.push("Nothing cropped or cut off at the edges.");
  if (!allowText) {
    // Nhắc lại lệnh cấm chữ ở CUỐI - chốt chặn kép
    parts.push(
      "FINAL RULE (most important): the image must contain absolutely NO text of any kind.",
    );
  }
  if (hasRealLogo) {
    // Chốt chặn kép cho logo, đặt SAU cùng vì đó là chỗ model bám nhất
    parts.push(
      `FINAL RULE: absolutely no "${design.name}" logo, monogram or brand mark may be drawn - leave those surfaces blank.`,
    );
  }
  return parts.join(" ");
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Tạo ảnh nền → ghi PNG vào `outFile` (image-projects/<id>/background.png).
 * Ưu tiên Antigravity Subscription; Gemini API key chỉ là fallback.
 */
export async function generateBackground(input: {
  prompt: string;
  kind: ImageKind;
  aspect: ImageAspect;
  design: StyleDesign;
  /** Đường dẫn tuyệt đối file PNG output */
  outFile: string;
  /** Id image project - để ghi token usage khi phải dùng Gemini API fallback */
  usageProjectId?: string;
  /** Model tạo ảnh người dùng chọn (IMAGE_MODELS) - mặc định Nano Banana 2 */
  model?: string;
  /** true = cho phép Gemini vẽ chữ vào ảnh (mặc định false - giữ hành vi cũ) */
  allowText?: boolean;
  /** Phong cách dựng video - null = chỉ đạo mỹ thuật mặc định (ảnh quảng cáo) */
  videoStyle?: VideoStyle | null;
  /** Bố cục vùng chừa chữ - xem buildImagePrompt. Ảnh minh họa video = "video". */
  layout?: "poster" | "video";
  /** Vị trí chủ thể người dùng chọn - xem buildImagePrompt */
  subjectPosition?: ImageTextPosition;
}): Promise<{ file: string; promptUsed: string }> {
  // Nhận cả model mới từ danh sách live của Google - chỉ cần id hợp lệ có "image"
  const model =
    input.model && /^[a-z0-9][a-z0-9.-]{2,80}$/i.test(input.model) && input.model.includes("image")
      ? input.model
      : DEFAULT_IMAGE_MODEL;
  const promptUsed = buildImagePrompt(input);
  const key = geminiApiKey();

  // Ưu tiên gói Google/Antigravity đã đăng nhập. Nếu CLI chưa cài, phiên hết hạn
  // hoặc tool tạo ảnh bị từ chối thì mới dùng key dự phòng (nếu người dùng có).
  let subscriptionError: string | null = null;
  if (hasAntigravityCli()) {
    try {
      await generateSubscriptionImage({
        provider: "gemini",
        prompt: promptUsed,
        outFile: input.outFile,
      });
      return { file: input.outFile, promptUsed };
    } catch (err) {
      subscriptionError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!key) {
    throw new Error(
      subscriptionError
        ? `Antigravity Subscription không tạo được ảnh: ${subscriptionError}. Không có GEMINI_API_KEY dự phòng.`
        : "Chưa gọi được Antigravity CLI (`agy`) và chưa có GEMINI_API_KEY dự phòng. Cài/đăng nhập Antigravity CLI hoặc thêm key ở trang Kết nối.",
    );
  }

  const body = {
    contents: [{ parts: [{ text: promptUsed }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: input.aspect, imageSize: "1K" },
    },
  };

  let res: Response;
  try {
    res = await fetch(geminiEndpoint(model), {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Không gọi được Gemini API (lỗi mạng): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const errBody = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Gemini API trả lỗi ${res.status}: ${errBody || res.statusText}`);
  }

  const data = (await res.json()) as GeminiResponse;
  const geminiParts = data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = geminiParts.find((p) => typeof p.inlineData?.data === "string" && p.inlineData.data);
  if (!imagePart?.inlineData?.data) {
    const text = geminiParts
      .map((p) => p.text)
      .filter(Boolean)
      .join(" ")
      .slice(0, 300);
    throw new Error(
      `Gemini không trả về ảnh${text ? ` - phản hồi: ${text}` : ""}. Thử sửa prompt rồi chạy lại.`,
    );
  }

  ensureDir(path.dirname(input.outFile));
  fs.writeFileSync(input.outFile, Buffer.from(imagePart.inlineData.data, "base64"));

  // Ghi nhận token Gemini cho biểu đồ Dashboard (giá gemini-3.1-flash-image: $60/1M output tokens)
  try {
    const inTok = data.usageMetadata?.promptTokenCount ?? 0;
    const outTok = data.usageMetadata?.candidatesTokenCount ?? 0;
    if (inTok > 0 || outTok > 0) {
      addTokenUsage(
        `img_${input.usageProjectId ?? "unknown"}`,
        input.usageProjectId ?? null,
        inTok,
        outTok,
        (outTok * 60) / 1_000_000,
        "gemini",
      );
    }
  } catch {
    /* usage là phụ - không chặn luồng chính */
  }

  return { file: input.outFile, promptUsed };
}
