"use client";

/**
 * Thông báo cấp trang/cấp card: lỗi tải, lưu xong, cảnh báo trước khi chạy.
 *
 * Trước đợt đại tu chỉ có mỗi <ErrorBanner>, nên mọi thông báo KHÔNG phải lỗi
 * đều được chế tay tại chỗ: trang Skills một kiểu, Phong cách dựng một kiểu,
 * Style Design một kiểu, Images một kiểu - bốn hộp "đã lưu" khác nhau. Còn lỗi
 * thì ngoài banner này lại có thêm ba kiểu chữ đỏ trần (12px, 13px, 14px).
 *
 * LUẬT: lỗi và thông báo của cả trang/cả card thì dùng component này. Lỗi của
 * RIÊNG một ô nhập thì dùng prop `error` của <Field> - nó nằm ngay dưới ô sai,
 * đúng chỗ người dùng đang nhìn.
 */

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";

export type BannerTone = "danger" | "success" | "info" | "muted";

const ICON: Record<BannerTone, LucideIcon> = {
  danger: AlertTriangle,
  success: CheckCircle2,
  info: Info,
  muted: Info,
};

const ICON_COLOR: Record<BannerTone, string> = {
  danger: "text-[var(--danger)]",
  success: "text-[var(--success)]",
  info: "text-[var(--primary)]",
  muted: "text-[var(--text-muted)]",
};

export function Banner({
  tone = "info",
  message,
  detail,
  actions,
  children,
}: {
  tone?: BannerTone;
  message: ReactNode;
  /** Log gốc / nguyên văn lỗi - gấp lại được, KHÔNG BAO GIỜ nuốt mất */
  detail?: string | null;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useT();
  const [openDetail, setOpenDetail] = useState(false);
  const Icon = ICON[tone];

  return (
    <div className={`banner banner-${tone}`}>
      <div className="flex items-start gap-2">
        <Icon
          size={16}
          strokeWidth={2}
          className={`mt-0.5 shrink-0 ${ICON_COLOR[tone]}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p>{message}</p>
          {children}
          {detail && (
            <>
              <button
                type="button"
                onClick={() => setOpenDetail((v) => !v)}
                className="mt-1 inline-flex items-center gap-1 text-meta font-medium text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
                aria-expanded={openDetail}
              >
                {openDetail ? (
                  <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
                )}
                {t("common.details")}
              </button>
              {openDetail && (
                <pre className="mt-2 max-h-48 overflow-auto rounded-[var(--radius)] bg-[var(--surface)] p-2 font-mono text-meta whitespace-pre-wrap">
                  {detail}
                </pre>
              )}
            </>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
