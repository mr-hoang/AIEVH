"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { IconButton } from "@/components/IconButton";
import { useT } from "@/lib/i18n";

/**
 * LUẬT CHUNG CHO MỌI MODAL (trước đợt đại tu có 8 modal dùng file này theo 8
 * kiểu khác nhau - giờ chốt lại):
 *
 * 1. Nút trong `footer` LUÔN là <Button> cỡ mặc định 36px. Không `small`, và
 *    không <button> đeo class .btn-* chép tay (UpdateModal từng có 8 nút kiểu đó).
 * 2. Thứ tự nút: [phụ] … [chính] - hành động chính ở ngoài cùng bên phải, và
 *    LUÔN có một đường thoát (Hủy/Đóng) chứ không chỉ mỗi dấu X.
 * 3. Lỗi đặt ở ĐẦU thân modal bằng <ErrorBanner>/<Banner tone="danger">, không
 *    nhét xuống footer và không viết chữ đỏ trần.
 * 4. `wide` chỉ dành cho nội dung THẬT SỰ nhiều cột (stepper + log + danh sách,
 *    lưới preview). Biểu mẫu một cột để hẹp cho dễ đọc.
 * 5. Nút Hủy và dấu X đi CÙNG một đường: modal đang bận thì cả hai cùng bị chặn.
 */

export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  wide = false,
  dismissible = true,
}: {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** true = modal rộng (lưới preview nhiều cột) - max-w 960px thay vì 640px. */
  wide?: boolean;
  /**
   * false = KHÔNG cho đóng: ẩn nút X, chặn Escape và click nền.
   * Dùng cho thao tác không được bỏ dở giữa chừng (đang cập nhật hệ thống).
   * Để nút X hiện mà bấm không tác dụng còn khó hiểu hơn là không có nút.
   */
  dismissible?: boolean;
}) {
  const { t } = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--text)]/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
    >
      {/* Form đơn lẻ giữ giới hạn chiều rộng cho dễ đọc (quy tắc full-width chỉ áp cho trang) */}
      <div
        className={`card max-h-[90vh] w-full overflow-y-auto ${
          wide ? "max-w-[960px]" : "max-w-[640px]"
        }`}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          {dismissible && (
            <IconButton label={t("common.close")} size="sm" onClick={onClose}>
              <X size={15} strokeWidth={2} />
            </IconButton>
          )}
        </div>
        <div className="flex flex-col gap-3">{children}</div>
        {footer && (
          <div className="mt-5 flex justify-end gap-2">{footer}</div>
        )}
      </div>
    </div>
  );
}
