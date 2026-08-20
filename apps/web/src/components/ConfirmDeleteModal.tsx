"use client";

import { Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { Panel } from "@/components/Panel";
import { useT } from "@/lib/i18n";

/** Chuỗi bắt buộc gõ đúng để mở khóa nút Xóa. */
const CONFIRM_TEXT = "DELETE";

/**
 * Modal xác nhận xóa dùng chung cho MỌI hành động xóa phá hủy dữ liệu:
 * bắt gõ đúng chữ DELETE mới cho bấm Xóa - thay thế window.confirm.
 *
 * Lưu ý: hành động không phá hủy dữ liệu nguồn (vd "Xóa file rác") KHÔNG
 * dùng modal này - giữ confirm thường.
 */
export function ConfirmDeleteModal({
  open,
  title,
  description,
  items,
  busy = false,
  busyLabel,
  confirmLabel,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  /** Tiêu đề modal - hiển thị màu đỏ (danger). Mặc định t("confirm.title"). */
  title?: string;
  /** Mô tả đối tượng sắp xóa + hậu quả. */
  description?: ReactNode;
  /** Danh sách tên khi xóa nhiều mục. */
  items?: string[];
  /** true = đang xóa: khóa input/nút, hiện busyLabel. */
  busy?: boolean;
  busyLabel?: string;
  confirmLabel?: string;
  /** Lỗi từ lần xóa trước (nếu có) - hiển thị trong modal. */
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t, tf } = useT();
  const [text, setText] = useState("");

  // Mỗi lần mở lại modal thì input về rỗng - không "nhớ" DELETE của lần trước
  useEffect(() => {
    if (open) setText("");
  }, [open]);

  const confirmed = text === CONFIRM_TEXT;

  // Dấu X và nút Hủy đi CHUNG một đường - đang xóa thì cả hai cùng bị chặn
  function close() {
    if (!busy) onClose();
  }

  return (
    <Modal
      title={
        <span className="text-[var(--danger)]">
          {title ?? t("confirm.title")}
        </span>
      }
      open={open}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !confirmed}
            onClick={onConfirm}
          >
            <Trash2 size={14} strokeWidth={2} />
            {busy
              ? (busyLabel ?? t("common.deleting"))
              : (confirmLabel ?? t("common.delete"))}
          </Button>
        </>
      }
    >
      {/* Lỗi lần xóa trước: banner ở ĐẦU thân modal như mọi modal khác, không
          phải một dòng chữ đỏ trần lẫn vào phần mô tả */}
      {error && (
        <ErrorBanner
          message={<span className="whitespace-pre-line">{error}</span>}
        />
      )}
      {description && <div className="text-sm">{description}</div>}
      {items && items.length > 0 && (
        <Panel>
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {items.map((item) => (
              <li key={item} className="break-all text-sm font-medium">
                {item}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Field
        htmlFor="confirm-delete-text"
        label={
          <>
            {t("confirm.type-before")}{" "}
            <code className="rounded bg-[var(--danger-bg)] px-1 text-xs font-semibold text-[var(--danger)]">
              {CONFIRM_TEXT}
            </code>{" "}
            {t("confirm.type-after")}
          </>
        }
      >
        <input
          id="confirm-delete-text"
          className="input"
          autoFocus
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && confirmed && !busy) onConfirm();
          }}
          placeholder={CONFIRM_TEXT}
          aria-label={tf("confirm.type-aria", { text: CONFIRM_TEXT })}
        />
      </Field>
    </Modal>
  );
}
