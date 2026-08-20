import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { apiToken, hasClaudeAuth, repoRoot } from "../config.js";
import { execFileCapture, hyperframesCli, isLocalRequest } from "../util.js";

export interface HealthChecks {
  ffmpeg: boolean;
  node: string;
  /** Có xác thực Claude (subscription OAuth của Claude Code hoặc API key trong .env) */
  claudeAuth: boolean;
  hyperframes: boolean;
}

export interface HealthResult {
  ok: true;
  checks: HealthChecks;
  /** Token API - CHỈ trả khi request đến trực tiếp từ máy chủ (xem isLocalRequest) */
  apiToken?: string;
}

async function checkFfmpeg(): Promise<boolean> {
  try {
    await execFileCapture("ffmpeg", ["-version"], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function checkHyperframes(): Promise<boolean> {
  // Nhanh nhất: package đã cài ở root workspace
  if (fs.existsSync(path.join(repoRoot, "node_modules", "hyperframes"))) return true;
  try {
    await execFileCapture(process.execPath, [hyperframesCli(), "--version"], {
      cwd: repoRoot,
      timeoutMs: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getHealth(): Promise<HealthResult> {
  const [ffmpeg, hyperframes] = await Promise.all([checkFfmpeg(), checkHyperframes()]);
  return {
    ok: true,
    checks: {
      ffmpeg,
      node: process.version,
      claudeAuth: hasClaudeAuth(),
      hyperframes,
    },
  };
}

const router = Router();

/**
 * GET /api/health - endpoint public duy nhất (middleware auth cho qua).
 *
 * Kèm `apiToken` CHỈ khi request đến TRỰC TIẾP từ máy chủ (loopback, không qua
 * proxy Next): đây là cách web dashboard chạy trên chính máy này lấy token để
 * gắn vào mọi request sau đó. Điện thoại LAN / tunnel gọi endpoint này KHÔNG
 * bao giờ nhận được token - chúng dùng token phiên QR (`?k=`).
 */
router.get("/", async (req, res) => {
  const health = await getHealth();
  if (isLocalRequest(req)) health.apiToken = apiToken();
  res.json(health);
});

export default router;
