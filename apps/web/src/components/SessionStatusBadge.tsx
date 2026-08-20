"use client";

import type { ChatSessionStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * Badge trạng thái phiên AI - dùng ở panel AI của project, header ChatThread
 * và mọi nơi liệt kê session. running có chấm nhấp nháy để thấy ngay là
 * phiên còn sống.
 */

// Giá trị là KEY dictionary - dịch bằng t() lúc render.
const LABEL: Record<ChatSessionStatus, string> = {
  idle: "badge.session.idle",
  running: "badge.session.running",
  done: "badge.session.done",
  error: "badge.session.error",
  interrupted: "badge.session.interrupted",
};

const TONE: Record<ChatSessionStatus, string> = {
  idle: "badge-muted",
  running: "badge-running",
  done: "badge-success",
  error: "badge-danger",
  interrupted: "badge-muted",
};

/**
 * Label thuần chữ - dùng trong <option> của dropdown (không render JSX được).
 * Nhận t từ useT() của caller để dịch đúng ngôn ngữ.
 */
export function sessionStatusLabel(
  status: ChatSessionStatus,
  t: (key: string) => string
): string {
  return LABEL[status] ? t(LABEL[status]) : String(status);
}

export function SessionStatusBadge({
  status,
  large = false,
}: {
  status: ChatSessionStatus;
  large?: boolean;
}) {
  const { t } = useT();
  const tone = TONE[status] ?? "badge-muted";
  return (
    <span
      className={`badge ${tone} ${large ? "px-3 py-1 text-meta" : ""}`}
    >
      <span
        className={`badge-dot ${status === "running" ? "badge-dot-pulse" : ""}`}
      />
      {sessionStatusLabel(status, t)}
    </span>
  );
}
