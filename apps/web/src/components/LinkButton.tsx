"use client";

/**
 * Trông như <Button>, nhưng THẬT SỰ là một đường dẫn: tải file về, mở tài liệu
 * ngoài, đi sang trang khác.
 *
 * VÌ SAO CẦN RIÊNG: `<Button>` render ra `<button>`, mà `<button>` thì không
 * tải file được và không mở tab mới được. Trước đợt đại tu, bốn chỗ giải quyết
 * bằng cách chép tay `className="btn btn-secondary btn-sm"` lên thẻ `<a>` -
 * đúng hình dạng nhưng nằm ngoài hệ thống, nên hôm nào `.btn` đổi thì bốn chỗ
 * đó âm thầm lệch lại.
 *
 * Dùng ĐÚNG khi đích đến là một URL. Còn hành động chạy trong trang (mở modal,
 * gọi API) thì vẫn là `<Button>` - cho nó cái vỏ link chỉ làm người dùng tưởng
 * mở được ở tab mới.
 */

import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "primary" | "secondary" | "destructive";

export function LinkButton({
  href,
  variant = "secondary",
  small = false,
  external = false,
  download = false,
  children,
  className = "",
  ...rest
}: {
  href: string;
  variant?: Variant;
  small?: boolean;
  /** Mở tab mới - tự kèm rel="noreferrer noopener" */
  external?: boolean;
  /** Tải file về thay vì điều hướng */
  download?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
  "aria-label"?: string;
}) {
  const cls = `btn btn-${variant} ${small ? "btn-sm" : ""} ${className}`;

  // download và external đều phải là thẻ <a> thật: next/link chặn điều hướng
  // để làm chuyển trang phía client, nên nó nuốt luôn cả hai hành vi này.
  if (external || download) {
    return (
      <a
        href={href}
        className={cls}
        download={download || undefined}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer noopener" : undefined}
        {...rest}
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}
