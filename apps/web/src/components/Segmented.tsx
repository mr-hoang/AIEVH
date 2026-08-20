"use client";

/**
 * Chọn MỘT trong vài lựa chọn ngắn: vi/en, sáng/tối, 16:9 / 9:16, số worker,
 * số ngày trên biểu đồ…
 *
 * Render ra TỪNG NÚT RỜI, mỗi nút một viền, nút đang chọn tô màu thương hiệu.
 * Cố ý không còn là "thanh phân đoạn" (cả nhóm trong một khung xám, mục đang
 * chọn nổi lên bằng nền trắng): kiểu đó gom thành một thanh ngang dài, phải dò
 * mới thấy ô nào đang sáng. Nút rời thì liếc một cái là ra.
 *
 * Thay cho 6 biến thể tự chế trước đây - 3 bán kính khác nhau, 3 kiểu padding,
 * 2 màu chữ lúc không được chọn, và một bản còn quên cả role.
 *
 * Lựa chọn "to" cần tiêu đề + mô tả thì dùng <OptionCard> chứ không phải cái
 * này: nhãn dài nhét vào một nút là vỡ hàng ngay trên màn hẹp.
 *
 * ```tsx
 * <Segmented
 *   label={t("brief.aspect")}
 *   value={aspect}
 *   onChange={setAspect}
 *   options={[{ value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }]}
 * />
 * ```
 */

import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Tooltip - dùng khi nhãn phải ngắn nhưng ý nghĩa cần một câu */
  title?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled = false,
  size = "sm",
  className = "",
}: {
  /** Nhãn nhóm cho trình đọc màn hình - nhóm radio không có nhãn thì chỉ đọc
      được từng mục rời rạc, không biết đang chọn cái gì */
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  disabled?: boolean;
  /**
   * sm (30px, mặc định - khớp `.btn-sm`) cho biểu mẫu và toolbar;
   * md (36px - khớp `.btn` và `.input`) khi nằm cùng HÀNG NGANG với ô nhập
   * hoặc nút, vì lệch 4px giữa các control cạnh nhau nhìn ra ngay.
   */
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      className={`seg ${size === "md" ? "seg-md" : ""} ${className}`}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          title={opt.title}
          disabled={disabled || opt.disabled}
          onClick={() => onChange(opt.value)}
          className="seg-item"
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
