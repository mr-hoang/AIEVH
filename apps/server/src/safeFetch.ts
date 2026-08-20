import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

/**
 * Tải HTML từ một URL NGƯỜI DÙNG DÁN VÀO - chống SSRF.
 *
 * VÌ SAO phải làm chặt tới mức này thay vì gọi thẳng fetch(): server này cho
 * request đến từ loopback đi thẳng không cần token (index.ts -> isLocalRequest),
 * và `GET /api/health` trả luôn API token cho người gọi loopback. Một request do
 * chính server phát ra LÀ loopback. Nên nếu để người dùng dán
 * "http://127.0.0.1:6869/api/health" thì đó không phải rò rỉ thông tin nữa, mà
 * là mất trắng quyền điều khiển backend. Hai lớp bắt buộc:
 *
 * 1. GHIM IP (pin): phân giải DNS một lần, kiểm tra, rồi ép socket nối đúng IP
 *    đó qua option `lookup`. Không ghim thì kẻ tấn công dựng domain trả IP công
 *    cộng lúc mình kiểm tra và trả 127.0.0.1 lúc Node nối thật (DNS rebinding).
 * 2. KIỂM LẠI TỪNG CHẶNG redirect: 302 sang http://127.0.0.1:6869 là đường vòng
 *    kinh điển. Mỗi hop đều chạy lại validateUrl + resolvePinned.
 *
 * Hai thứ này là cơ chế bảo vệ, không phải trang trí - đừng lược bớt để cho gọn.
 */

/** Chrome thật: cafef.vn trả 503 nếu user-agent trống hoặc lộ là bot */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TOTAL_TIMEOUT_MS = 15_000;
/** Không nhận được byte nào trong khoảng này thì cắt - chặn slow-loris giữ socket */
const SOCKET_IDLE_MS = 8_000;

/**
 * Mã lỗi. Tám mã đầu là bộ tối thiểu mà tầng route dựa vào; ba mã cuối là các
 * tình huống không nhét vừa mã nào ở trên (nhét bừa sẽ làm thông báo sai sự thật).
 */
export type SafeFetchCode =
  | "BAD_SCHEME"
  | "BAD_URL"
  | "BAD_PORT"
  | "BLOCKED_IP"
  | "TOO_LARGE"
  | "BAD_CONTENT_TYPE"
  | "CONNECT_TIMEOUT"
  | "HTTP_ERROR"
  | "DNS_FAIL"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS";

export class SafeFetchError extends Error {
  /** Khai báo `string` (không phải union) để nơi gọi so sánh mã tự do, không vướng type */
  public code: string;
  /** Mã HTTP thật khi code = HTTP_ERROR - null với lỗi xảy ra trước khi có phản hồi */
  public status: number | null;

  constructor(code: SafeFetchCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface SafeFetchResult {
  html: string;
  /** URL sau khi đi hết chuỗi redirect - dùng làm base để giải link tương đối */
  finalUrl: string;
  status: number;
  /** Toàn bộ chuỗi URL đã đi qua, kể cả URL gốc - tiện ghi log khi soi lỗi */
  chain: string[];
}

/* ---------- Phân loại IP ---------- */

function ip4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => ((a << 8) >>> 0) + Number(o), 0) >>> 0;
}

/**
 * Các dải IPv4 KHÔNG được phép nối tới. Ngoài loopback/LAN còn phải chặn
 * 169.254.0.0/16 (metadata service của cloud - nguồn rò credential kinh điển)
 * và 100.64.0.0/10 (CGNAT, hay là mạng nội bộ của nhà mạng).
 */
const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPrivateV4(ip: string): boolean {
  const n = ip4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ip4ToInt(base) & mask);
  });
}

function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (a === "::" || a === "::1") return true;
  // IPv4-mapped / IPv4-compatible: ::ffff:127.0.0.1 vẫn nối tới loopback
  const m = a.match(/^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateV4(m[2]);
  if (a.startsWith("64:ff9b::")) return true; // NAT64 - bọc được IPv4 nội bộ
  if (/^f[cd]/.test(a)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(a)) return true; // fe80::/10 link local
  if (/^ff/.test(a)) return true; // ff00::/8 multicast
  if (a.startsWith("2002:")) return true; // 6to4 - bọc được IPv4 nội bộ
  if (a.startsWith("2001:0:") || a.startsWith("2001:db8")) return true;
  return false;
}

/** Mặc định TỪ CHỐI: chuỗi không phải IP hợp lệ cũng coi như bị chặn */
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true;
}

/* ---------- Kiểm tra URL ---------- */

const INTERNAL_HOST_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/** Cổng cho phép. Chặn 22/25/6379... để không biến server thành cầu quét cổng nội bộ */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

export function validateUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError("BAD_URL", "URL không hợp lệ");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SafeFetchError(
      "BAD_SCHEME",
      `Chỉ hỗ trợ http/https, không hỗ trợ ${u.protocol.replace(":", "")}`,
    );
  }
  // user:pass@host là mồi lừa parser (và lộ credential vào log)
  if (u.username || u.password) {
    throw new SafeFetchError("BAD_URL", "URL không được chứa user:pass");
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw new SafeFetchError("BAD_PORT", `Cổng ${port} không được phép`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new SafeFetchError("BLOCKED_IP", `Địa chỉ nội bộ bị chặn: ${host}`);
  }
  if (INTERNAL_HOST_RE.test(u.hostname)) {
    throw new SafeFetchError("BLOCKED_IP", `Tên miền nội bộ bị chặn: ${u.hostname}`);
  }
  return u;
}

/* ---------- Phân giải + ghim IP ---------- */

interface PinnedAddress {
  address: string;
  family: number;
}

