import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { childEnv, paths } from "./config.js";
import { ensureDir } from "./util.js";

const execFileAsync = promisify(execFile);

/**
 * Cài đặt tăng tốc phần cứng cho render - điều khiển từ tab "Tăng tốc" trên web UI.
 * Lưu data/render-settings.json; job đọc MỖI LẦN chạy nên đổi là có hiệu lực ngay.
 * Thiết kế đa nền tảng: NVENC (NVIDIA/Windows-Linux), VideoToolbox + fast-capture (macOS).
 */

export interface RenderSettings {
  /** Số worker Chrome của HyperFrames (0 = auto của CLI) */
  workers: number;
  /** Dùng GPU cho capture của Chrome (Windows/NVIDIA lẫn macOS/Metal đều hưởng) */
  browserGpu: boolean;
  /** Encode GPU cho bản DRAFT (NVENC/VideoToolbox tùy máy) - nhanh, chất lượng draft không quan trọng */
  gpuEncodeDraft: boolean;
  /** Encode GPU cho bản FINAL - nhanh hơn nhưng chất lượng nhỉnh kém libx264 cùng dung lượng */
  gpuEncodeFinal: boolean;
  /** --experimental-fast-capture - chỉ thực sự ăn trên macOS + GPU thật (nơi khác tự fallback) */
  fastCapture: boolean;
  /** --concurrency của Remotion (0 = mặc định Remotion ~ nửa số core) */
  remotionConcurrency: number;
  /** Số job render chạy đồng thời trong queue (1-4) */
  queueConcurrency: number;
  /** fps cho bản draft (null = giữ fps composition; 15 = nhanh gần gấp đôi, chỉ để duyệt nhịp) */
  draftFps: number | null;
  /**
   * Cổng QC: chặn job assemble-final khi bản draft chưa qua QC tự động hoặc QC fail.
   * Mặc định BẬT - final render tốn hàng chục phút, phát hiện lỗi ở đó là lãng
   * phí nhất. Tắt được cho trường hợp cố ý bỏ qua (xem routes/jobs.ts).
   */
  qcGate: boolean;
  /**
   * Kênh cập nhật của hệ thống:
   * - "stable": chỉ nhận bản đã được publish thành Release (tag `v*`) - mặc định.
   * - "latest": bám commit mới nhất trên main, nhận sửa lỗi sớm nhưng có thể dính
   *   commit dở dang vì mọi push đều hiện ra thành "có bản mới".
   */
  updateChannel: UpdateChannel;
  /**
   * Số lần phiên dựng video (goal='final') được TỰ CHẠY LẠI khi lượt trước kết
   * thúc mà video final chưa có.
   *
   * VÌ SAO ĐÁNG TIỀN: đo trên dữ liệu thật, 4 phiên có chạy lại tốn trung bình
   * $61,87 trong khi 20 phiên không chạy lại chỉ $22,57 - tức 4 phiên đó nuốt
   * 34% tổng chi phí. Mỗi lần chạy lại là làm lại gần như từ đầu, mà mỗi lượt
   * agent lại đọc lại toàn bộ hội thoại, nên tiền tăng rất nhanh.
   *
   * Hạ xuống thì phiên hỏng dừng sớm để người dùng xem lỗi thay vì tự đâm đầu.
   */
  aiMaxAttempts: number;
  /**
   * Trần số lượt (turn) trong MỘT lần chạy của phiên dựng video.
   *
   * Một "lượt" là một vòng agent gọi công cụ rồi nhận kết quả. Trần cao cho
   * phép agent tự xoay xở lâu, nhưng cũng là thứ cho phép một phiên lạc đường
   * chạy mãi: phiên đắt nhất trong lịch sử ngốn 92 triệu token vào.
   */
  aiMaxTurns: number;
}

/** Kênh cập nhật - xem RenderSettings.updateChannel */
export type UpdateChannel = "stable" | "latest";

export const UPDATE_CHANNELS: UpdateChannel[] = ["stable", "latest"];

