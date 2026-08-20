import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { safeFetchHtml, SafeFetchError } from "./safeFetch.js";
import type { ExtractedArticle } from "./textToVideoMeta.js";
import { HttpError } from "./util.js";

/**
 * Bóc nội dung bài viết từ một trang web (Text to video, nguồn kind="url").
 *
 * Readability (bộ máy Reader View của Firefox) lo phần chọn khối nội dung chính;
 * linkedom lo phần dựng DOM - đo được nhanh hơn jsdom 4-20 lần mà Readability
 * trả ra kết quả GIỐNG HỆT từng byte, nên không có lý do gánh jsdom.
 *
 * Kết quả trả về `blocks` là MẢNG ĐOẠN VĂN chứ không phải một khối chữ: đơn vị
 * chia scene của pipeline là đoạn, gộp lại rồi cắt sau là mất ranh giới thật.
 */

/** Thông báo dùng chung khi bó tay - phải chỉ đường cho người dùng, đừng để họ đứng im */
const PASTE_HINT =
  "Hãy mở bài viết, chọn phần chữ, sao chép rồi dán thẳng vào ô nội dung.";

/* ---------- Thu thập metadata ---------- */

interface HarvestedMeta {
  title: string | null;
  byline: string | null;
  siteName: string | null;
  publishedTime: string | null;
  canonicalUrl: string | null;
  leadImage: string | null;
  lang: string | null;
}

/** Chuẩn hóa khoảng trắng, giữ nguyên dấu tiếng Việt (không normalize NFC/NFD, không bỏ dấu) */
function norm(s: string | null | undefined): string {
  // Ký tự rộng-không (U+200B..U+200D, U+FEFF) hay lẫn vào bài copy từ web và
  // dính giữa chữ có dấu. Viết bằng escape vì để ký tự thật trong source thì
  // không ai nhìn thấy nó ở đây.
  return (s || "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textOrNull(s: string | null | undefined): string | null {
  const t = norm(s);
  return t ? t : null;
}

/** Giải link tương đối về tuyệt đối; trả null nếu không giải được hoặc là data: URI */
function absUrl(raw: string | null | undefined, baseUrl: string): string | null {
  const v = (raw || "").trim();
  if (!v || /^data:/i.test(v)) return null;
  try {
    return new URL(v, baseUrl).href;
  } catch {
    return null;
  }
}

type AnyDocument = ReturnType<typeof parseHTML>["document"];
type AnyElement = ReturnType<AnyDocument["querySelector"]>;

function metaContent(doc: AnyDocument, selector: string): string | null {
  const el = doc.querySelector(selector);
  return el ? textOrNull(el.getAttribute("content")) : null;
}

/** Lấy tên tác giả từ node author của JSON-LD (có thể là chuỗi, object, hoặc mảng) */
function ldAuthorName(author: unknown): string | null {
  if (typeof author === "string") return textOrNull(author);
  if (Array.isArray(author)) {
    const names = author.map(ldAuthorName).filter(Boolean);
    return names.length ? names.join(", ") : null;
  }
  if (author && typeof author === "object") {
    const name = (author as { name?: unknown }).name;
    if (typeof name === "string") return textOrNull(name);
  }
  return null;
}

function ldImageUrl(image: unknown): string | null {
  if (typeof image === "string") return image;
  if (Array.isArray(image)) {
    for (const i of image) {
      const v = ldImageUrl(i);
      if (v) return v;
    }
    return null;
  }
  if (image && typeof image === "object") {
    const url = (image as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return null;
}

interface LdArticle {
  headline?: unknown;
  author?: unknown;
  datePublished?: unknown;
  image?: unknown;
  publisher?: { name?: unknown } | unknown;
  inLanguage?: unknown;
}

/**
 * Tìm node Article trong các khối JSON-LD.
 *
 * BẮT BUỘC try/catch TỪNG khối: JSON-LD của cafef.vn có ký tự xuống dòng thô
 * nằm trong chuỗi nên JSON.parse ném lỗi - để lỗi đó thoát ra là mất toàn bộ
 * metadata của một trang vẫn bóc được nội dung bình thường.
 */
function findLdArticle(doc: AnyDocument): LdArticle | null {
  const nodes = [...doc.querySelectorAll('script[type="application/ld+json"]')];
  for (const n of nodes) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(n.textContent || "");
    } catch {
      continue;
    }
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { "@graph"?: unknown[] })?.["@graph"] ?? [parsed]);
    for (const o of list as Array<Record<string, unknown>>) {
      const type = o?.["@type"];
      const typeStr = Array.isArray(type) ? type.join(" ") : String(type ?? "");
      if (/Article|NewsArticle|BlogPosting|Report/.test(typeStr)) return o as LdArticle;
    }
  }
  return null;
}

