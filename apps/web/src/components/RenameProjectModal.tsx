"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { useT } from "@/lib/i18n";

/**
 * Modal "Đổi tên project" cho TRANG DANH SÁCH - video và ảnh dùng chung.
 *
 * Trang danh sách dùng modal, trang chi tiết sửa thẳng trên tiêu đề
 * (EditableTitle): trong bảng thì một ô input chen vào giữa hàng sẽ đẩy cả cột
 * xô lệch, còn ở trang chi tiết thì tên đứng riêng nên sửa tại chỗ là gọn nhất.
 *
 * ID KHÔNG ĐỔI - dòng gợi ý bên dưới nói rõ điều đó, vì đổi tên mà thư mục vẫn
 * mang tên cũ là chuyện dễ gây bất ngờ.
 */
export function RenameProjectModal({
  target,
  rename,
  onClose,
  onRenamed,
  hintKey = "projects.rename-hint",
}: {
  /** Project cần đổi tên - null = modal đóng. */
  target: { id: string; name: string } | null;
  rename: (id: string, name: string) => Promise<unknown>;
  onClose: () => void;
  /** Đổi tên xong - caller tự tải lại danh sách. */
  onRenamed: () => void | Promise<void>;
  hintKey?: string;
}) {
  const { t, tf } = useT();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mỗi lần mở modal → nạp lại tên hiện tại. Dep theo giá trị nguyên thủy để
  // object literal mới mỗi render không nuốt mất chữ người dùng đang gõ.
  const targetId = target?.id ?? null;
  const targetName = target?.name ?? null;
  useEffect(() => {
    if (targetId !== null) {
      setName(targetName ?? targetId);
      setError(null);
    }
  }, [targetId, targetName]);

  async function onSave() {
    if (!target || saving) return;
    const next = name.trim();
    // Xóa trắng tên rồi lưu: báo lỗi rõ ràng thay vì lặng lẽ giữ tên cũ
    if (!next) {
      setError(t("projects.name-required"));
      return;
    }
    if (next === target.name) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await rename(target.id, next);
      onClose();
      await onRenamed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Dấu X và nút Hủy đi CHUNG một đường - đang lưu thì cả hai cùng bị chặn
  function close() {
    if (!saving) onClose();
  }

  return (
    <Modal
      title={t("projects.rename-title")}
      open={target !== null}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" disabled={saving} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button disabled={saving} onClick={onSave}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
      <Field
        label={t("common.name")}
        htmlFor="rename-project-name"
        hint={tf(hintKey, { id: target?.id ?? "" })}
      >
        <input
          id="rename-project-name"
          className="input"
          autoFocus
          value={name}
          disabled={saving}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSave();
            }
          }}
          placeholder={t("projects.name-placeholder")}
        />
      </Field>
    </Modal>
  );
}
