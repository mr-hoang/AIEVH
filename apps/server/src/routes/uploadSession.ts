import { Router } from "express";
import { nanoid } from "nanoid";
import { projectExists } from "../meta.js";
import { HttpError } from "../util.js";

/**
 * Phiên upload cho tính năng "Kết nối điện thoại" - bảo mật link QR.
 *
 * PC mở modal QR → POST tạo token `ut_<nanoid>` gắn với projectId (TTL 60
 * phút); URL/QR mang token qua query `?k=`. ĐÓNG modal → DELETE thu hồi ngay
 * → link trên điện thoại hết hiệu lực tức thì. POST /api/assets (scope
 * project, request không phải từ chính máy chủ) bắt buộc token hợp lệ -
 * xem isValidUploadToken.
 *
 * Lưu trong Map module-level (mất khi restart server - chấp nhận được: user
 * chỉ cần mở lại modal QR để lấy link mới).
 */

const SESSION_TTL_MS = 60 * 60 * 1000; // 60 phút

interface UploadSession {
  projectId: string;
  expiresAt: number; // epoch ms
}

const sessions = new Map<string, UploadSession>();

/** Dọn token hết hạn - gọi mỗi lần có request tới route này. */
function prune(): void {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(token);
  }
}

/**
 * Token phiên upload có tồn tại và còn hạn không (KHÔNG gắn với project cụ thể)?
 * Middleware xác thực ở index.ts dùng hàm này để cho trang /m trên điện thoại
 * đi qua; ràng buộc đúng project vẫn do isValidUploadToken kiểm ở POST /api/assets.
 */
export function isKnownUploadToken(token: string): boolean {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/**
 * Còn phiên upload nào đang sống không - tunnel.ts dùng để tự tắt tunnel do
 * modal QR bật lên. Không còn phiên nào nghĩa là không ai đang cần đường
 * Internet đó nữa, mà để nó chạy tiếp thì URL public vẫn sống vô thời hạn.
 */
export function hasLiveUploadSessions(): boolean {
  prune();
  return sessions.size > 0;
}

/** Token còn hiệu lực cho đúng project (chưa hết hạn, chưa bị thu hồi)? */
export function isValidUploadToken(token: string, projectId: string): boolean {
  if (!token || !projectId) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return s.projectId === projectId;
}

const router = Router();

// POST /api/upload-session  { projectId } → 201 { token, expiresAt }
router.post("/", (req, res) => {
  prune();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) throw new HttpError(400, "PROJECT_ID_REQUIRED", "Thiếu projectId");
  if (!projectExists(projectId)) {
    throw new HttpError(404, "PROJECT_NOT_FOUND", `Không tìm thấy project "${projectId}"`);
  }
  const token = `ut_${nanoid(24)}`;
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { projectId, expiresAt });
  res.status(201).json({ token, expiresAt: new Date(expiresAt).toISOString() });
});

// DELETE /api/upload-session/:token → 204 (idempotent - token lạ cũng 204)
router.delete("/:token", (req, res) => {
  prune();
  sessions.delete(req.params.token);
  res.status(204).end();
});

export default router;