/**
 * Gom metadata TRƯỚC khi gọi Readability.parse().
 *
 * Readability xóa sạch mọi thẻ <script> khỏi document khi phân tích, mà JSON-LD
 * nằm trong <script type="application/ld+json"> - gọi sau parse() thì mọi field
 * đều null mà không báo lỗi gì. Đây là bẫy im lặng, đừng đảo thứ tự.
 */
function harvestMeta(doc: AnyDocument, baseUrl: string): HarvestedMeta {
  const ld = findLdArticle(doc);
  const publisher = ld?.publisher;
  const publisherName =
    publisher && typeof publisher === "object"
      ? textOrNull(String((publisher as { name?: unknown }).name ?? ""))
      : null;

  const ogImage =
    metaContent(doc, 'meta[property="og:image"]') ??
    metaContent(doc, 'meta[property="og:image:url"]') ??
    metaContent(doc, 'meta[name="twitter:image"]') ??
    ldImageUrl(ld?.image);

  return {
    title:
      metaContent(doc, 'meta[property="og:title"]') ??
      textOrNull(typeof ld?.headline === "string" ? ld.headline : null) ??
      textOrNull(doc.querySelector("title")?.textContent),
    byline:
      ldAuthorName(ld?.author) ??
      metaContent(doc, 'meta[name="author"]') ??
      metaContent(doc, 'meta[property="article:author"]'),
    siteName: metaContent(doc, 'meta[property="og:site_name"]') ?? publisherName,
    publishedTime:
      metaContent(doc, 'meta[property="article:published_time"]') ??
      textOrNull(typeof ld?.datePublished === "string" ? ld.datePublished : null) ??
      metaContent(doc, 'meta[itemprop="datePublished"]'),
    canonicalUrl:
      absUrl(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), baseUrl) ??
      absUrl(metaContent(doc, 'meta[property="og:url"]'), baseUrl),
    leadImage: absUrl(ogImage, baseUrl),
    lang:
      textOrNull(doc.documentElement?.getAttribute("lang")) ??
      textOrNull(typeof ld?.inLanguage === "string" ? ld.inLanguage : null) ??
      textOrNull(metaContent(doc, 'meta[property="og:locale"]')),
  };
}

/* ---------- Tách đoạn + lọc rác ---------- */

interface Block {
  tag: string;
  text: string;
}

const BLOCK_SELECTOR = "p, h2, h3, h4, li, blockquote, figcaption";

function toBlocks(contentHtml: string): Block[] {
  const { document } = parseHTML(`<body>${contentHtml}</body>`);
  return [...document.querySelectorAll(BLOCK_SELECTOR)]
    .map((el) => ({
      tag: String(el.tagName || "").toLowerCase(),
      text: norm(el.textContent),
    }))
    .filter((b) => b.text.length > 0);
}

/** Chữ điều hướng/chia sẻ đứng đầu hoặc cuối bài - không phải nội dung */
const JUNK_RE =
  /^(đọc tiếp|về trang|chủ đề|xem thêm|tags?|chia sẻ|bình luận|theo dõi|nguồn|link gốc|copy link)/i;
/** Quảng cáo chân bài: link, email liên hệ, "liên hệ Ms ..." */
const PROMO_RE = /(https?:\/\/|@[a-z0-9.-]+\.(vn|com)|liên hệ ms|email\s)/i;

/**
 * Lọc rác quanh phần nội dung thật. Ba bước, mỗi bước sinh ra từ một lỗi đo được:
 * danh sách điều hướng của vnexpress lọt vào dạng <li> ngắn, figcaption của
 * tuoitre bị lặp lại thành <p> ngay dưới, và cafef gắn khối quảng cáo cuối bài.
 */
