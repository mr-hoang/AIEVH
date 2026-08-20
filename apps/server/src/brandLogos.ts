import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { HttpError } from "./util.js";

/**
 * Thư viện logo brand dùng chung (`assets/brand-logos/`).
 *
 * Có sẵn để lúc dựng video cần nhắc tới Facebook / TikTok / Claude... thì lấy
 * đúng file logo chính thức, thay vì tự vẽ lại hay nhờ Gemini sinh ra - logo
 * sai nhận diện là lỗi người xem nhìn ra ngay.
 *
 * File tải bằng `node scripts/fetch-brand-logos.mjs` từ Simple Icons (CC0-1.0).
 * CC0 áp cho FILE, không phải cho quyền nhãn hiệu - xem `notice` trong
 * library.json.
 */

export interface BrandLogo {
  slug: string;
  title: string;
  /** Mã màu chính thức của brand, vd "#0866FF" - null với file người dùng tự thêm */
  color: string | null;
  /** Tên file trong assets/brand-logos/ */
  file: string;
  source?: string | null;
  addedByUser?: boolean;
}

export interface BrandLogoLibrary {
  generatedAt: string;
  source: string;
  license: string;
  notice: string;
  count: number;
  icons: BrandLogo[];
}

export function brandLogosDir(): string {
  return path.join(paths.assetsDir, "brand-logos");
}

function libraryPath(): string {
  return path.join(brandLogosDir(), "library.json");
}

/** Đọc danh mục; thiếu file hay hỏng JSON thì trả rỗng chứ không ném lỗi - thư
 * viện logo không có thì video vẫn dựng được, chỉ là thiếu logo brand. */
export function readBrandLogos(): BrandLogo[] {
  try {
    const raw = JSON.parse(fs.readFileSync(libraryPath(), "utf8")) as Partial<BrandLogoLibrary>;
    if (!Array.isArray(raw.icons)) return [];
    // Chỉ giữ mục có file thật trên đĩa - danh mục cũ hơn thư mục là chuyện
    // thường (ai đó xóa bớt file), mà bảo agent dùng file không tồn tại thì nó
    // sẽ loay hoay rồi tự chế logo, đúng cái ta muốn tránh.
    return raw.icons.filter(
      (i): i is BrandLogo =>
        Boolean(i && typeof i.file === "string" && i.file) &&
        fs.existsSync(path.join(brandLogosDir(), i.file)),
    );
  } catch {
    return [];
  }
}

export function countBrandLogos(): number {
  return readBrandLogos().length;
}

// ---------------------------------------------------------------------------
// Tự tìm logo trên mạng khi thư viện chưa có
// ---------------------------------------------------------------------------

/**
 * Chỉ tải từ đúng những host này. Đây KHÔNG phải URL người dùng dán vào (nên
 * không đi qua safeFetch.ts, thứ dựng cho URL không tin được và trả text nên
 * làm hỏng file PNG) - URL ở đây do chính server dựng từ TÊN brand. Rủi ro thật
 * sự là redirect lạc sang chỗ khác, nên chặn bằng allowlist ở TỪNG chặng.
 */
const ALLOWED_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "www.wikidata.org",
  "commons.wikimedia.org",
  "upload.wikimedia.org",
]);

/** Wikimedia yêu cầu User-Agent có thông tin liên hệ, thiếu là bị chặn (đã dính) */
const UA = "AIEV/1.0 (https://github.com/mr-hoang/AIEVH; brand logo fetch)";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Danh mục Simple Icons đầy đủ (3400+) - cache trong tiến trình, làm mới sau 24h */
let iconIndex: { at: number; list: Array<{ slug: string; title: string; hex: string }> } | null =
  null;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\+/g, "plus")
    .replace(/\./g, "dot")
    .replace(/[^a-z0-9]/g, "");
}

