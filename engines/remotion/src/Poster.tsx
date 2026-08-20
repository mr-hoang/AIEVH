import React from "react";
import { AbsoluteFill, Img, staticFile, useVideoConfig } from "remotion";
import { BRAND_BODY_FAMILY, BRAND_HEADING_FAMILY, ensureBrandFont } from "./brandFonts";
import type { PosterProps, PosterStat } from "./posterManifest";

/**
 * Composition still "Poster" — ảnh quảng cáo/social hoàn thiện:
 * nền (ảnh Gemini hoặc gradient từ design) + tiêu đề tiếng Việt + logo
 * + số liệu + CTA, theo Design System truyền qua props (docs/API.md).
 *
 * Nguyên tắc (bản đại tu — khối chữ HÒA vào ảnh, không chia 2 vùng):
 * - Mọi kích thước scale theo width (đơn vị u = width/1080) → 4:5 và 16:9
 *   đều cân đối. Safe margin ≥ 6% mỗi cạnh.
 * - CẦU NỐI THỊ GIÁC gồm 4 lớp xếp chồng, thứ tự từ dưới lên:
 *   1) nền (ảnh hoặc gradient) → 2) brand tint chéo rất nhẹ phủ TOÀN khung
 *   (thống nhất tông màu 2 vùng) → 3) scrim ELLIPSE neo ở góc chứa chữ
 *   (mép tan mọi hướng, không còn "đường biên vùng") → 4) glow primary
 *   sau khối title (nguồn sáng brand) + vài hạt accent dẫn mắt về phía ảnh.
 * - Chữ chuẩn Design System AIEV: eyebrow badge (pill brandName) → title
 *   đậm với từ khóa highlight gradient primary→secondary → kẻ gradient dưới
 *   khối title → subtitle/stats/CTA.
 *   ⚠️ Gradient text (background-clip: text) với TIẾNG VIỆT dễ cắt dấu:
 *   span highlight phải inline-block, line-height ≥ 1.15, padding bù quanh
 *   glyph (dấu trên ắ/ộ và dấu dưới ậ/ệ) + margin âm hoàn trả layout,
 *   textShadow: none (bóng xuyên qua chữ transparent sẽ làm đục gradient).
 * - Font: nếu design.fontFiles có file brand (public/staging) thì nạp thật qua
 *   @remotion/fonts (BrandHeading/BrandBody, xem brandFonts.ts) — vẫn offline
 *   hoàn toàn (staticFile). Fallback: tên font design.fonts.* rồi stack hệ
 *   thống (Inter/Segoe UI/Roboto) để tiếng Việt đủ dấu. KHÔNG load webfont
 *   từ mạng.
 */

type Orientation = "vertical" | "horizontal" | "square";

const orientationOf = (aspect: PosterProps["aspect"]): Orientation => {
  if (aspect === "16:9") return "horizontal";
  if (aspect === "1:1") return "square";
  return "vertical"; // 9:16, 4:5
};

/** Parse #rgb/#rrggbb → [r,g,b]; màu không hợp lệ → fallback xám đậm. */
const hexToRgb = (hex: string): [number, number, number] => {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [16, 17, 19];
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
};

const rgba = (hex: string, alpha: number): string => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Trộn 2 màu hex theo tỉ lệ t (0 = a, 1 = b). */
const mix = (a: string, b: string, t: number): string => {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};

const SYSTEM_STACK = "Inter, 'Segoe UI', Roboto, sans-serif";

/**
 * Dựng font stack chuẩn Design System: font brand thật (nếu file đã nạp qua
 * loadFont) → tên font design.fonts.* → stack hệ thống an toàn.
 */
const fontFamily = (brandFamily: string | null, preferred: string): string => {
  const name = preferred.trim();
  const tail = !name || name === "Inter" ? SYSTEM_STACK : `'${name.replace(/'/g, "")}', ${SYSTEM_STACK}`;
  return brandFamily ? `'${brandFamily}', ${tail}` : tail;
};

/**
 * Tách title thành phần thường + phần highlight màu primary.
 * ≥ 4 từ: highlight 2 từ cuối; 2-3 từ: highlight từ cuối; ngắn hơn: không tách.
 */
const splitTitle = (title: string): { plain: string; highlight: string } => {
  const words = title.trim().split(/\s+/);
  if (words.length < 2) return { plain: title.trim(), highlight: "" };
  const take = words.length >= 4 ? 2 : 1;
  return {
    plain: words.slice(0, -take).join(" "),
    highlight: words.slice(-take).join(" "),
  };
};