function cleanBlocks(blocks: Block[]): Block[] {
  let b = blocks.slice();
  // 1. <li> ngắn không có dấu câu = mục menu/danh sách bài liên quan, không phải câu văn
  b = b.filter((x) => !(x.tag === "li" && x.text.length < 60 && !/[.!?:;]/.test(x.text)));
  // 2. bỏ đoạn trùng LIÊN TIẾP (chỉ liên tiếp - một câu lặp lại xa nhau vẫn có thể là dụng ý)
  b = b.filter((x, i) => i === 0 || x.text !== b[i - 1].text);
  // 3. cắt rác chỉ ở ĐẦU và CUỐI: một đoạn ngắn nằm giữa bài thường là câu chuyển ý thật
  const keep = (x: Block): boolean =>
    x.text.length >= 40 && !JUNK_RE.test(x.text) && !PROMO_RE.test(x.text);
  while (b.length && !keep(b[0]) && b[0].tag !== "h2" && b[0].tag !== "h3") b.shift();
  while (b.length && (!keep(b[b.length - 1]) || isTrailingHeadline(b[b.length - 1]))) b.pop();
  return b;
}

/**
 * Đoạn CUỐI là tiêu đề bài liên quan chứ không phải câu kết?
 *
 * tienphong.vn nhét khối "tin liên quan" vào cuối phần nội dung, mỗi tin là một
 * <p> dài 70-90 ký tự nên lọt qua ngưỡng 40. Dấu hiệu phân biệt: câu văn thật
 * luôn đóng bằng dấu câu, tiêu đề thì không. Chỉ soi ở đuôi và chừa
 * figcaption/blockquote - chú thích ảnh cuối bài vốn không có dấu chấm.
 */