async function fetchAllowed(url: string, accept: string): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
    throw new HttpError(400, "LOGO_HOST_BLOCKED", `Không tải logo từ host lạ: ${u.hostname}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // redirect thủ công để kiểm allowlist ở TỪNG chặng (Commons luôn nhảy sang
    // upload.wikimedia.org, nhưng không vì thế mà cho nhảy đi bất kỳ đâu)
    let current = u;
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current.href, {
        headers: { "user-agent": UA, accept },
        redirect: "manual",
        signal: ctrl.signal,
      });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, current);
        if (next.protocol !== "https:" || !ALLOWED_HOSTS.has(next.hostname)) {
          throw new HttpError(
            400,
            "LOGO_HOST_BLOCKED",
            `Logo chuyển hướng sang host lạ: ${next.hostname}`,
          );
        }
        current = next;
        continue;
      }
      return res;
    }
    throw new HttpError(502, "LOGO_TOO_MANY_REDIRECTS", "Tải logo bị chuyển hướng vòng vo");
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response): Promise<Buffer> {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_LOGO_BYTES) {
    throw new HttpError(502, "LOGO_TOO_LARGE", `File logo lớn hơn ${MAX_LOGO_BYTES} bytes`);
  }
  return buf;
}

/**
 * Khử trùng SVG trước khi ghi xuống đĩa.
 *
 * BẮT BUỘC, không phải cẩn thận thừa: file trên Wikimedia Commons do người dùng
 * tự upload, mà SVG là XML CHẠY ĐƯỢC - thẻ <script>, thuộc tính onload, hay
 * <image href="http://..."> đều sống được. File này sau đó được nạp vào Chromium
 * lúc HyperFrames/Remotion render, tức là chạy ngay trên máy người dùng.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*script[^>]*\/\s*>/gi, "")
    .replace(/<\s*foreignObject[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, "")
    .replace(/<\s*(iframe|object|embed|audio|video)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    // on* handler: onload=, onclick=... (cả nháy đơn, nháy kép và không nháy)
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // javascript: trong href/xlink:href/src
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    // tham chiếu ra ngoài: logo phải tự chứa, không được gọi mạng lúc render
    .replace(/(href|src)\s*=\s*(["'])\s*https?:\/\/[^"']*\2/gi, '$1="#"');
}

interface Downloaded {
  buf: Buffer;
  ext: string;
  source: string;
  license: string;
  color: string | null;
}

async function loadIconIndex(): Promise<Array<{ slug: string; title: string; hex: string }>> {
  if (iconIndex && Date.now() - iconIndex.at < INDEX_TTL_MS) return iconIndex.list;
  const res = await fetchAllowed(
    "https://cdn.jsdelivr.net/npm/simple-icons@latest/data/simple-icons.json",
    "application/json",
  );
  if (!res.ok) throw new HttpError(502, "LOGO_INDEX_FAILED", `Simple Icons trả ${res.status}`);
  const raw = (await res.json()) as unknown;
  const arr = (Array.isArray(raw) ? raw : (raw as { icons?: unknown[] }).icons) ?? [];
  const list = (arr as Array<{ slug?: string; title: string; hex: string }>).map((i) => ({
    slug: i.slug ?? slugify(i.title),
    title: i.title,
    hex: i.hex,
  }));
  iconIndex = { at: Date.now(), list };
  return list;
}

/** Tầng 1: Simple Icons - sạch, nhất quán, CC0. Trả null nếu không có brand này. */
async function fromSimpleIcons(name: string): Promise<(Downloaded & { title: string }) | null> {
  const want = slugify(name);
  let list: Array<{ slug: string; title: string; hex: string }>;
  try {
    list = await loadIconIndex();
  } catch {
    return null; // mạng lỗi - để tầng sau thử
  }
  const hit =
    list.find((i) => i.slug === want) ??
    list.find((i) => slugify(i.title) === want) ??
    null;
  if (!hit) return null;
  const res = await fetchAllowed(
    `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${hit.slug}.svg`,
    "image/svg+xml",
  );
  if (!res.ok) return null;
  const buf = await readCapped(res);
  if (!buf.toString("utf8").includes("<svg")) return null;
  return {
    buf,
    ext: ".svg",
    source: "https://simple-icons.org",
    license: "CC0-1.0 (file SVG; KHÔNG áp cho quyền nhãn hiệu)",
    color: `#${hit.hex}`,
    title: hit.title,
  };
}

