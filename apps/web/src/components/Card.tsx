"use client";

import type { ReactNode } from "react";
import { InfoHint } from "@/components/InfoHint";

export function Card({
  title,
  hint,
  actions,
  children,
  className = "",
}: {
  /** ReactNode chứ không chỉ string - để gắn được badge trạng thái cạnh tiêu đề */
  title?: ReactNode;
  /**
   * Khóa i18n cho nút (i) cạnh tiêu đề. Trước đây mỗi nơi tự bọc
   * `<span className="inline-flex items-center gap-1.5">{title}<InfoHint/></span>`
   * - bốn bản chép y hệt trong ProjectBriefCard, ProjectQcCard, ProjectClipsCard
   * và Workspace. Thành prop thì tiêu đề luôn thẳng hàng với nút (i).
   */
  hint?: { titleKey: string; bodyKey: string };
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {/* flex-wrap: cột hẹp (bố cục 3 cột ở 1280-1536px) không đủ chỗ cho tiêu đề
          + nút trên một hàng. Không cho wrap thì tiêu đề bị bóp vỡ thành nhiều dòng
          CÒN nút vẫn tràn ra ngoài card - đã gặp thật ở card "Nguồn & Asset".
          Cho wrap thì nút tự xuống hàng dưới, tiêu đề giữ nguyên một dòng. */}
      {/* `hint` cũng phải kích hoạt hàng header: nằm trong `{title && …}` thì
          <Card hint={…}> mà quên `title` sẽ NUỐT LUÔN nút (i) không một tiếng
          động - lỗi kiểu đó không ai phát hiện ra cho tới lúc người dùng đi tìm
          phần giải thích và không thấy đâu. */}
      {(title || hint || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {(title || hint) && (
            <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              {title && <span className="min-w-0">{title}</span>}
              {hint && (
                <InfoHint
                  titleKey={hint.titleKey}
                  bodyKey={hint.bodyKey}
                  size={14}
                />
              )}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
