"use client";

/**
 * Nút chỉ có icon. `label` là BẮT BUỘC - nút không có chữ thì trình đọc màn
 * hình chỉ còn mỗi cái tên này để đọc, và nó cũng là tooltip lúc rê chuột.
 *
 * Trước đợt đại tu có hơn 10 bản chép tay của cùng chuỗi class này, ở bốn cỡ
 * (p-1, p-1.5, h-7, h-8, h-9) và ba màu nền hover khác nhau - có lúc ba cỡ đứng
 * cạnh nhau trong đúng một ô của bảng (trang Sound Effects: Star 32px, Pencil
 * 32px, Delete 30px). Giờ chỉ còn hai cỡ:
 *   md (mặc định) 30px - thẳng hàng với `.btn-sm`, dùng ở header card/toolbar;
 *   sm            24px - trong hàng bảng dày đặc.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export function IconButton({
  label,
  size = "md",
  tone = "default",
  children,
  className = "",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  /** Vừa là aria-label vừa là tooltip - nút icon không có chữ nào khác */
  label: string;
  size?: "sm" | "md";
  /** danger = chỉ đỏ lúc hover; đỏ sẵn thì mỗi hàng bảng có một chấm đỏ */
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-btn ${size === "sm" ? "icon-btn-sm" : ""} ${
        tone === "danger" ? "icon-btn-danger" : ""
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
