"use client";

/**
 * Thẻ lựa chọn: tiêu đề + mô tả + (tùy chọn) icon và badge. Dùng khi lựa chọn
 * cần giải thích - chế độ cắt, engine giọng đọc, phong cách dựng, tỉ lệ khung
 * hình có kèm mô tả.
 *
 * Trước đợt đại tu có 5 bản dựng tay (AutoCutCreateModal ×2, VideoStyleSelect,
 * VoicePicker, ImageProjectForm): mỗi bản một padding, một cỡ chữ, và hai bản
 * quên hẳn role="radio" nên bàn phím không chọn được.
 *
 * Bọc bằng <OptionCardGroup> để nhóm có nhãn - nhóm radio không nhãn thì trình
 * đọc màn hình không nói được người dùng đang chọn cái gì.
 */

import { Check, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function OptionCardGroup({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  /** Mặc định lưới tự co; truyền class riêng khi cần số cột cố định */
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`grid gap-2 ${className || "grid-cols-[repeat(auto-fit,minmax(160px,1fr))]"}`}
    >
      {children}
    </div>
  );
}

export function OptionCard({
  selected,
  onSelect,
  title,
  titleText,
  description,
  icon: Icon,
  badge,
  disabled = false,
  className = "",
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  /**
   * Tiêu đề dạng chữ thuần cho tooltip. Tiêu đề bị `truncate` cắt cụt, mà thẻ
   * lựa chọn thường xếp lưới 2 cột trong cột hẹp - không có tooltip thì tên dài
   * (20 phong cách dựng, giọng nhân bản người dùng tự đặt) cụt luôn, không còn
   * đường nào đọc đủ. Truyền khi `title` không phải chuỗi thuần.
   */
  titleText?: string;
  /** Một câu nói rõ chọn cái này thì được gì. 13px - đọc được, không phải chữ ký */
  description?: ReactNode;
  icon?: LucideIcon;
  /** Badge nhỏ ở góc (vd "chưa cài", "khuyến nghị") */
  badge?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`option-card ${className}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {Icon && (
          <Icon
            size={16}
            strokeWidth={1.75}
            className="shrink-0 text-[var(--text-muted)]"
            aria-hidden="true"
          />
        )}
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          title={titleText ?? (typeof title === "string" ? title : undefined)}
        >
          {title}
        </span>
        {badge}
        {/* Dấu tick: màu nền --primary-soft nhạt, một mình nó chưa đủ rõ là
            "đang chọn cái này" trên màn hình sáng */}
        {selected && (
          <Check
            size={15}
            strokeWidth={2.5}
            className="shrink-0 text-[var(--primary)]"
            aria-hidden="true"
          />
        )}
      </span>
      {description && (
        <span className="text-meta text-[var(--text-muted)]">{description}</span>
      )}
    </button>
  );
}
