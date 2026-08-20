import os from "node:os";
import { Router } from "express";
import { execFileCaptureAll } from "../util.js";

/**
 * GET /api/metrics - mức sử dụng CPU/GPU hiện tại, cho thanh header của web UI.
 *
 * VÌ SAO poll chứ không đẩy qua SSE: đo là việc TỐN (spawn nvidia-smi), chỉ nên
 * chạy khi thật sự có người đang nhìn. SSE sẽ bắt server đo liên tục kể cả khi
 * không ai mở dashboard. Bù lại, kết quả được cache ngắn để nhiều tab cùng mở
 * không nhân số lần spawn lên.
 */

export interface MetricsCpu {
  /** % bận toàn hệ thống trong khoảng giữa hai lần lấy mẫu (0-100) */
  percent: number;
  /** Số luồng logic - để UI hiện "42% / 8 luồng" */
  threads: number;
  model: string;
}

export interface MetricsGpu {
  /** false = máy không có GPU đọc được mức sử dụng (không phải NVIDIA) */
  available: boolean;
  name: string | null;
  /** % nhân GPU đang bận (null khi không đọc được) */
  percent: number | null;
  vramUsedMb: number | null;
  vramTotalMb: number | null;
}

/** Cache kết quả để N tab cùng poll chỉ tốn một lần đo */
const CACHE_MS = 1_500;
/**
 * Máy không có nvidia-smi thì đừng thử lại mỗi 2 giây - spawn hụt liên tục rất
 * phí. Nhớ trong 5 phút rồi mới dò lại (cắm GPU giữa chừng là chuyện hiếm).
 */
const GPU_MISS_TTL_MS = 5 * 60_000;

interface CpuSample {
  at: number;
  idle: number;
  total: number;
}

function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { at: Date.now(), idle, total };
}

let lastCpu: CpuSample | null = null;

/**
 * % CPU bận = 1 - (idle tăng / tổng tăng) giữa hai lần lấy mẫu.
 * Lần gọi đầu chưa có mẫu trước -> lấy mẫu nhanh 200ms tại chỗ để header không
 * phải hiện trống ở lần render đầu tiên.
 */
async function cpuPercent(): Promise<number> {
  if (!lastCpu) {
    lastCpu = cpuSample();
    await new Promise((r) => setTimeout(r, 200));
  }
  const now = cpuSample();
  const dIdle = now.idle - lastCpu.idle;
  const dTotal = now.total - lastCpu.total;
  lastCpu = now;
  if (dTotal <= 0) return 0;
  const busy = 1 - dIdle / dTotal;
  return Math.max(0, Math.min(100, Math.round(busy * 100)));
}

let gpuMissUntil = 0;

async function gpuStats(): Promise<MetricsGpu> {
  const none: MetricsGpu = {
    available: false,
    name: null,
    percent: null,
    vramUsedMb: null,
    vramTotalMb: null,
  };
  if (Date.now() < gpuMissUntil) return none;
  try {
    const r = await execFileCaptureAll(
      "nvidia-smi",
      [
        "--query-gpu=utilization.gpu,memory.used,memory.total,name",
        "--format=csv,noheader,nounits",
      ],
      { timeoutMs: 5_000 },
    );
    if (r.code !== 0 || r.timedOut) {
      gpuMissUntil = Date.now() + GPU_MISS_TTL_MS;
      return none;
    }
    // Máy nhiều GPU: lấy card đầu tiên (card dùng để render)
    const line = r.stdout.trim().split("\n")[0]?.trim();
    if (!line) {
      gpuMissUntil = Date.now() + GPU_MISS_TTL_MS;
      return none;
    }
    const [util, used, total, ...nameParts] = line.split(",").map((s) => s.trim());
    const num = (v: string): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      available: true,
      name: nameParts.join(",").trim() || null,
      percent: num(util),
      vramUsedMb: num(used),
      vramTotalMb: num(total),
    };
  } catch {
    // Không có nvidia-smi trên PATH (máy AMD/Intel/macOS)
    gpuMissUntil = Date.now() + GPU_MISS_TTL_MS;
    return none;
  }
}

let cached: { at: number; payload: { cpu: MetricsCpu; gpu: MetricsGpu } } | null = null;

const router = Router();

router.get("/", async (_req, res) => {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    res.json(cached.payload);
    return;
  }
  const [percent, gpu] = await Promise.all([cpuPercent(), gpuStats()]);
  const cpus = os.cpus();
  const payload = {
    cpu: {
      percent,
      threads: cpus.length,
      model: (cpus[0]?.model ?? "").replace(/\((R|TM)\)/g, "").replace(/\s+/g, " ").trim(),
    },
    gpu,
  };
  cached = { at: Date.now(), payload };
  res.json(payload);
});

export default router;
