import type { ReactNode } from "react";
import { InfoHint } from "@/components/InfoHint";

export function PageHeader({
  title,
  hint,
  subtitle,
  center,
  actions,
}: {
  title: ReactNode;
  /** Khóa i18n cho nút (i) cạnh tiêu đề trang - dùng ở mọi trang danh sách */
  hint?: { titleKey: string; bodyKey: string };
  subtitle?: ReactNode;
  /** Nội dung giữa hàng header (vd timeline giai đoạn) - cùng hàng, wrap khi hẹp. */
  center?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    // KHÔNG có mb-4 nữa. Mọi trang đều bọc nội dung trong `flex flex-col gap-4`,
    // nên mb-4 ở đây cộng dồn thành 32px dưới tiêu đề trong khi mọi khoảng cách
    // khác của trang là 16px - đúng cái làm trang trông rời rạc, tưởng tiêu đề
    // không thuộc về nội dung bên dưới. Khoảng cách giờ do gap của trang lo.
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex min-w-0 items-center gap-2 text-xl font-semibold">
          <span className="min-w-0">{title}</span>
          {hint && (
            <InfoHint
              titleKey={hint.titleKey}
              bodyKey={hint.bodyKey}
              size={15}
            />
          )}
        </h1>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {/* Hàng 2: subtitle (kích thước/fps) bên trái + center (timeline) kéo dài
          phần còn lại của hàng - tới lề phải vùng nội dung */}
      {(subtitle || center) && (
        <div className="mt-1 flex flex-wrap items-center gap-y-2">
          {subtitle && (
            <p
              className={`shrink-0 text-sm text-[var(--text-muted)] ${
                center ? "xl:basis-[calc(100%/3)]" : ""
              }`}
            >
              {subtitle}
            </p>
          )}
          {/* Timeline chiếm phần còn lại - mép trái ≈ cột Kịch bản edit, mép phải = hết vùng nội dung */}
          {center && <div className="min-w-64 max-w-full flex-1">{center}</div>}
        </div>
      )}
    </div>
  );
}
