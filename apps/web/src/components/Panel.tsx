"use client";

/**
 * Hộp lồng bên trong card - nhóm thiết lập liên quan, hộp log, khối tóm tắt.
 *
 * Thay cho 8 bản sao y hệt của chuỗi
 * `rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] p-3`
 * trong ModelPicker, BriefFields, ImageProjectForm, ProjectPublishCard,
 * VideoStyleSelect, ConfirmDeleteModal, UpdateModal và AutoCutCreateModal.
 *
 * QUY TẮC LỒNG: Card → Panel là HẾT. Không lồng Panel trong Panel. Ba lớp viền
 * lồng nhau thì mắt không còn phân biệt được cái nào chứa cái nào - đã gặp thật
 * ở trang Dịch video (Card → hộp → thẻ <li> có viền).
 */

import type { ReactNode } from "react";

export function Panel({
  title,
  actions,
  children,
  className = "",
}: {
  /** Tiêu đề nhóm - 13px/600, cố ý NHỎ HƠN tiêu đề card (14px/600) để thấy rõ
      cái nào lồng trong cái nào */
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`panel flex min-w-0 flex-col gap-2 ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {title && (
            <h3 className="min-w-0 text-meta font-semibold">{title}</h3>
          )}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
