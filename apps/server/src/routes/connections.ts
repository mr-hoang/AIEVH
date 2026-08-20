import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Router } from "express";
import { hasClaudeAuth, hasCodexAuth, hasCodexCli, hasGeminiAuth, hasGeminiCli, upsertSecretVar } from "../config.js";
import { HttpError, isLocalRequest } from "../util.js";

/**
 * Quản lý kết nối AI trên web UI - xem trạng thái + nhập/xóa API key.
 * Key ghi vào ~/.aiev/credentials.env ngoài repo và cập nhật process.env ngay.
 * Bảo mật: không bao giờ trả full key về client - chỉ bản che (6 đầu + 4 cuối).
 */

interface ConnectionInfo {
  id: "claude" | "gemini" | "openai" | "soniox";
  label: string;
  roles: string[];
  connected: boolean;
  /** Nguồn kết nối đang hiệu lực */
  source: "oauth" | "api-key" | null;
  note: string | null;
  key: { envVar: string; present: boolean; masked: string | null };
  /** Hướng dẫn lấy key */
  keyHelpUrl: string;
}

function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function claudeOauthPresent(): boolean {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude");
  return fs.existsSync(path.join(configDir, ".credentials.json"));
}

function antigravityDetected(): boolean {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return (
    fs.existsSync(path.join(home, ".gemini")) ||
    fs.existsSync(path.join(home, ".antigravity")) ||
    fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Programs", "Antigravity"))
  );
}

function listConnections(): ConnectionInfo[] {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
  const geminiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";
  const sonioxKey = process.env.SONIOX_API_KEY || "";
  const oauth = claudeOauthPresent();
  const codexOauth = !openaiKey && hasCodexAuth();
  const geminiOauth = !geminiKey && hasGeminiAuth() && hasGeminiCli();

  return [
    {
      id: "claude",
      label: "Claude (Anthropic)",
      roles: ["edit", "chat"],
      connected: hasClaudeAuth(),
      source: oauth ? "oauth" : anthropicKey ? "api-key" : null,
      note: oauth
        ? "Đang dùng subscription OAuth của Claude Code (đăng nhập qua VSCode/terminal) - không tốn phí API."
        : anthropicKey
          ? "Đang dùng API key (tính phí theo usage)."
          : "Chưa kết nối - đăng nhập Claude Code trên máy này hoặc nhập API key.",
      key: {
        envVar: "ANTHROPIC_API_KEY",
        present: !!anthropicKey,
        masked: anthropicKey ? maskKey(anthropicKey) : null,
      },
      keyHelpUrl: "https://console.anthropic.com/settings/keys",
    },
    {
      id: "gemini",
      label: "Gemini (Google)",
      roles: ["edit", "chat", "image", "video"],
      connected: !!geminiKey || geminiOauth,
      source: geminiKey ? "api-key" : geminiOauth ? "oauth" : null,
      note: geminiKey
        ? "Đã kết nối bằng API key - dùng cho đạo diễn Gemini và tạo ảnh/video."
        : geminiOauth
          ? "Đã đăng nhập Google qua Gemini CLI - có thể chọn Gemini làm đạo diễn bằng Subscription. Tạo ảnh/video API vẫn cần key nếu gói không hỗ trợ."
        : antigravityDetected()
          ? "Đã phát hiện Gemini/Antigravity. Bấm Mở đăng nhập để kết nối Subscription, hoặc nhập API key."
          : "Chưa kết nối - dùng Subscription qua Gemini CLI hoặc nhập GEMINI_API_KEY.",
      key: {
        envVar: "GEMINI_API_KEY",
        present: !!geminiKey,
        masked: geminiKey ? maskKey(geminiKey) : null,
      },
      keyHelpUrl: "https://aistudio.google.com/apikey",
    },
    {
      id: "openai",
      label: "ChatGPT / Codex (OpenAI)",
      roles: ["edit", "chat"],
      connected: hasCodexAuth() && hasCodexCli(),
      source: codexOauth ? "oauth" : openaiKey ? "api-key" : null,
      note: openaiKey
        ? "Codex dùng API key dự phòng và tính phí theo usage."
        : codexOauth && hasCodexCli()
          ? "Đã tự nhận phiên ChatGPT của Codex CLI trên máy - dùng quyền lợi subscription."
          : codexOauth
            ? "Đã có phiên ChatGPT nhưng chưa gọi được Codex CLI. Cài `npm install -g @openai/codex` hoặc cấu hình CODEX_BIN."
          : "Chưa kết nối - cài Codex CLI rồi chạy `codex login`, hoặc nhập OPENAI_API_KEY dự phòng.",
      key: {
        envVar: "OPENAI_API_KEY",
        present: !!openaiKey,
        masked: openaiKey ? maskKey(openaiKey) : null,
      },
      keyHelpUrl: "https://platform.openai.com/api-keys",
    },
    {
      id: "soniox",
      label: "Soniox (bóc lời + phân vai người nói)",
      roles: ["stt"],
      connected: !!sonioxKey,
      source: sonioxKey ? "api-key" : null,
      note: sonioxKey
        ? "Đã kết nối - bóc lời async $0.10/giờ, 60+ ngôn ngữ, PHÂN VAI ĐƯỢC NGƯỜI NÓI (thứ faster-whisper trên máy không làm được)."
        : "Chưa kết nối. Không có key vẫn bóc lời được bằng faster-whisper trên máy (miễn phí) - nhưng bản đó không phân biệt được ai đang nói, thứ mà bước lồng tiếng cần để gán đúng giọng nam/nữ.",
      key: {
        envVar: "SONIOX_API_KEY",
        present: !!sonioxKey,
        masked: sonioxKey ? maskKey(sonioxKey) : null,
      },
      keyHelpUrl: "https://console.soniox.com",
    },
  ];
}

