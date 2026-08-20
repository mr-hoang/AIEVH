import { Router } from "express";
import { nanoid } from "nanoid";
import { cancelPendingResume, interruptAgent, runAgent } from "../agent.js";
import * as db from "../db.js";
import { parseModelEffort } from "./providers.js";
import { HttpError } from "../util.js";

const router = Router();

/** Row DB → shape JSON của ChatSession (docs/API.md): autoResume 0/1 → boolean */
function sessionToApi<T extends { autoResume: number }>(row: T): Omit<T, "autoResume"> & {
  autoResume: boolean;
} {
  return { ...row, autoResume: row.autoResume !== 0 };
}

// GET /api/chat/sessions[?projectId=] → ChatSession[]
router.get("/sessions", (req, res) => {
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
  res.json(db.listChatSessions(projectId).map(sessionToApi));
});

// GET /api/chat/:sessionId/messages → [{ role, kind, content, createdAt }]
router.get("/:sessionId/messages", (req, res) => {
  const sessionId = req.params.sessionId;
  if (!db.getChatSession(sessionId)) {
    throw new HttpError(404, "SESSION_NOT_FOUND", `Không tìm thấy phiên chat "${sessionId}"`);
  }
  res.json(db.listChatMessages(sessionId));
});

// POST /api/chat - { message, sessionId?, model?, effort? } → 202 { sessionId }, agent chạy async
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) throw new HttpError(400, "MESSAGE_REQUIRED", "Thiếu message");
  const { model, effort } = parseModelEffort(body); // 400 nếu không hợp lệ

  let sessionId: string;
  if (typeof body.sessionId === "string" && body.sessionId.trim()) {
    sessionId = body.sessionId.trim();
    if (!db.getChatSession(sessionId)) {
      throw new HttpError(404, "SESSION_NOT_FOUND", `Không tìm thấy phiên chat "${sessionId}"`);
    }
    // Đổi model/effort giữa chừng - lưu vào session, mọi lượt chạy sau dùng lựa chọn mới
    db.setChatSessionModelEffort(sessionId, model, effort);
  } else {
    sessionId = `sess_${nanoid()}`;
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null;
    // Title = 60 ký tự đầu của message đầu tiên
    db.createChatSession(sessionId, message.slice(0, 60), projectId, model ?? null, effort ?? null);
  }

  // Trả 202 NGAY, agent chạy nền - event đẩy qua SSE kênh `agent`
  res.status(202).json({ sessionId });
  void runAgent(sessionId, message);
});

// PUT /api/chat/:sessionId/auto-resume - { enabled: boolean } → 204
router.put("/:sessionId/auto-resume", (req, res) => {
  const sessionId = req.params.sessionId;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") {
    throw new HttpError(400, "INVALID_ENABLED", "enabled phải là boolean");
  }
  if (!db.getChatSession(sessionId)) {
    throw new HttpError(404, "SESSION_NOT_FOUND", `Không tìm thấy phiên chat "${sessionId}"`);
  }
  db.setChatAutoResume(sessionId, body.enabled);
  // Tắt auto-resume → hủy luôn lượt resume đang chờ (nếu có)
  if (!body.enabled) cancelPendingResume(sessionId);
  res.status(204).end();
});

// POST /api/chat/:sessionId/interrupt → 204
router.post("/:sessionId/interrupt", async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!db.getChatSession(sessionId)) {
    throw new HttpError(404, "SESSION_NOT_FOUND", `Không tìm thấy phiên chat "${sessionId}"`);
  }
  await interruptAgent(sessionId); // không chạy thì bỏ qua - interrupt là idempotent
  res.status(204).end();
});

export default router;
