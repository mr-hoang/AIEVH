import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childEnv, repoRoot, upsertEnvVar } from "../config.js";
import { Router } from "express";
import { HttpError, killTree } from "../util.js";
import { hasLiveUploadSessions } from "./uploadSession.js";

/**
 * Quản lý Cloudflare Tunnel ngay trên web UI (trang Kết nối).
 * - Có TUNNEL_DOMAIN trong .env → named tunnel (cloudflared tunnel run <nhãn đầu domain>).
 * - Chưa có domain → Quick Tunnel (URL ngẫu nhiên *.trycloudflare.com, parse từ log).
 * Child cloudflared giữ ở module level - server tắt là tunnel tắt theo.
 */

type TunnelMode = "named" | "quick";

let child: ChildProcess | null = null;
let mode: TunnelMode | null = null;
/** URL Quick Tunnel parse được từ log (https://xxx.trycloudflare.com) */
let quickUrl: string | null = null;
/**
 * Tunnel này do modal QR "Kết nối điện thoại" bật lên (POST /start { auto: true })
 * hay do người dùng chủ động bật ở trang Kết nối?
 *
 * Chỉ tunnel `auto` mới bị tự tắt khi đóng modal / hết phiên upload. Tunnel bật
 * tay ở trang Kết nối thường dùng để vào dashboard từ xa - tắt trộm nó là cắt
 * mất đường về của chính người dùng.
 */
let autoStarted = false;
/** Ring buffer log cloudflared - giữ tối đa 20 dòng cuối */
const lastLog: string[] = [];
const LOG_MAX = 20;

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
// Hostname hợp lệ: các nhãn a-z0-9- (không bắt đầu/kết thúc bằng -), ít nhất 2 nhãn
const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function pushLog(chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    lastLog.push(s);
    if (lastLog.length > LOG_MAX) lastLog.splice(0, lastLog.length - LOG_MAX);
    // Quick Tunnel in URL ra log lúc khởi động - bắt lấy làm url hiện hành
    if (mode === "quick" && !quickUrl) {
      const m = QUICK_URL_RE.exec(s);
      if (m) quickUrl = m[0];
    }
  }
}

/**
 * Đường dẫn cloudflared: PATH (where/which) trước, rồi các vị trí cài chuẩn -
 * server chạy từ .command trên macOS có PATH tối giản KHÔNG chứa /opt/homebrew/bin.
 */
const CLOUDFLARED_KNOWN_PATHS =
  process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
        "C:\\Program Files\\cloudflared\\cloudflared.exe",
      ]
    : [
        path.join(repoRoot, "start", "bin", "cloudflared"), // start.sh tự tải về đây khi máy không có brew
        "/opt/homebrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
      ];

export function cloudflaredBin(): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    if (
      spawnSync(cmd, ["cloudflared"], { windowsHide: true, shell: true }).status === 0
    ) {
      return "cloudflared";
    }
  } catch {
    /* rơi xuống check đường dẫn cứng */
  }
  for (const p of CLOUDFLARED_KNOWN_PATHS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* thôi */
    }
  }
  return null;
}

function cloudflaredInstalled(): boolean {
  return cloudflaredBin() !== null;
}

/** Chuẩn hóa input người dùng thành hostname: bỏ protocol/path/khoảng trắng, lowercase */
function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .trim()
    .toLowerCase();
}

/** TUNNEL_DOMAIN hiện hành từ env (đã chuẩn hóa) - null nếu chưa cấu hình */
function envDomain(): string | null {
  const d = normalizeDomain(process.env.TUNNEL_DOMAIN ?? "");
  return d || null;
}

/**
 * Hostname Quick Tunnel đang chạy - /api/lan-info ưu tiên cái này hơn
 * TUNNEL_DOMAIN trong .env để QR "Kết nối điện thoại" tự dùng URL đang sống.
 */
export function quickTunnelHostname(): string | null {
  if (child && mode === "quick" && quickUrl) {
    try {
      return new URL(quickUrl).hostname;
    } catch {
      return null;
    }
  }
  return null;
}

/** Tắt tunnel + dọn state. Dùng chung cho POST /stop và watchdog. */
function stopTunnelNow(): void {
  if (child) killTree(child);
  child = null;
  mode = null;
  quickUrl = null;
  autoStarted = false;
}

/**
 * Lưới an toàn cho tunnel `auto`: modal QR đóng đúng cách thì client tự gọi
 * /stop, nhưng tab bị đóng đột ngột, mất mạng hay máy sập thì lời gọi đó không
 * bao giờ tới - và URL public cứ thế sống tiếp. Vòng canh này bắt nốt các ca đó.
 *
 * Điều kiện tắt: không còn phiên upload nào sống, và tình trạng đó kéo dài quá
 * GRACE_MS. Có khoảng ân hạn vì lúc mở modal có một nhịp ngắn token cũ vừa bị
 * thu hồi mà token mới chưa kịp tạo.
 */
const WATCHDOG_EVERY_MS = 30_000;
const GRACE_MS = 2 * 60_000;
let idleSince: number | null = null;