const router = Router();

// GET /api/connections
router.get("/", (_req, res) => {
  res.json({ connections: listConnections() });
});

// Mở terminal tương tác để người dùng tự đăng nhập Subscription. Chỉ cho phép
// request loopback vì thao tác này mở chương trình trên chính máy chủ.
router.post("/:provider/login", (req, res) => {
  if (!isLocalRequest(req)) {
    throw new HttpError(403, "LOCAL_ONLY", "Chỉ được mở đăng nhập từ dashboard trên chính máy này");
  }
  const provider = req.params.provider;
  const commands: Record<string, string> = {
    openai: `${process.env.CODEX_BIN || "codex"} login`,
    claude: process.env.CLAUDE_BIN || "claude",
    gemini: process.env.GEMINI_BIN || "gemini",
  };
  const command = commands[provider];
  if (!command) throw new HttpError(400, "LOGIN_NOT_SUPPORTED", "Provider này chỉ hỗ trợ API key");
  if (process.platform !== "win32") {
    res.json({ ok: false, command, message: `Hãy mở Terminal và chạy: ${command}` });
    return;
  }
  const title = `AIEV login - ${provider}`;
  const child = spawn("cmd.exe", ["/c", "start", title, "cmd.exe", "/k", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  res.json({ ok: true, command, message: "Đã mở cửa sổ đăng nhập. Hoàn tất trong cửa sổ đó rồi bấm Kiểm tra kết nối." });
});

// PUT /api/connections/:provider/key - { apiKey: string|null } (null = xóa)
router.put("/:provider/key", (req, res) => {
  const provider = req.params.provider;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const apiKey = body.apiKey;
  if (apiKey !== null && typeof apiKey !== "string") {
    throw new HttpError(400, "INVALID_KEY", "apiKey phải là string hoặc null");
  }
  const ENV_VARS: Record<string, string> = {
    gemini: "GEMINI_API_KEY",
    claude: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    soniox: "SONIOX_API_KEY",
  };
  const envVar = ENV_VARS[provider];
  if (!envVar) {
    throw new HttpError(404, "PROVIDER_NOT_FOUND", `Không hỗ trợ provider "${provider}"`);
  }

  // Làm sạch chuỗi người dùng dán vào: bỏ khoảng trắng, dấu nháy bao quanh,
  // và cả trường hợp dán nguyên dòng "GEMINI_API_KEY=AIza..." từ .env
  let trimmed: string | null = null;
  if (typeof apiKey === "string") {
    trimmed = apiKey.trim().replace(/^["']+|["']+$/g, "");
    const eqPrefix = new RegExp(`^${envVar}\\s*=\\s*`, "i");
    trimmed = trimmed.replace(eqPrefix, "").trim();
  }
  if (trimmed !== null && trimmed.length < 10) {
    throw new HttpError(400, "INVALID_KEY", "API key quá ngắn - kiểm tra lại (copy thiếu?)");
  }
  // Xuống dòng trong value sẽ ghi đè biến khác khi lưu .env (env injection)
  if (trimmed !== null && /[\r\n]/.test(trimmed)) {
    throw new HttpError(
      400,
      "INVALID_VALUE",
      "API key không được chứa xuống dòng - dán lại đúng một dòng key.",
    );
  }
  // KHÔNG chặn theo prefix nữa - định dạng key có thể thay đổi theo hãng.
  // Trọng tài thật là nút "Kiểm tra kết nối" (gọi API của hãng).

  upsertSecretVar(envVar, trimmed);

  res.json({ connections: listConnections() });
});

// POST /api/connections/:provider/test - gọi thử API rẻ nhất để xác minh key hoạt động
router.post("/:provider/test", async (req, res) => {
  const provider = req.params.provider;

  if (provider === "gemini") {
    const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!key) {
      res.json({
        ok: hasGeminiAuth() && hasGeminiCli(),
        message: hasGeminiAuth() && hasGeminiCli()
          ? "Đã đăng nhập Google qua Gemini CLI - sẵn sàng dùng Gemini làm đạo diễn."
          : "Chưa đăng nhập Gemini CLI và chưa có GEMINI_API_KEY.",
      });
      return;
    }
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1/models?pageSize=1",
      { headers: { "x-goog-api-key": key } },
    );
    if (r.ok) {
      res.json({ ok: true, message: "Key Gemini hoạt động - sẵn sàng tạo ảnh." });
    } else {
      // Trích message thật của Google cho dễ hiểu (SERVICE_DISABLED, API_KEY_INVALID...)
      const raw = await r.text();
      let detail = raw.slice(0, 200);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string; status?: string } };
        if (parsed.error?.message) {
          detail = `${parsed.error.status ?? ""} - ${parsed.error.message}`.slice(0, 300);
        }
      } catch {
        /* giữ raw */
      }
      let hint = "";
      if (/SERVICE_DISABLED|has not been used|is disabled/i.test(raw)) {
        hint =
          " → Key đúng nhưng project Google Cloud của key chưa bật 'Generative Language API'. Vào aistudio.google.com/apikey tạo key mới (tự bật sẵn API) là nhanh nhất.";
      } else if (/API_KEY_INVALID|API key not valid/i.test(raw)) {
        hint = " → Key không hợp lệ - kiểm tra copy đủ chuỗi, hoặc tạo key mới tại aistudio.google.com/apikey.";
      } else if (/PERMISSION_DENIED/i.test(raw)) {
        hint = " → Key bị giới hạn (API restrictions) - vào Google Cloud Console gỡ giới hạn hoặc cho phép Generative Language API.";
      }
      res.json({ ok: false, message: `Google từ chối (HTTP ${r.status}): ${detail}${hint}` });
    }
    return;
  }

  if (provider === "claude") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (r.ok) {
        res.json({ ok: true, message: "API key Anthropic hoạt động." });
      } else {
        res.json({ ok: false, message: `API key không hợp lệ (HTTP ${r.status}).` });
      }
      return;
    }
    if (claudeOauthPresent()) {
      res.json({
        ok: true,
        message: "Đang dùng subscription OAuth của Claude Code (đã đăng nhập trên máy).",
      });
      return;
    }
    res.json({ ok: false, message: "Chưa có xác thực Claude nào trên máy." });
    return;
  }

  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      if (hasCodexAuth() && hasCodexCli()) {
        res.json({
          ok: true,
          message:
            "Đã đăng nhập ChatGPT qua Codex CLI - AIEV có thể dùng Codex để dựng video.",
        });
      } else if (hasCodexAuth()) {
        res.json({
          ok: false,
          message: "Đã có phiên ChatGPT nhưng chưa gọi được Codex CLI. Cài @openai/codex hoặc cấu hình CODEX_BIN.",
        });
      } else {
        res.json({ ok: false, message: "Chưa đăng nhập Codex và chưa có OPENAI_API_KEY." });
      }
      return;
    }
    const r = await fetch("https://api.openai.com/v1/models?limit=1", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (r.ok) {
      res.json({
        ok: hasCodexCli(),
        message: hasCodexCli()
          ? "API key OpenAI hoạt động và Codex CLI đã sẵn sàng."
          : "API key OpenAI hoạt động, nhưng cần cài Codex CLI để AIEV dựng video.",
      });
    } else {
      res.json({ ok: false, message: `Key không hợp lệ (HTTP ${r.status}).` });
    }
    return;
  }

  if (provider === "soniox") {
    const key = process.env.SONIOX_API_KEY;
    if (!key) {
      res.json({ ok: false, message: "Chưa có SONIOX_API_KEY." });
      return;
    }
    // GET /v1/models: endpoint rẻ nhất của họ (chỉ liệt kê model, không bóc lời
    // nên không tính tiền) mà vẫn đi qua đúng tầng xác thực Bearer.
    const r = await fetch("https://api.soniox.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (r.ok) {
      res.json({ ok: true, message: "Key Soniox hoạt động - sẵn sàng bóc lời + phân vai người nói." });
    } else {
      const detail = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      res.json({
        ok: false,
        message:
          r.status === 401 || r.status === 403
            ? `Soniox từ chối key (HTTP ${r.status}) - kiểm tra lại key ở console.soniox.com.`
            : `Soniox trả lỗi HTTP ${r.status}: ${detail || r.statusText}`,
      });
    }
    return;
  }

  throw new HttpError(404, "PROVIDER_NOT_FOUND", `Không hỗ trợ provider "${provider}"`);
});

export default router;