/** Số luồng CPU thật của máy - nguồn cho default + trần của workers/concurrency */
const cpuThreads = os.cpus().length;
/** Số worker khuyên dùng: theo máy thật, trần 8 (nhiều hơn hiếm khi nhanh hơn đáng kể) */
export const recommendedWorkers = Math.min(cpuThreads, 8);
/** Trần chọn được trên UI: máy nhiều luồng được chọn tới đúng số luồng (tối thiểu 4) */
export const maxWorkers = Math.max(cpuThreads, 4);

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  workers: recommendedWorkers,
  browserGpu: true,
  gpuEncodeDraft: true,
  gpuEncodeFinal: false,
  fastCapture: false,
  remotionConcurrency: recommendedWorkers,
  queueConcurrency: 2,
  draftFps: null,
  qcGate: true,
  updateChannel: "stable",
  // 4 thay vì 12 như hằng số cũ trong agent.ts. 12 lần chạy lại là quá rộng:
  // phiên nào hỏng thật thì hỏng luôn từ lần 3-4, chạy tiếp chỉ đốt tiền chứ
  // không cứu được. Cần rộng hơn thì chỉnh trong Cấu hình.
  aiMaxAttempts: 4,
  // Giữ đúng 300 như hằng số cũ để bản cập nhật không đổi hành vi mặc định -
  // ai muốn siết thì tự hạ, và trang Cấu hình nói rõ hạ để làm gì.
  aiMaxTurns: 300,
};

/** Trần chọn được trên UI cho hai thiết lập AI - xem RenderSettings. */
export const AI_ATTEMPT_OPTIONS = [1, 2, 3, 4, 6, 8, 12] as const;
export const AI_TURN_OPTIONS = [50, 100, 150, 200, 300] as const;

const settingsFile = path.join(paths.dataDir, "render-settings.json");

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Kẹp range + ép kiểu một object bất kỳ về RenderSettings hợp lệ - dùng cho cả read lẫn write */
function normalizeSettings(raw: Record<string, unknown>): RenderSettings {
  const base = { ...DEFAULT_RENDER_SETTINGS };
  if (typeof raw.workers === "number") base.workers = clamp(Math.round(raw.workers), 0, maxWorkers);
  if (typeof raw.browserGpu === "boolean") base.browserGpu = raw.browserGpu;
  if (typeof raw.gpuEncodeDraft === "boolean") base.gpuEncodeDraft = raw.gpuEncodeDraft;
  if (typeof raw.gpuEncodeFinal === "boolean") base.gpuEncodeFinal = raw.gpuEncodeFinal;
  if (typeof raw.fastCapture === "boolean") base.fastCapture = raw.fastCapture;
  if (typeof raw.qcGate === "boolean") base.qcGate = raw.qcGate;
  if (UPDATE_CHANNELS.includes(raw.updateChannel as UpdateChannel)) {
    base.updateChannel = raw.updateChannel as UpdateChannel;
  }
  if (typeof raw.remotionConcurrency === "number") {
    base.remotionConcurrency = clamp(Math.round(raw.remotionConcurrency), 0, maxWorkers);
  }
  if (typeof raw.queueConcurrency === "number") {
    base.queueConcurrency = clamp(Math.round(raw.queueConcurrency), 1, 4);
  }
  if (raw.draftFps === null) base.draftFps = null;
  else if (typeof raw.draftFps === "number") base.draftFps = clamp(Math.round(raw.draftFps), 10, 60);
  // Trần 12 = đúng hằng số cũ, để người cần vẫn quay lại được hành vi trước đây.
  // Sàn 1 chứ không phải 0: 0 nghĩa là không chạy lượt nào, phiên chết ngay.
  if (typeof raw.aiMaxAttempts === "number") {
    base.aiMaxAttempts = clamp(Math.round(raw.aiMaxAttempts), 1, 12);
  }
  // Sàn 20: dưới mức đó agent chưa kịp đọc xong nguồn thì đã hết lượt, phiên
  // nào cũng hỏng - siết quá tay còn tốn hơn vì phải làm lại.
  if (typeof raw.aiMaxTurns === "number") {
    base.aiMaxTurns = clamp(Math.round(raw.aiMaxTurns), 20, 300);
  }
  return base;
}

