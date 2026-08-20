import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { repoRoot } from "../config.js";
import { HttpError, execFileCaptureAll } from "../util.js";

/**
 * GET  /api/doctor      - tình trạng môi trường (ffmpeg, Chrome, whisper...)
 * POST /api/doctor/fix  - cài một mục còn thiếu
 *
 * Danh sách kiểm tra KHÔNG nằm ở đây: nó ở start/doctor.mjs, dùng chung với
 * start.ps1 và start.sh. Trước đây mỗi script tự kiểm tra nên đã lệch nhau.
 *
 * VÌ SAO spawn tiến trình con thay vì import thẳng doctor.mjs: mọi phép dò
 * trong đó là spawnSync (phải chạy được trước cả `npm install`, không có
 * dependency async nào). Chạy trong tiến trình server sẽ CHẶN event loop ~6s,
 * đủ để nghẽn SSE và vòng lặp hàng đợi render.
 *
 * KHÔNG đặt dưới /api/health: nhánh đó được middleware xác thực cho qua công
 * khai, mà endpoint cài phần mềm thì phải đứng sau token.
 */

const DOCTOR_JS = path.join(repoRoot, "start", "doctor.mjs");

/** Dò môi trường mất ~6s - nhiều tab cùng mở trang Cấu hình thì dùng lại kết quả */
const CACHE_MS = 20_000;
const PROBE_TIMEOUT_MS = 90_000;
/** winget/brew tải vài trăm MB - phải rộng tay */
const FIX_TIMEOUT_MS = 15 * 60_000;

export type DoctorLevel = "required" | "optional" | "info";
export type DoctorStatus = "ok" | "missing";

export interface DoctorFix {
  /** true = bấm một nút là xong, không cần gõ lệnh (web UI chỉ cho bấm mục này) */
  auto: boolean;
  size?: string;
  cmd?: [string, string[]];
  kind?: string;
  manual?: string;
  /** Lệnh chép-dán-chạy được (chỉ có ở mục mà cách sửa đúng là gõ một lệnh) */
  command?: string;
  /** Trang trong dashboard xử lý được việc này (vd /connections để dán API key) */
  link?: string;
  url?: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  level: DoctorLevel;
  status: DoctorStatus;
  /** Dữ liệu máy dò được: version, đường dẫn - KHÔNG dịch */
  detail: string;
  /** Mã ghi chú để web UI tự dịch (vd "module-missing") */
  note?: string | null;
  fix: DoctorFix | null;
}

export interface DoctorReport {
  platform: string;
  ok: boolean;
  missingRequired: string[];
  checks: DoctorCheck[];
}

let cached: { at: number; report: DoctorReport } | null = null;
/** Gộp các request đến cùng lúc vào một lần dò duy nhất */
let inflight: Promise<DoctorReport> | null = null;

async function probe(): Promise<DoctorReport> {
  if (!fs.existsSync(DOCTOR_JS)) {
    throw new HttpError(500, "DOCTOR_MISSING", "Không tìm thấy start/doctor.mjs");
  }
  const r = await execFileCaptureAll(process.execPath, [DOCTOR_JS, "--json"], {
    cwd: repoRoot,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (r.timedOut) {
    throw new HttpError(504, "DOCTOR_TIMEOUT", "Kiểm tra môi trường quá lâu");
  }
  try {
    return JSON.parse(r.stdout) as DoctorReport;
  } catch {
    throw new HttpError(
      500,
      "DOCTOR_BAD_OUTPUT",
      `Không đọc được kết quả kiểm tra: ${(r.stderr || r.stdout).slice(0, 300)}`,
    );
  }
}

async function getReport(force: boolean): Promise<DoctorReport> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  if (inflight) return inflight;
  inflight = probe()
    .then((report) => {
      cached = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Dò sẵn ngay sau khi server lên, để lần đầu mở trang Cấu hình có kết quả liền.
 * Không có bước này thì người dùng nhìn khung xám ~7 giây và tưởng trang hỏng.
 */
export function warmDoctorCache(): void {
  void getReport(false).catch(() => {
    // Không dò được lúc khởi động cũng không sao - request đầu tiên sẽ thử lại
  });
}

/** Chỉ cho một lệnh cài chạy tại một thời điểm - hai winget song song sẽ đá nhau */
let fixing: string | null = null;

const router = Router();

router.get("/", async (req, res) => {
  const report = await getReport(req.query.refresh === "1");
  res.json(report);
});

router.post("/fix", async (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  if (!id) throw new HttpError(400, "MISSING_ID", "Thiếu id mục cần cài");

  const report = await getReport(false);
  const check = report.checks.find((c) => c.id === id);
  if (!check) throw new HttpError(404, "UNKNOWN_CHECK", `Không có mục "${id}"`);
  if (check.status === "ok") {
    // Trả đủ shape như nhánh cài bên dưới - web coi thiếu `installed` là thất bại
    res.json({ ok: true, installed: true, timedOut: false, log: [], report });
    return;
  }
  // Chặn ở server chứ không chỉ ẩn nút trên UI: /api/doctor/fix là đường chạy
  // lệnh cài, chỉ được phép với đúng những mục doctor đã đánh dấu auto
  if (!check.fix?.auto) {
    throw new HttpError(
      400,
      "MANUAL_ONLY",
      `Mục "${id}" phải cài tay: ${check.fix?.manual ?? "-"}`,
    );
  }
  if (fixing) {
    throw new HttpError(409, "FIX_BUSY", `Đang cài "${fixing}" - đợi xong rồi thử lại`);
  }

  fixing = id;
  try {
    const r = await execFileCaptureAll(process.execPath, [DOCTOR_JS, "--fix-one", id], {
      cwd: repoRoot,
      timeoutMs: FIX_TIMEOUT_MS,
    });
    const log = `${r.stdout}\n${r.stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-40);
    // Dò lại ngay: lệnh chạy xong chưa chắc đã dò thấy (winget cài vào PATH của
    // tiến trình khác), nên trạng thái thật phải lấy từ lần dò mới.
    cached = null;
    const after = await getReport(true);
    const nowOk = after.checks.find((c) => c.id === id)?.status === "ok";
    res.json({
      ok: r.code === 0 && nowOk,
      installed: nowOk,
      timedOut: r.timedOut,
      log,
      report: after,
    });
  } finally {
    fixing = null;
  }
});

export default router;
