"use client";

/**
 * Một ô nhập liệu hoàn chỉnh: nhãn + control + gợi ý + lỗi.
 *
 * VÌ SAO CÓ FILE NÀY: trước đợt đại tu, cùng một khái niệm "nhãn của ô nhập"
 * được viết bằng BẢY cách khác nhau và render ra ba cỡ chữ khác nhau tùy file -
 * 12px muted trong AutoCutCreateModal/ProjectClipsCard, 13px muted qua class
 * `.label`, 14px đậm màu chữ chính trong BriefFields. Cùng một biểu mẫu, nhãn
 * mỗi dòng một kiểu. Ở đây chốt đúng một cách.
 *
 * Nhãn dùng `.label` (13px/500 muted) - ĐÚNG BẬC PHỤ CHÚ, vì nhãn là thứ chỉ
 * đường, còn thứ người dùng đọc là giá trị họ gõ vào (14px của `.input`). Nhãn
 * to bằng nội dung thì cả biểu mẫu thành một khối chữ đều đều.
 *
 * ```tsx
 * <Field label={t("clone.new-name")} htmlFor="clone-name" hint={t("clone.id-hint")}>
 *   <input id="clone-name" className="input" value={name} onChange={…} />
 * </Field>
 * ```
 *
 * Nhóm control không focus được (chùm radio, chùm chip) thì bỏ `htmlFor` -
 * component tự đổi <label> thành <span> để không sinh ra nhãn trỏ vào hư không.
 */

import type { ReactNode } from "react";
import { InfoHint } from "@/components/InfoHint";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  hintKeys,
  required = false,
  children,
  className = "",
}: {
  label: ReactNode;
  /** id của control bên trong. Bỏ trống = nhãn render thành <span> (nhóm radio…) */
  htmlFor?: string;
  /** Câu gợi ý dưới control - bậc phụ chú 13px */
  hint?: ReactNode;
  /** Lỗi của RIÊNG ô này. Có lỗi thì thay chỗ gợi ý, không xếp chồng hai dòng. */
  error?: string | null;
  /** Khóa i18n cho nút (i) cạnh nhãn, khi cần giải thích dài hơn một câu */
  hintKeys?: { titleKey: string; bodyKey: string };
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div className={`flex min-w-0 flex-col ${className}`}>
      <span className="mb-1 flex items-center gap-1">
        <Label className="label mb-0" htmlFor={htmlFor}>
          {label}
          {required && (
            <span className="ml-0.5 text-[var(--danger)]" aria-hidden="true">
              *
            </span>
          )}
        </Label>
        {hintKeys && (
          <InfoHint titleKey={hintKeys.titleKey} bodyKey={hintKeys.bodyKey} />
        )}
      </span>

      {children}

      {/* Lỗi và gợi ý HIỆN CÙNG LÚC, lỗi ở trên.
          Bản đầu cho lỗi thay chỗ gợi ý để tránh hai dòng xám chồng nhau, nhưng
          rà soát lại thấy đúng những lúc cần nhất thì nó giấu mất thứ cần nhất:
          ô chọn AI bóc lời hiện lỗi "provider này chưa dùng được" và nuốt luôn
          dòng nói provider nào có phân vai người nói - tức là nuốt đúng câu
          giúp người dùng chọn cái khác. Hai dòng phân biệt được bằng màu (đỏ vs
          xám) nên không lẫn vào nhau. */}
      {error && <p className="mt-1 text-meta text-[var(--danger)]">{error}</p>}
      {hint && <p className="mt-1 text-meta text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

/**
 * Hàng công tắc: nhãn + mô tả bên trái, <Switch> bên phải.
 * Nhãn ở đây LÀ nội dung (14px) chứ không phải nhãn chỉ đường như trong Field -
 * người dùng đọc chính câu đó để quyết định bật hay tắt.
 */
export function SwitchField({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  hintKeys,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hintKeys?: { titleKey: string; bodyKey: string };
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="flex items-center gap-1">
          <label
            id={`${id}-label`}
            htmlFor={id}
            className={`text-sm font-medium ${
              disabled ? "opacity-50" : "cursor-pointer"
            }`}
          >
            {label}
          </label>
          {hintKeys && (
            <InfoHint titleKey={hintKeys.titleKey} bodyKey={hintKeys.bodyKey} />
          )}
        </span>
        {hint && (
          <p className="mt-0.5 text-meta text-[var(--text-muted)]">{hint}</p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        // Nút này KHÔNG có chữ nào bên trong, nên tên của nó hoàn toàn phụ
        // thuộc vào nhãn. `<label for>` trỏ vào <button> là hợp lệ và trình
        // duyệt có tôn trọng, nhưng thêm aria-labelledby thì không còn phải
        // trông chờ vào chuyện đó nữa - `label` là ReactNode nên không rút ra
        // được chuỗi để đặt aria-label trực tiếp.
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`switch mt-0.5 ${disabled ? "opacity-50" : ""}`}
      />
    </div>
  );
}

/**
 * Hàng checkbox: ô tick + nhãn + mô tả. Cùng bậc chữ với SwitchField để hai
 * kiểu bật/tắt này đứng chung một biểu mẫu mà không đá nhau.
 */
export function CheckboxField({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  hintKeys,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hintKeys?: { titleKey: string; bodyKey: string };
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="checkbox mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="min-w-0">
        <span className="flex items-center gap-1">
          <label
            htmlFor={id}
            className={`text-sm ${disabled ? "opacity-50" : "cursor-pointer"}`}
          >
            {label}
          </label>
          {hintKeys && (
            <InfoHint titleKey={hintKeys.titleKey} bodyKey={hintKeys.bodyKey} />
          )}
        </span>
        {hint && (
          <p className="mt-0.5 text-meta text-[var(--text-muted)]">{hint}</p>
        )}
      </div>
    </div>
  );
}