/** Hạt trang trí nhỏ (dot/plus) — rải ở rìa khối chữ, dẫn mắt về phía ảnh. */
type ParticleSpec = {
  x: string; // left, %
  y: string; // top, %
  size: number; // đơn vị u
  color: "accent" | "secondary";
  opacity: number;
  shape: "dot" | "plus";
};

const PARTICLES: Record<Orientation, ParticleSpec[]> = {
  // 16:9 — khối chữ 7%→~50% trái, hạt rải dọc mép phải khối chữ hướng về ảnh.
  horizontal: [
    { x: "47.5%", y: "24%", size: 14, color: "accent", opacity: 0.5, shape: "plus" },
    { x: "52%", y: "42%", size: 8, color: "secondary", opacity: 0.6, shape: "dot" },
    { x: "45.5%", y: "66%", size: 6, color: "accent", opacity: 0.45, shape: "dot" },
    { x: "53.5%", y: "75%", size: 10, color: "secondary", opacity: 0.38, shape: "plus" },
  ],
  // Dọc — khối chữ ở 1/3 dưới, hạt rải phía trên-phải khối chữ nối lên ảnh.
  vertical: [
    { x: "76%", y: "50%", size: 14, color: "accent", opacity: 0.5, shape: "plus" },
    { x: "86%", y: "57%", size: 8, color: "secondary", opacity: 0.55, shape: "dot" },
    { x: "68%", y: "46%", size: 6, color: "accent", opacity: 0.4, shape: "dot" },
    { x: "90%", y: "65%", size: 10, color: "secondary", opacity: 0.38, shape: "plus" },
  ],
  square: [
    { x: "78%", y: "40%", size: 14, color: "accent", opacity: 0.5, shape: "plus" },
    { x: "87%", y: "48%", size: 8, color: "secondary", opacity: 0.55, shape: "dot" },
    { x: "14%", y: "44%", size: 6, color: "accent", opacity: 0.4, shape: "dot" },
    { x: "9%", y: "36%", size: 10, color: "secondary", opacity: 0.38, shape: "plus" },
  ],
};

type VertPos = "top" | "middle" | "bottom";
type HorizPos = "left" | "center" | "right";

/**
 * Bố cục mặc định theo tỉ lệ khung - giá trị của `position: "auto"`.
 * Đây CHÍNH LÀ bố cục cứng trước khi có tùy chọn vị trí, giữ nguyên để ảnh cũ
 * render lại không đổi.
 */
const AUTO_POSITION: Record<Orientation, `${VertPos}-${HorizPos}`> = {
  horizontal: "middle-left",
  square: "bottom-center",
  vertical: "bottom-left",
};

/**
 * Tâm của scrim/glow - phải bám theo khối chữ, nếu không thì chữ dời lên trên
 * mà vùng tối vẫn ở dưới, chữ đặt trên vùng ảnh sáng sẽ không đọc được.
 *
 * Ba tổ hợp "auto" dùng đúng con số cũ (không đụng vào ảnh đã có); các tổ hợp
 * còn lại suy ra theo lưới.
 */
function focusOf(
  orientation: Orientation,
  vert: VertPos,
  horiz: HorizPos,
  isAuto: boolean,
): { x: number; y: number } {
  if (isAuto) {
    if (orientation === "horizontal") return { x: 18, y: 55 };
    if (orientation === "square") return { x: 50, y: 96 };
    return { x: 42, y: 94 };
  }
  // Khối chữ ngang sát mép hơn ở 16:9 (rộng ~47% khung) so với dọc/vuông
  const edge = orientation === "horizontal" ? 20 : 32;
  const x = horiz === "left" ? edge : horiz === "right" ? 100 - edge : 50;
  const y = vert === "top" ? 12 : vert === "bottom" ? 92 : 50;
  return { x, y };
}

