import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  /** Câu ngắn nói RÕ đang trống cái gì. Bỏ trống thì chỉ hiện mô tả. */
  title?: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    // py-10 chứ không py-6: ô trống bị bóp sát trông như đang tải dở, còn chừa
    // thoáng ra thì đọc được ngay là "chỗ này chưa có gì, đúng như vậy".
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Icon
        size={22}
        strokeWidth={1.5}
        className="text-[var(--text-muted)] opacity-40"
        aria-hidden="true"
      />
      {title && <p className="text-sm font-medium">{title}</p>}
      {/* 14px: đây thường là câu DUY NHẤT trên màn hình lúc danh sách rỗng -
          thu nhỏ đúng cái câu cần đọc nhất thì vô lý. */}
      <p className="max-w-sm text-sm text-[var(--text-muted)]">{description}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