export function readRenderSettings(): RenderSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    return normalizeSettings(raw);
  } catch {
    /* file chưa có / hỏng → default */
    return { ...DEFAULT_RENDER_SETTINGS };
  }
}

export function writeRenderSettings(patch: Partial<RenderSettings>): RenderSettings {
  // Clamp TRƯỚC khi ghi - file trên đĩa không còn chứa giá trị ngoài range
  const next = normalizeSettings({ ...readRenderSettings(), ...patch });
  ensureDir(paths.dataDir);
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

// ---------------------------------------------------------------- Phần cứng

export interface HardwareInfo {
  platform: string;
  cores: number;
  ramGb: number;
  gpuName: string | null;
  /** NVENC khả dụng (NVIDIA) */
  nvenc: boolean;
  /** VideoToolbox + fast-capture (macOS) */
  videotoolbox: boolean;
  // ---- Chi tiết hiển thị trên tab Cấu hình ----
  /** Tên đầy đủ CPU, vd "Intel(R) Core(TM) i5-9400F CPU @ 2.90GHz" (đã dọn (R)/(TM)) */
  cpuModel: string;
  /** Số core vật lý (null nếu không tra được - UI rơi về threads) */
  cpuCores: number | null;
  /** Số luồng logic */
  cpuThreads: number;
  /** Xung tối đa (GHz, null nếu không tra được) */
  cpuMaxGhz: number | null;
  /** Loại RAM: DDR3/DDR4/DDR5/Unified Memory... */
  ramType: string | null;
  /** Bus RAM (MHz) */
  ramSpeedMhz: number | null;
  /** VRAM của GPU (GB) - hiện chỉ tra được với NVIDIA */
  gpuVramGb: number | null;
}

let hardwareCache: HardwareInfo | null = null;

/** Chạy PowerShell CIM trả JSON - fallback khi wmic không có (Win11 mới bỏ wmic) */
async function psCimJson(className: string, props: string[]): Promise<Record<string, unknown>[]> {
  const cmd =
    `Get-CimInstance ${className} | Select-Object ${props.join(",")} | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", cmd],
    // env: thống nhất một lối - mọi tiến trình con dùng .runtime/tmp (xem childEnv)
    { windowsHide: true, timeout: 10_000, env: childEnv() },
  );
  const parsed = JSON.parse(stdout.trim()) as unknown;
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
}

/** SMBIOSMemoryType → tên chuẩn (Win32_PhysicalMemory) */
const RAM_TYPE_BY_SMBIOS: Record<number, string> = {
  20: "DDR",
  21: "DDR2",
  24: "DDR3",
  26: "DDR4",
  34: "DDR5",
  35: "LPDDR5",
};

export async function detectHardware(): Promise<HardwareInfo> {
  if (hardwareCache) return hardwareCache;
  const cpus = os.cpus();
  const info: HardwareInfo = {
    platform: process.platform,
    cores: cpus.length,
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    gpuName: null,
    nvenc: false,
    videotoolbox: process.platform === "darwin",
    cpuModel: (cpus[0]?.model ?? "CPU").replace(/\((R|TM)\)/gi, "").replace(/\s+/g, " ").trim(),
    cpuCores: null,
    cpuThreads: cpus.length,
    cpuMaxGhz: null,
    ramType: null,
    ramSpeedMhz: null,
    gpuVramGb: null,
  };

  // NVIDIA? - lấy luôn cả VRAM
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 5000, env: childEnv() },
    );
    const first = stdout.trim().split("\n")[0]?.trim();
    if (first) {
      const [name, memMb] = first.split(",").map((s) => s.trim());
      if (name) {
        info.gpuName = name;
        info.nvenc = true;
      }
      const mb = Number(memMb);
      if (Number.isFinite(mb) && mb > 0) info.gpuVramGb = Math.round(mb / 1024);
    }
  } catch {
    /* không có NVIDIA */
  }

  if (process.platform === "win32") {
    // CPU: core vật lý + xung tối đa (CIM - wmic đã deprecated trên Win11 mới)
    try {
      const rows = await psCimJson("Win32_Processor", ["NumberOfCores", "MaxClockSpeed"]);
      const cores = rows.reduce((acc, r) => acc + (Number(r.NumberOfCores) || 0), 0);
      if (cores > 0) info.cpuCores = cores;
      const mhz = Number(rows[0]?.MaxClockSpeed);
      if (Number.isFinite(mhz) && mhz > 0) info.cpuMaxGhz = Math.round(mhz / 100) / 10;
    } catch {
      /* thôi - UI rơi về threads */
    }
    // RAM: loại + bus
    try {
      const rows = await psCimJson("Win32_PhysicalMemory", [
        "SMBIOSMemoryType",
        "Speed",
        "ConfiguredClockSpeed",
      ]);
      const smbios = Number(rows[0]?.SMBIOSMemoryType);
      if (RAM_TYPE_BY_SMBIOS[smbios]) info.ramType = RAM_TYPE_BY_SMBIOS[smbios];
      const speed = Number(rows[0]?.ConfiguredClockSpeed) || Number(rows[0]?.Speed);
      if (Number.isFinite(speed) && speed > 0) info.ramSpeedMhz = speed;
    } catch {
      /* thôi */
    }
    // Tên GPU tổng quát nếu không có NVIDIA
    if (!info.gpuName) {
      try {
        const rows = await psCimJson("Win32_VideoController", ["Name"]);
        const name = typeof rows[0]?.Name === "string" ? (rows[0].Name as string).trim() : "";
        if (name) info.gpuName = name;
      } catch {
        /* thôi */
      }
    }
  }

  if (process.platform === "darwin") {
    // Apple Silicon: RAM hợp nhất; core vật lý qua sysctl
    try {
      const { stdout } = await execFileAsync("sysctl", ["-n", "hw.physicalcpu"], {
        timeout: 5000,
        env: childEnv(),
      });
      const n = Number(stdout.trim());
      if (Number.isFinite(n) && n > 0) info.cpuCores = n;
    } catch {
      /* thôi */
    }
    if (/apple/i.test(info.cpuModel)) info.ramType = "Unified Memory";
    if (!info.gpuName) info.gpuName = "Apple GPU (Metal)";
  }

  hardwareCache = info;
  return info;
}

// ---------------------------------------------------------------- Flags builder

/** Argv flags tăng tốc cho `hyperframes render` - job đọc mỗi lần chạy */
export function hyperframesSpeedArgs(draft: boolean): string[] {
  const s = readRenderSettings();
  const parts: string[] = [];
  if (s.workers > 0) parts.push("-w", String(s.workers));
  if (s.browserGpu) parts.push("--browser-gpu");
  if (s.fastCapture) parts.push("--experimental-fast-capture");
  if (draft ? s.gpuEncodeDraft : s.gpuEncodeFinal) parts.push("--gpu");
  if (draft && s.draftFps) parts.push("-f", String(s.draftFps));
  return parts;
}

/** Argv --concurrency cho `remotion render/still` ([] nếu để mặc định Remotion) */
export function remotionConcurrencyArgs(): string[] {
  const c = readRenderSettings().remotionConcurrency;
  return c > 0 ? ["--concurrency", String(c)] : [];
}

/**
 * Argv --gl cho Chrome của Remotion - mặc định Remotion dùng SwANGLE (software, CPU thuần).
 * Bật "GPU cho capture" → angle (Windows/macOS) / angle-egl (Linux) để dựng hình bằng GPU thật.
 */
export function remotionGlArgs(): string[] {
  if (!readRenderSettings().browserGpu) return [];
  return process.platform === "linux" ? ["--gl", "angle-egl"] : ["--gl", "angle"];
}

/** Bộ argv tăng tốc đầy đủ cho `remotion render` */
export function remotionSpeedArgs(): string[] {
  return [...remotionConcurrencyArgs(), ...remotionGlArgs()];
}

/** Số job queue chạy đồng thời - queue đọc mỗi tick nên đổi là ăn ngay */
export function queueConcurrency(): number {
  return readRenderSettings().queueConcurrency;
}