/**
 * Tầng 2: Wikidata thuộc tính P154 ("logo image") -> file trên Wikimedia Commons.
 *
 * PHẢI CHỌN ĐÚNG BẢN, đừng lấy claim đầu tiên: Microsoft có 4 claim và cái đầu
 * là logo NĂM 1980. Quy tắc đã kiểm: bỏ bản có P582 (ngày ngừng dùng), ưu tiên
 * rank "preferred", rồi tới P580 (ngày bắt đầu) mới nhất, cuối cùng ưu tiên SVG.
 * Với quy tắc này Microsoft ra bản 2012, Google ra bản 2026, Amazon ra bản 2024.
 */
async function fromWikidata(name: string): Promise<(Downloaded & { title: string }) | null> {
  const search = await fetchAllowed(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
      name,
    )}&language=en&format=json&limit=5`,
    "application/json",
  );
  if (!search.ok) return null;
  const sd = (await search.json()) as { search?: Array<{ id: string; label?: string }> };

  const timeOf = (q: Record<string, Array<{ datavalue?: { value?: { time?: string } } }>> | undefined, pid: string): string | null => {
    const t = q?.[pid]?.[0]?.datavalue?.value?.time;
    return t ? String(t).replace(/^\+/, "") : null;
  };

  for (const hit of sd.search ?? []) {
    const cr = await fetchAllowed(
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${encodeURIComponent(
        hit.id,
      )}&property=P154&format=json`,
      "application/json",
    );
    if (!cr.ok) continue;
    const cd = (await cr.json()) as {
      claims?: {
        P154?: Array<{
          rank?: string;
          mainsnak?: { datavalue?: { value?: string } };
          qualifiers?: Record<string, Array<{ datavalue?: { value?: { time?: string } } }>>;
        }>;
      };
    };
    const claims = cd.claims?.P154 ?? [];
    if (claims.length === 0) continue;

    const scored = claims
      .map((c) => ({
        file: c.mainsnak?.datavalue?.value ?? "",
        rank: c.rank ?? "normal",
        start: timeOf(c.qualifiers, "P580"),
        end: timeOf(c.qualifiers, "P582"),
      }))
      .filter((c) => c.file && c.rank !== "deprecated");
    if (scored.length === 0) continue;
    const live = scored.filter((c) => !c.end);
    const pool = live.length > 0 ? live : scored;
    pool.sort(
      (a, b) =>
        (b.rank === "preferred" ? 1 : 0) - (a.rank === "preferred" ? 1 : 0) ||
        String(b.start ?? "").localeCompare(String(a.start ?? "")) ||
        (/\.svg$/i.test(b.file) ? 1 : 0) - (/\.svg$/i.test(a.file) ? 1 : 0),
    );
    const best = pool[0];
    const ext = path.extname(best.file).toLowerCase();
    if (![".svg", ".png"].includes(ext)) continue;

    const fileRes = await fetchAllowed(
      `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(best.file)}`,
      "image/svg+xml,image/png",
    );
    if (!fileRes.ok) continue;
    const buf = await readCapped(fileRes);
    if (ext === ".svg" && !buf.toString("utf8").includes("<svg")) continue;
    return {
      buf,
      ext,
      source: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(best.file)}`,
      // Logo doanh nghiệp trên Commons thường là "trademarked" - file dùng lại
      // được nhưng NHÃN HIỆU vẫn của chủ sở hữu. Ghi lại nguồn để còn tra.
      license: "Wikimedia Commons (xem trang file); nhãn hiệu thuộc chủ sở hữu",
      color: null,
      title: hit.label ?? name,
    };
  }
  return null;
}

export interface ResolvedBrandLogo extends BrandLogo {
  /** true = vừa tải mới về, false = đã có sẵn trong thư viện */
  added: boolean;
}

/**
 * Tìm logo của một brand: thư viện có sẵn -> Simple Icons -> Wikidata.
 * Không thấy thì NÉM LỖI - tuyệt đối không trả về thứ gì đó "gần giống", vì
 * cái đích của toàn bộ tính năng này là không bao giờ có logo bịa.
 */
export async function resolveBrandLogo(rawName: string): Promise<ResolvedBrandLogo> {
  const name = rawName.trim();
  if (!name) throw new HttpError(400, "BRAND_NAME_REQUIRED", "Thiếu tên brand cần tìm logo");
  if (name.length > 60) {
    throw new HttpError(400, "BRAND_NAME_TOO_LONG", "Tên brand dài quá 60 ký tự");
  }
  const want = slugify(name);
  if (!want) {
    throw new HttpError(400, "BRAND_NAME_INVALID", `Tên brand không hợp lệ: "${name}"`);
  }

  // 1. Đã có trong thư viện
  const existing = readBrandLogos();
  const hit =
    existing.find((l) => l.slug === want) ??
    existing.find((l) => slugify(l.title) === want) ??
    null;
  if (hit) return { ...hit, added: false };

  // 2 + 3. Tải về
  const got = (await fromSimpleIcons(name)) ?? (await fromWikidata(name));
  if (!got) {
    throw new HttpError(
      404,
      "BRAND_LOGO_NOT_FOUND",
      `Không tìm được logo chính thức của "${name}" ở cả Simple Icons lẫn Wikidata. ` +
        "TUYỆT ĐỐI KHÔNG tự vẽ hay nhờ AI sinh logo: hãy viết tên brand bằng chữ (font của " +
        "Style Design) và ghi vào báo cáo cuối. Muốn có logo thì tải file chính thức từ trang " +
        "brand rồi bỏ vào assets/brand-logos/.",
    );
  }

  const dir = brandLogosDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${want}${got.ext}`;
  const data =
    got.ext === ".svg" ? Buffer.from(sanitizeSvg(got.buf.toString("utf8")), "utf8") : got.buf;
  fs.writeFileSync(path.join(dir, file), data);

  const entry: BrandLogo = {
    slug: want,
    title: got.title,
    color: got.color,
    file,
    source: got.source,
  };
  appendToLibrary(entry, got.license);
  return { ...entry, added: true };
}

/** Ghi mục mới vào library.json, giữ nguyên phần còn lại của danh mục. */
function appendToLibrary(entry: BrandLogo, license: string): void {
  const p = path.join(brandLogosDir(), "library.json");
  let lib: BrandLogoLibrary;
  try {
    lib = JSON.parse(fs.readFileSync(p, "utf8")) as BrandLogoLibrary;
  } catch {
    lib = {
      generatedAt: new Date().toISOString(),
      source: "https://simple-icons.org",
      license: "CC0-1.0 (áp cho file SVG, KHÔNG áp cho quyền nhãn hiệu của brand)",
      notice: "Logo là nhãn hiệu của chủ sở hữu.",
      count: 0,
      icons: [],
    };
  }
  const icons = (lib.icons ?? []).filter((i) => i.slug !== entry.slug);
  // Mục tải tự động mang theo giấy phép RIÊNG (Commons khác Simple Icons) -
  // gộp chung một dòng license ở đầu file là ghi sai nguồn gốc.
  icons.push({ ...entry, license } as BrandLogo & { license: string });
  icons.sort((a, b) => a.title.localeCompare(b.title));
  lib.icons = icons;
  lib.count = icons.length;
  lib.generatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(lib, null, 2) + "\n", "utf8");
}