const watchdog = setInterval(() => {
  if (!child || !autoStarted) {
    idleSince = null;
    return;
  }
  if (hasLiveUploadSessions()) {
    idleSince = null;
    return;
  }
  if (idleSince === null) {
    idleSince = Date.now();
    return;
  }
  if (Date.now() - idleSince >= GRACE_MS) {
    pushLog("[tunnel] không còn phiên upload nào - tự tắt tunnel đã bật cho QR");
    stopTunnelNow();
    idleSince = null;
  }
}, WATCHDOG_EVERY_MS);
// Đừng giữ process sống chỉ vì cái timer này
watchdog.unref?.();

function statusPayload() {
  const domain = envDomain();
  return {
    installed: cloudflaredInstalled(),
    running: !!child,
    /** true = tunnel do modal QR bật, sẽ tự tắt khi đóng modal */
    auto: !!child && autoStarted,
    mode: child ? mode : null,
    url: child
      ? mode === "named"
        ? domain
          ? `https://${domain}`
          : null
        : quickUrl
      : null,
    domain,
    lastLog: [...lastLog],
  };
}

const router = Router();

// GET /api/tunnel - trạng thái cài đặt + tunnel đang chạy
router.get("/", (_req, res) => {
  res.json(statusPayload());
});

// PUT /api/tunnel/domain - { domain } (rỗng/null = xóa TUNNEL_DOMAIN)
router.put("/domain", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.domain;
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    throw new HttpError(400, "INVALID_DOMAIN", "domain phải là string hoặc null");
  }
  const domain = typeof raw === "string" ? normalizeDomain(raw) : "";
  if (domain && !HOSTNAME_RE.test(domain)) {
    throw new HttpError(
      400,
      "INVALID_DOMAIN",
      `"${domain}" không phải hostname hợp lệ - ví dụ đúng: aiev.example.com`,
    );
  }
  upsertEnvVar("TUNNEL_DOMAIN", domain || null);
  if (domain) process.env.TUNNEL_DOMAIN = domain;
  else delete process.env.TUNNEL_DOMAIN;
  res.json(statusPayload());
});

/**
 * POST /api/tunnel/start - spawn cloudflared (named nếu có domain, không thì quick)
 * Body { auto: true } = bật từ modal QR → sẽ tự tắt khi đóng modal / hết phiên upload.
 */
router.post("/start", (req, res) => {
  if (!cloudflaredInstalled()) {
    throw new HttpError(
      409,
      "NOT_INSTALLED",
      `Chưa cài cloudflared. Cài bằng: ${
        process.platform === "darwin"
          ? "brew install cloudflared"
          : "winget install --id Cloudflare.cloudflared"
      } - hoặc tải tại https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`,
    );
  }
  if (child) {
    throw new HttpError(409, "ALREADY_RUNNING", "Tunnel đang chạy rồi - tắt trước nếu muốn khởi động lại.");
  }

  const webPort = Number(process.env.WEB_PORT || 6868);
  const localUrl = `http://localhost:${webPort}`;
  const domain = envDomain();
  let args: string[];
  if (domain) {
    // Named tunnel - tên tunnel = nhãn đầu của domain (aiev.example.com → aiev),
    // giống start/tunnel.bat. Yêu cầu đã: cloudflared tunnel login/create/route dns.
    const name = domain.split(".")[0];
    mode = "named";
    args = ["tunnel", "run", "--url", localUrl, name];
  } else {
    mode = "quick";
    args = ["tunnel", "--url", localUrl];
  }

  quickUrl = null;
  autoStarted = (req.body as Record<string, unknown> | undefined)?.auto === true;
  idleSince = null;
  lastLog.length = 0;
  pushLog(`$ cloudflared ${args.join(" ")}`);

  // env: cloudflared ghi log/file tạm - dồn về .runtime/tmp (xem childEnv ở config.ts)
  const proc = spawn(cloudflaredBin() ?? "cloudflared", args, {
    windowsHide: true,
    env: childEnv(),
  });
  child = proc;
  proc.stdout?.on("data", (c: Buffer) => pushLog(c.toString("utf8")));
  proc.stderr?.on("data", (c: Buffer) => pushLog(c.toString("utf8")));
  proc.on("error", (err) => {
    pushLog(`[tunnel] không chạy được cloudflared: ${err.message}`);
    if (child === proc) {
      child = null;
      mode = null;
      quickUrl = null;
      autoStarted = false;
    }
  });
  proc.on("close", (code) => {
    pushLog(`[tunnel] cloudflared đã thoát (mã ${code ?? "?"})`);
    if (child === proc) {
      child = null;
      mode = null;
      quickUrl = null;
      autoStarted = false;
    }
  });

  res.status(202).json({ mode, auto: autoStarted });
});

/**
 * POST /api/tunnel/stop - kill cả cây process cloudflared.
 * Body { onlyAuto: true } = CHỈ tắt nếu tunnel do modal QR bật. Modal đóng lại
 * gửi cờ này để không lỡ tay tắt tunnel người dùng tự bật ở trang Kết nối.
 */
router.post("/stop", (req, res) => {
  const onlyAuto = (req.body as Record<string, unknown> | undefined)?.onlyAuto === true;
  if (onlyAuto && !autoStarted) {
    res.status(204).end();
    return;
  }
  stopTunnelNow();
  res.status(204).end();
});

export default router;
