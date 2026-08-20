"use client";

/**
 * Ô số liệu của Dashboard: một con số to, một nhãn, một dòng phụ.
 *
 * Trước đợt đại tu component này nằm ngay trong app/page.tsx, và ô "hàng chờ"
 * thì lại được chép tay thành một card riêng ở hàng khác với cỡ chữ khác - cùng
 * một loại thông tin mà hai hình dạng. Tách ra đây để mọi con số tổng quan
 * trông như nhau.
 *
 * Con số 28px/700 theo đúng spec (trước đây là 24px ở cả hai bản chép).
 */

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  href,
}: {
  label: string;
  value: ReactNode;
  /** Dòng phụ dưới nhãn - vd "12 xong · 1 lỗi" */
  sub?: ReactNode;
  icon?: LucideIcon;
  /** Có href thì cả ô bấm được - số liệu nào cũng nên dẫn tới nơi xem chi tiết */
  href?: string;
}) {
  const body = (
    <>
      {/* Icon KHÔNG absolute nữa: bản cũ đặt nó absolute góc phải và con số
          không chừa lề phải, nên giá trị dài (1.24M) chui xuống dưới icon.
          Xếp hàng ngang thì icon tự bị đẩy, không bao giờ chồng. */}
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-[28px] leading-tight font-bold tabular-nums">
          {value}
        </p>
        {Icon && (
          <Icon
            size={18}
            strokeWidth={1.75}
            className="mt-1 shrink-0 text-[var(--text-muted)]"
            aria-hidden="true"
          />
        )}
      </div>
      <p className="mt-1 text-sm font-medium">{label}</p>
      {sub && <p className="text-meta text-[var(--text-muted)]">{sub}</p>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="card transition-colors duration-150 hover:border-[var(--text-muted)]"
      >
        {body}
      </Link>
    );
  }
  return <div className="card">{body}</div>;
}