export const Poster: React.FC<PosterProps> = ({ aspect, background, design, overlay }) => {
  // width/height do calculateMetadata đặt từ aspect (POSTER_DIMENSIONS).
  const { width, height } = useVideoConfig();
  const orientation = orientationOf(aspect);
  const { colors, fonts, fontFiles, logoFile, brandName, effects } = design;
  const { title, subtitle, stats, cta, showLogo, position } = overlay;

  // ---- Vị trí khối chữ ------------------------------------------------------
  // "auto" = bố cục mặc định theo tỉ lệ khung, ĐÚNG như trước khi có tùy chọn
  // này - project cũ render lại phải ra y hệt.
  const isAutoPosition = position === "auto";
  const resolvedPosition = isAutoPosition ? AUTO_POSITION[orientation] : position;
  const [vert, horiz] = resolvedPosition.split("-") as [VertPos, HorizPos];
  /** align-items/justify-content tương ứng cạnh ngang đã chọn */
  const flexAlign =
    horiz === "left" ? "flex-start" : horiz === "right" ? "flex-end" : "center";
  /** Tâm của scrim + glow - phải bám khối chữ để chữ luôn nằm trên nền tối */
  const focus = focusOf(orientation, vert, horiz, isAutoPosition);

  // Nạp font brand thật (nếu backend đưa file). ensureBrandFont idempotent;
  // loadFont của @remotion/fonts tự delayRender/continueRender nên frame chỉ
  // được chụp sau khi font sẵn sàng.
  const hasBrandHeading = ensureBrandFont(BRAND_HEADING_FAMILY, fontFiles.heading);
  const hasBrandBody = ensureBrandFont(BRAND_BODY_FAMILY, fontFiles.body);

  /** Đơn vị scale theo width — 1u = 1px trên canvas rộng 1080. */
  const u = width / 1080;
  // Safe margin ≥ 6% mỗi cạnh (ngang: mép trái 7% theo spec layout).
  const marginX = Math.round(width * 0.07);
  const marginY = Math.round(height * 0.07);

  const validStats = stats.filter((s: PosterStat) => s.value.trim() !== "");
  const hasTitle = title.trim() !== "";
  const hasSubtitle = subtitle.trim() !== "";
  const hasCta = cta.trim() !== "";
  const hasBrandName = brandName.trim() !== "";
  const { plain, highlight } = splitTitle(title);

  // ---- Nền -----------------------------------------------------------------
  // background = null → gradient dựng từ design.colors: nền base pha primary
  // nhẹ (radial glow góc trên + linear tinh tế), thêm accent rất mờ góc dưới.
  const gradientBackground = [
    `radial-gradient(ellipse 130% 95% at 85% -12%, ${rgba(colors.primary, 0.5)} 0%, ${rgba(colors.primary, 0.16)} 40%, transparent 68%)`,
    `radial-gradient(ellipse 100% 80% at -10% 105%, ${rgba(colors.primary, 0.16)} 0%, transparent 50%)`,
    `linear-gradient(160deg, ${mix(colors.background, colors.primary, 0.22)} 0%, ${colors.background} 48%, ${mix(colors.background, "#000000", 0.3)} 100%)`,
  ].join(", ");

  // ---- Lớp 1: brand tint phủ TOÀN khung ------------------------------------
  // Gradient chéo rất nhẹ từ góc chứa chữ tan ra 55% — kéo tông primary tràn
  // sang cả vùng ảnh để 2 vùng chung một "không khí" màu.
  // Hướng gradient đi TỪ phía có chữ ra ngoài - chữ ở trên thì tint phải đổ
  // xuống, không thì lớp tint nằm ngược phía với khối chữ.
  const tintDirection =
    horiz === "left" && vert === "middle"
      ? "100deg"
      : horiz === "right" && vert === "middle"
        ? "260deg"
        : vert === "top"
          ? "to bottom"
          : "to top";
  const brandTint = `linear-gradient(${tintDirection}, ${rgba(colors.primary, 0.1)} 0%, transparent 55%)`;

  // ---- Lớp 2: scrim ELLIPSE neo ở góc chứa chữ ------------------------------
  // Radial gradient phủ cả khung, tâm nằm trong vùng chữ — độ tối tan tự nhiên
  // theo MỌI hướng, không tạo cạnh/biên thẳng như dải linear cũ.
  const scrimBase = mix(colors.background, "#000000", 0.55);
  // Kích thước ellipse + các mốc tan theo tỉ lệ khung (khối chữ rộng/cao khác
  // nhau); TÂM theo vị trí chữ đã chọn.
  //
  // Giữ NGUYÊN từng con số của ba bố cục cũ thay vì gộp thành một công thức
  // chung: đã thử gộp và render lại ảnh "auto" ra khác hash, tức là ảnh người
  // dùng đã tạo sẽ đổi sau khi cập nhật.
  const scrimSpec =
    orientation === "horizontal"
      ? { size: "78% 115%", a0: 0.88, s1: 42, a1: 0.6, s2: 66, a2: 0.24 }
      : orientation === "square"
        ? { size: "115% 72%", a0: 0.88, s1: 44, a1: 0.58, s2: 68, a2: 0.22 }
        : { size: "130% 60%", a0: 0.9, s1: 44, a1: 0.6, s2: 68, a2: 0.24 };
  const scrimGradient =
    `radial-gradient(ellipse ${scrimSpec.size} at ${focus.x}% ${focus.y}%, ` +
    `${rgba(scrimBase, scrimSpec.a0)} 0%, ${rgba(scrimBase, scrimSpec.a1)} ${scrimSpec.s1}%, ` +
    `${rgba(scrimBase, scrimSpec.a2)} ${scrimSpec.s2}%, transparent ${orientation === "horizontal" ? 84 : 85}%)`;

  // ---- Lớp 3: glow primary sau khối title -----------------------------------
  // Nguồn sáng brand ngay sau chữ — nối khối chữ với ánh sáng của ảnh.
  // Glow bám sát khối chữ, kéo nhẹ vào trong khung so với tâm scrim
  const glowCenter = isAutoPosition
    ? orientation === "horizontal"
      ? "24% 48%"
      : orientation === "square"
        ? "50% 72%"
        : "32% 74%"
    : `${focus.x}% ${vert === "top" ? focus.y + 8 : vert === "bottom" ? focus.y - 8 : focus.y}%`;
  const titleGlow = `radial-gradient(${Math.round(640 * u)}px ${Math.round(460 * u)}px at ${glowCenter}, ${rgba(colors.primary, 0.14)} 0%, ${rgba(colors.primary, 0.06)} 55%, transparent 100%)`;

  // ---- Kích thước chữ (scale theo width, chỉnh theo orientation) ----------
  const titleSize = Math.round((orientation === "horizontal" ? 54 : orientation === "square" ? 76 : 88) * u);
  const subtitleSize = Math.round((orientation === "horizontal" ? 26 : 30) * u);
  const statValueSize = Math.round(34 * u);
  const statLabelSize = Math.round(15 * u);
  const ctaSize = Math.round(20 * u);
  const eyebrowSize = Math.round(15 * u);
  const logoHeight = Math.round((orientation === "horizontal" ? 40 : 56) * u);

  const headingFont = fontFamily(hasBrandHeading ? BRAND_HEADING_FAMILY : null, fonts.heading);
  const bodyFont = fontFamily(hasBrandBody ? BRAND_BODY_FAMILY : null, fonts.body);

  // ---- Logo góc trên --------------------------------------------------------
  // Chỉ còn logo ẢNH ở góc (dọc/vuông: trên-trái; ngang: trên-phải). brandName
  // dạng chữ đã chuyển xuống eyebrow badge trong khối nội dung — không lặp.
  // Logo phải TRÁNH khối chữ: nằm ở dải dọc đối diện, và lệch sang cạnh ngang
  // đối diện. Chữ dời lên trên mà logo vẫn ở trên là hai khối chồng lên nhau.
  const logoCorner: React.CSSProperties = isAutoPosition
    ? orientation === "horizontal"
      ? { top: marginY, right: marginX }
      : { top: marginY, left: marginX }
    : {
        ...(vert === "top" ? { bottom: marginY } : { top: marginY }),
        ...(horiz === "right" ? { left: marginX } : { right: marginX }),
      };

  const logoNode =
    showLogo && logoFile ? (
      <Img
        src={staticFile(logoFile)}
        style={{
          position: "absolute",
          ...logoCorner,
          height: logoHeight,
          width: "auto",
          objectFit: "contain",
          filter: `drop-shadow(0 ${2 * u}px ${10 * u}px rgba(0,0,0,0.35))`,
        }}
      />
    ) : null;

  // ---- Highlight gradient text (an toàn dấu tiếng Việt) --------------------
  // inline-block + line-height 1.2 + padding bù (trên cho ắ/ộ, dưới cho ậ/ệ,
  // phải cho glyph cuối khi letter-spacing âm) + margin âm hoàn trả layout.
  // textShadow: none — bóng của h1 xuyên qua chữ transparent sẽ làm đục gradient.
  const padTop = Math.round(titleSize * 0.18);
  const padBottom = Math.round(titleSize * 0.12);
  const padRight = Math.round(titleSize * 0.06);
  // effects.gradient tắt → highlight solid màu primary (không background-clip)
  const highlightStyle: React.CSSProperties = effects.gradient
    ? {
        display: "inline-block",
        lineHeight: 1.2,
        overflow: "visible",
        padding: `${padTop}px ${padRight}px ${padBottom}px 0`,
        margin: `${-padTop}px ${-padRight}px ${-padBottom}px 0`,
        backgroundImage: `linear-gradient(94deg, ${colors.primary} 0%, ${colors.secondary} 100%)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        WebkitTextFillColor: "transparent",
        textShadow: "none",
      }
    : { color: colors.primary };

  // ---- Khối nội dung ------------------------------------------------------
  // 16:9: căn giữa THEO CHIỀU DỌC, khối chữ max ~46% khung, cách mép trái 7%.
  // Dọc: 1/3 dưới. Vuông: đáy, căn giữa ngang.
  const contentAlign: React.CSSProperties = {
    justifyContent:
      vert === "top" ? "flex-start" : vert === "bottom" ? "flex-end" : "center",
    alignItems: flexAlign,
    textAlign: horiz,
  };

  const centered = horiz === "center";
  // 16:9 bó khối chữ trong 47% khung để nửa còn lại chừa chỗ cho chủ thể ảnh.
  // Nhưng khi người dùng căn GIỮA thì không còn "nửa còn lại" nào để chừa, giữ
  // 47% chỉ làm chữ xuống dòng vụn (đo được: "bộ" rơi một mình xuống dòng).
  const contentMaxWidth =
    orientation === "horizontal"
      ? Math.round(width * (horiz === "center" ? 0.72 : 0.47))
      : Math.round(width - marginX * 2);

  const particleColor = (c: ParticleSpec["color"]): string =>
    c === "accent" ? colors.accent : colors.secondary;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.background, fontFamily: bodyFont }}>
      {/* Lớp nền: ảnh (cover) hoặc gradient từ design */}
      {background ? (
        <Img
          src={staticFile(background)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <AbsoluteFill style={{ background: gradientBackground }} />
      )}

      {/* Brand tint toàn khung — thống nhất tông màu vùng chữ và vùng ảnh */}
      <AbsoluteFill style={{ background: brandTint }} />

      {/* Scrim ellipse neo ở góc chứa chữ — mép tan mọi hướng, không lộ biên */}
      <AbsoluteFill style={{ background: scrimGradient }} />

      {/* Glow primary sau khối title — nguồn sáng brand nối chữ với ảnh */}
      <AbsoluteFill style={{ background: titleGlow }} />

      {/* Hạt trang trí accent/secondary — dẫn mắt từ khối chữ sang ảnh.
          Tọa độ của chúng gắn cứng với bố cục mặc định (rìa khối chữ), nên khi
          người dùng tự chọn vị trí khác thì bỏ hẳn - để lại là hạt rơi ĐÈ LÊN
          chữ. */}
      {(isAutoPosition ? PARTICLES[orientation] : []).map((p, i) =>
        p.shape === "plus" ? (
          <svg
            key={i}
            width={Math.round(p.size * u)}
            height={Math.round(p.size * u)}
            viewBox="0 0 24 24"
            style={{ position: "absolute", left: p.x, top: p.y, opacity: p.opacity }}
          >
            <path
              d="M12 3.5v17M3.5 12h17"
              stroke={particleColor(p.color)}
              strokeWidth={3.5}
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        ) : (
          <div
            key={i}
            style={{
              position: "absolute",
              left: p.x,
              top: p.y,
              width: Math.round(p.size * u),
              height: Math.round(p.size * u),
              borderRadius: "50%",
              backgroundColor: particleColor(p.color),
              opacity: p.opacity,
            }}
          />
        ),
      )}

      {logoNode}

      {/* Nội dung — nhịp dọc: eyebrow 18u → title → kẻ gradient 16u → subtitle 18u → stats 24u → CTA */}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          padding: `${marginY}px ${marginX}px`,
          ...contentAlign,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            maxWidth: contentMaxWidth,
            alignItems: flexAlign,
          }}
        >
          {/* Eyebrow badge — pill brandName, thay cho accent bar cũ */}
          {hasBrandName ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: Math.round(9 * u),
                padding: `${Math.round(8 * u)}px ${Math.round(18 * u)}px`,
                borderRadius: 999,
                border: `1px solid ${rgba(colors.primary, 0.45)}`,
                backgroundColor: rgba(colors.primary, 0.12),
                fontFamily: headingFont,
                fontSize: eyebrowSize,
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: colors.primary,
                marginBottom: Math.round(18 * u),
              }}
            >
              <span
                style={{
                  width: Math.round(7 * u),
                  height: Math.round(7 * u),
                  borderRadius: "50%",
                  backgroundColor: colors.primary,
                  boxShadow: `0 0 ${10 * u}px ${rgba(colors.primary, 0.8)}`,
                }}
              />
              {brandName.trim()}
            </div>
          ) : null}

          {hasTitle ? (
            <h1
              style={{
                margin: 0,
                fontFamily: headingFont,
                fontSize: titleSize,
                fontWeight: 900,
                lineHeight: 1.14,
                letterSpacing: "-0.03em",
                color: colors.text,
                textWrap: "balance",
                textShadow: `0 ${2 * u}px ${20 * u}px rgba(0,0,0,0.45)`,
              }}
            >
              {highlight === "" ? (
                title.trim()
              ) : (
                <>
                  {plain} <span style={highlightStyle}>{highlight}</span>
                </>
              )}
            </h1>
          ) : null}

          {/* Kẻ gradient primary→transparent dưới CẢ khối title */}
          {hasTitle ? (
            <div
              style={{
                width: "52%",
                height: Math.round(2 * u),
                marginTop: Math.round(16 * u),
                borderRadius: 999,
                // Đầu đặc của kẻ luôn nằm về phía chữ căn vào: căn phải thì
                // phải tan dần sang trái, không thì kẻ trông như lệch khỏi chữ
                background: centered
                  ? `linear-gradient(90deg, transparent, ${colors.primary}, transparent)`
                  : horiz === "right"
                    ? `linear-gradient(270deg, ${colors.primary}, transparent)`
                    : `linear-gradient(90deg, ${colors.primary}, transparent)`,
              }}
            />
          ) : null}

          {hasSubtitle ? (
            <p
              style={{
                margin: 0,
                marginTop: hasTitle ? Math.round(18 * u) : 0,
                fontFamily: bodyFont,
                fontSize: subtitleSize,
                fontWeight: 500,
                lineHeight: 1.4,
                letterSpacing: "0.01em",
                color: rgba(colors.text, 0.78),
                maxWidth: "34ch",
                textShadow: `0 ${1 * u}px ${12 * u}px rgba(0,0,0,0.35)`,
              }}
            >
              {subtitle.trim()}
            </p>
          ) : null}

          {validStats.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "stretch",
                gap: Math.round(14 * u),
                justifyContent: flexAlign,
                marginTop: Math.round(24 * u),
              }}
            >
              {validStats.map((stat: PosterStat, i: number) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    gap: Math.round(3 * u),
                    alignItems: flexAlign,
                    padding: `${Math.round(14 * u)}px ${Math.round(20 * u)}px`,
                    borderRadius: Math.round(14 * u),
                    // effects.liquidGlass tắt → chip phẳng đặc (không blur/glass)
                    backgroundColor: effects.liquidGlass
                      ? rgba(colors.text, 0.07)
                      : mix(colors.background, colors.text, 0.08),
                    border: `1px solid ${rgba(colors.text, effects.liquidGlass ? 0.14 : 0.1)}`,
                    ...(effects.liquidGlass
                      ? {
                          backdropFilter: `blur(${Math.round(12 * u)}px)`,
                          WebkitBackdropFilter: `blur(${Math.round(12 * u)}px)`,
                        }
                      : {}),
                  }}
                >
                  <span
                    style={{
                      fontFamily: headingFont,
                      fontSize: statValueSize,
                      fontWeight: 800,
                      lineHeight: 1.1,
                      letterSpacing: "-0.01em",
                      color: colors.primary,
                    }}
                  >
                    {stat.value}
                  </span>
                  {stat.label.trim() !== "" ? (
                    <span
                      style={{
                        fontFamily: bodyFont,
                        fontSize: statLabelSize,
                        fontWeight: 500,
                        letterSpacing: "0.04em",
                        color: rgba(colors.text, 0.62),
                      }}
                    >
                      {stat.label}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {hasCta ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                alignSelf: flexAlign,
                marginTop: Math.round(24 * u),
                height: Math.round(52 * u),
                padding: `0 ${Math.round(30 * u)}px`,
                borderRadius: 999,
                backgroundColor: colors.primary,
                boxShadow: `0 ${8 * u}px ${24 * u}px ${rgba(colors.primary, 0.35)}`,
                fontFamily: headingFont,
                fontSize: ctaSize,
                fontWeight: 700,
                letterSpacing: "0.02em",
                color: "#ffffff",
                whiteSpace: "nowrap",
              }}
            >
              {cta.trim()}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