async function resolvePinned(hostname: string): Promise<PinnedAddress> {
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SafeFetchError("BLOCKED_IP", `IP nội bộ: ${hostname}`);
    }
    return { address: hostname, family: net.isIP(hostname) };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError("DNS_FAIL", `Không phân giải được tên miền: ${hostname}`);
  }
  if (records.length === 0) {
    throw new SafeFetchError("DNS_FAIL", `Không có bản ghi A/AAAA: ${hostname}`);
  }
  // MỌI bản ghi phải công cộng, không chỉ bản ghi đầu: domain trả về nhiều IP
  // (một công cộng, một 127.0.0.1) là cách né kiểm tra nếu chỉ soi record[0].
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw new SafeFetchError(
        "BLOCKED_IP",
        `${hostname} trỏ về địa chỉ nội bộ (${r.address})`,
      );
    }
  }
  return { address: records[0].address, family: records[0].family };
}

/* ---------- Một chặng ---------- */

interface HopResult {
  redirect?: URL;
  status?: number;
  html?: string;
}

function requestOnce(u: URL, pinned: PinnedAddress, deadline: number): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const options: https.RequestOptions = {
      protocol: u.protocol,
      host: u.hostname, // giữ hostname cho SNI + header Host, IP thật do lookup bên dưới quyết
      servername: net.isIP(u.hostname) ? undefined : u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET", // KHÔNG dùng HEAD dò trước: vnexpress trả 406 cho HEAD nhưng 200 cho GET
      /**
       * GHIM IP: không bao giờ phân giải lại. Đây là chỗ chặn DNS rebinding -
       * giữa lúc resolvePinned kiểm tra và lúc socket nối, TTL=0 cho phép domain
       * đổi sang 127.0.0.1. Node gọi hàm này theo hai kiểu: có opts.all (chờ
       * mảng) và không có (chờ 3 tham số) - phải đỡ cả hai.
       */
      lookup: (_hostname, opts, cb) => {
        if (opts && (opts as { all?: boolean }).all) {
          cb(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          (cb as (e: null, a: string, f: number) => void)(
            null,
            pinned.address,
            pinned.family,
          );
        }
      },
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "accept-language": "vi,en;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        host: u.host,
      },
    };

    const req = mod.request(options, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.destroy();
        let next: URL;
        try {
          next = new URL(location, u);
        } catch {
          reject(new SafeFetchError("BAD_URL", `Link chuyển hướng không hợp lệ: ${location}`));
          return;
        }
        resolve({ redirect: next });
        return;
      }
      if (status >= 400) {
        res.destroy();
        reject(
          new SafeFetchError("HTTP_ERROR", `Máy chủ trả mã ${status}`, status),
        );
        return;
      }
      const ct = String(res.headers["content-type"] || "");
      if (ct && !/^(text\/html|application\/xhtml\+xml|text\/plain)/i.test(ct)) {
        res.destroy();
        reject(new SafeFetchError("BAD_CONTENT_TYPE", `Không phải trang HTML (${ct})`));
        return;
      }
      const declared = Number(res.headers["content-length"] || 0);
      if (declared > MAX_BYTES) {
        res.destroy();
        reject(new SafeFetchError("TOO_LARGE", `Trang quá lớn (${declared} bytes)`));
        return;
      }

      // Giải nén: đếm byte SAU giải nén, nếu đếm trước thì một file gzip 10KB
      // bung ra 2GB vẫn lọt (zip bomb).
      let stream: NodeJS.ReadableStream = res;
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

      const chunks: Buffer[] = [];
      let size = 0;
      res.setTimeout(SOCKET_IDLE_MS, () => {
        req.destroy(new SafeFetchError("CONNECT_TIMEOUT", "Máy chủ ngừng gửi dữ liệu"));
      });
      stream.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy(new SafeFetchError("TOO_LARGE", `Trang vượt quá ${MAX_BYTES} bytes`));
          return;
        }
        if (Date.now() > deadline) {
          req.destroy(new SafeFetchError("TIMEOUT", "Quá thời gian chờ"));
          return;
        }
        chunks.push(c);
      });
      stream.on("end", () => {
        resolve({ status, html: Buffer.concat(chunks).toString("utf8") });
      });
      stream.on("error", reject);
    });
    req.on("error", (err) => {
      // req.destroy(err) ở trên quay về đây - giữ nguyên SafeFetchError, đừng bọc lại
      if (err instanceof SafeFetchError) reject(err);
      else reject(new SafeFetchError("CONNECT_TIMEOUT", `Không kết nối được: ${err.message}`));
    });
    req.setTimeout(SOCKET_IDLE_MS, () => {
      req.destroy(new SafeFetchError("CONNECT_TIMEOUT", "Kết nối quá lâu"));
    });
    req.end();
  });
}

/* ---------- Công khai ---------- */

/** Tải HTML của một URL người dùng dán vào. Ném SafeFetchError nếu bị chặn hoặc hỏng. */
export async function safeFetchHtml(rawUrl: string): Promise<SafeFetchResult> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let u = validateUrl(rawUrl);
  const chain: string[] = [u.href];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() > deadline) throw new SafeFetchError("TIMEOUT", "Quá thời gian chờ");
    // Kiểm lại TỪNG chặng: 302 sang 127.0.0.1 hoặc sang domain rebinding
    // sẽ chết ở đây chứ không đi tiếp.
    const pinned = await resolvePinned(u.hostname);
    const out = await requestOnce(u, pinned, deadline);
    if (out.redirect) {
      u = validateUrl(out.redirect.href);
      chain.push(u.href);
      continue;
    }
    return { html: out.html ?? "", status: out.status ?? 0, finalUrl: u.href, chain };
  }
  throw new SafeFetchError("TOO_MANY_REDIRECTS", "Chuyển hướng quá nhiều lần");
}