function isTrailingHeadline(x: Block): boolean {
  if (x.tag === "figcaption" || x.tag === "blockquote") return false;
  return x.text.length < 140 && !/[.!?…:"”'’)»\]]$/.test(x.text);
}

/**
 * Ảnh trong bài - thứ tự ưu tiên data-original → data-src → srcset → src.
 * dantri (và phần lớn báo Việt) lazy-load: `src` chỉ là ảnh placeholder dạng
 * data: URI 1x1, ảnh thật nằm ở data-original/data-src.
 */
function pickImageSrc(el: NonNullable<AnyElement>): string | null {
  const srcset = el.getAttribute("srcset");
  const fromSrcset = srcset ? srcset.split(",")[0]?.trim().split(/\s+/)[0] : null;
  const candidates = [
    el.getAttribute("data-original"),
    el.getAttribute("data-src"),
    fromSrcset,
    el.getAttribute("src"),
  ];
  for (const c of candidates) {
    const v = (c || "").trim();
    if (v && !/^data:/i.test(v)) return v;
  }
  return null;
}

function firstImageIn(contentHtml: string, baseUrl: string): string | null {
  const { document } = parseHTML(`<body>${contentHtml}</body>`);
  for (const img of document.querySelectorAll("img")) {
    const src = absUrl(pickImageSrc(img), baseUrl);
    if (src) return src;
  }
  return null;
}

/* ---------- Bóc bài ---------- */

/** Dưới ngưỡng này thì coi như không bóc được - bài thật ngắn nhất đo được vẫn > 900 ký tự */
const MIN_TEXT_CHARS = 500;

function extractFailed(): HttpError {
  return new HttpError(
    422,
    "EXTRACT_FAILED",
    `Không bóc được nội dung bài viết từ trang này (trang có thể chặn bot, cần đăng nhập, hoặc dựng nội dung bằng JavaScript). ${PASTE_HINT}`,
  );
}

/**
 * Bóc bài từ HTML đã có sẵn. `baseUrl` dùng để giải link tương đối (ảnh, canonical),
 * nên truyền URL SAU redirect chứ không phải URL người dùng dán.
 */
export function extractArticleFromHtml(html: string, baseUrl: string): ExtractedArticle {
  const { document } = parseHTML(html);

  // Thứ tự bắt buộc: metadata → kiểm tra readerable → parse. Readability sửa đổi
  // trực tiếp document (xóa script, gỡ node phụ), làm sau là làm trên xác.
  const meta = harvestMeta(document, baseUrl);
  const readerable = isProbablyReaderable(document as unknown as Document, {
    minContentLength: 140,
    minScore: 20,
  });

  const article = new Readability(document as unknown as Document, {
    keepClasses: false,
  }).parse();
  const contentHtml = article?.content || "";
  const text = norm(article?.textContent);

  /**
   * HAI tín hiệu, không phải một. Trang "Are you a robot?" của Bloomberg trả 200
   * kèm hơn 500 ký tự chữ nên vượt qua ngưỡng độ dài, nhưng isProbablyReaderable
   * thì trượt. Chỉ đủ ký tự KHÔNG có nghĩa là bóc được bài.
   */
  if (!readerable || text.length < MIN_TEXT_CHARS) throw extractFailed();

  const title =
    textOrNull(article?.title) ?? meta.title ?? textOrNull(document.title) ?? "Bài viết";

  const blocks = cleanBlocks(toBlocks(contentHtml)).map((b) => b.text);
  // vnexpress để tiêu đề bài ngay trong khối nội dung, Readability giữ lại nên
  // block[0] trùng y hệt title - dựng ra sẽ thành hai scene đọc cùng một câu.
  if (blocks.length > 1 && blocks[0] === title) blocks.shift();
  if (blocks.length === 0) throw extractFailed();

  return {
    title,
    blocks,
    byline: meta.byline ?? textOrNull(article?.byline),
    siteName: meta.siteName ?? textOrNull(article?.siteName) ?? hostnameOf(baseUrl),
    publishedTime: meta.publishedTime ?? textOrNull(article?.publishedTime),
    canonicalUrl: meta.canonicalUrl ?? baseUrl,
    leadImage: meta.leadImage ?? firstImageIn(contentHtml, baseUrl),
    lang: meta.lang ?? textOrNull(article?.lang),
    chars: blocks.reduce((sum, b) => sum + b.length, 0),
  };
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Thông báo tiếng Việt cho từng lý do safeFetchHtml từ chối - lỗi kỹ thuật trần thì người dùng không sửa được */
function fetchErrorMessage(err: SafeFetchError): string {
  switch (err.code) {
    case "BAD_URL":
    case "BAD_SCHEME":
      return `Link không hợp lệ: ${err.message}. Hãy dán link http hoặc https đầy đủ.`;
    case "BAD_PORT":
    case "BLOCKED_IP":
      return `Link trỏ vào địa chỉ nội bộ nên bị chặn (${err.message}). Chỉ dán link bài viết công khai trên Internet.`;
    case "BAD_CONTENT_TYPE":
      return `Link không trỏ tới một trang bài viết (${err.message}). ${PASTE_HINT}`;
    case "TOO_LARGE":
      return `Trang quá lớn để tải về. ${PASTE_HINT}`;
    case "HTTP_ERROR":
      return `Trang trả lỗi ${err.status ?? ""} - có thể bài đã bị gỡ hoặc chặn truy cập tự động. ${PASTE_HINT}`;
    case "DNS_FAIL":
      return `Không tìm thấy tên miền trong link. Kiểm tra lại link đã dán đúng chưa.`;
    case "TOO_MANY_REDIRECTS":
      return `Link chuyển hướng vòng vo quá nhiều lần. ${PASTE_HINT}`;
    default:
      return `Không tải được trang (${err.message}). ${PASTE_HINT}`;
  }
}

/** Mã lỗi do người dùng dán sai/dán link cấm → 400; còn lại là lỗi phía trang nguồn → 502 */
const USER_FAULT_CODES = new Set([
  "BAD_URL",
  "BAD_SCHEME",
  "BAD_PORT",
  "BLOCKED_IP",
  "BAD_CONTENT_TYPE",
]);

/** Tải trang rồi bóc bài. Mọi lỗi ném ra đều là HttpError có thông báo tiếng Việt. */
export async function extractArticleFromUrl(url: string): Promise<ExtractedArticle> {
  let fetched;
  try {
    fetched = await safeFetchHtml(url);
  } catch (err) {
    if (err instanceof SafeFetchError) {
      const status = USER_FAULT_CODES.has(err.code) ? 400 : 502;
      throw new HttpError(status, `FETCH_${err.code}`, fetchErrorMessage(err));
    }
    throw new HttpError(
      502,
      "FETCH_FAILED",
      `Không tải được trang: ${(err as Error).message}. ${PASTE_HINT}`,
    );
  }
  // Tín hiệu thứ nhất trong hai tín hiệu phát hiện bóc hỏng (xem extractArticleFromHtml)
  if (fetched.status !== 200) throw extractFailed();
  return extractArticleFromHtml(fetched.html, fetched.finalUrl);
}
