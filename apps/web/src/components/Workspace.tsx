"use client";

/**
 * Bộ khối dựng sẵn cho khu làm việc 3 cột. Mọi trang chi tiết (Videos Project,
 * Text to video, Dịch video, Auto cut…) lắp bằng đúng bộ này chứ không tự chế
 * lưới riêng nữa.
 *
 * Ba cột theo NHỊP LÀM VIỆC, không theo số thứ tự bước:
 *   1. `source` - thứ mình BẮT ĐẦU TỪ ĐÓ: bài viết, video gốc, transcript.
 *   2. `setup`  - yêu cầu và thiết lập: giọng đọc, cấu hình video, nút chạy.
 *   3. `output` - mọi thứ SINH RA trong lúc chạy: video thành phẩm, scene,
 *      render, QC, ảnh/video do AI tạo.
 *
 * Khối ĐẦU TIÊN của cột 3 luôn là `OutputBlock` - lúc chạy nó hiện hoạt ảnh chờ,
 * xong thì hiện thẳng video. Người dùng liếc một chỗ là biết đang ở đâu.
 *
 * Bề rộng cột do container query quyết định (xem `.workspace-grid` trong
 * globals.css), KHÔNG do media query và không do phép tính pixel tay: bề rộng
 * thật của workspace còn phụ thuộc rail trái và panel phải đang gấp hay mở.
 *
 * ```tsx
 * const SETUP = ["source", "voice", "config"] as const;
 * const group = useCollapseGroup({ keys: SETUP, finished: status === "done" });
 *
 * <Workspace>
 *   <WorkspaceColumn role="source" title={t("workspace.col.source")}>
 *     <WorkspaceBlock
 *       id="src"
 *       title={t("ttv.card-source")}
 *       summary={sourceSummary}
 *       collapsed={group.isCollapsed("source")}
 *       onToggle={() => group.toggle("source")}
 *     >
 *       <SourceEditor />
 *     </WorkspaceBlock>
 *   </WorkspaceColumn>
 *
 *   <WorkspaceColumn role="setup" title={t("workspace.col.setup")}>…</WorkspaceColumn>
 *
 *   <WorkspaceColumn role="output" title={t("workspace.col.output")}>
 *     <OutputBlock
 *       status={status}
 *       videoUrl={outputUrl}
 *       progress={job?.progress ?? null}
 *       step={job?.step}
 *       aspect="9 / 16"
 *     />
 *     <WorkspaceBlock id="qc" title="QC" summary={qcSummary}>…</WorkspaceBlock>
 *   </WorkspaceColumn>
 * </Workspace>
 * ```
 */

import {
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Download,
  Loader2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { ProgressBar } from "@/components/ProgressBar";
import { useT } from "@/lib/i18n";

/** Trạng thái công việc mà cột kết quả phản ánh. */
export type WorkspaceStatus = "idle" | "running" | "done" | "failed";

/** Vai trò của cột - quyết định luôn cách cột xẹp khi màn hẹp lại. */
export type WorkspaceRole = "source" | "setup" | "output";

// ================================ Workspace =================================

export function Workspace({
  children,
  ariaLabel,
  className = "",
}: {
  /** Đúng thứ tự DOM: source → setup → output. Màn hẹp xẹp về một cột theo
      thứ tự này, nên cột kết quả tự động nằm cuối - đúng thứ mong muốn. */
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useT();
  return (
    // Lớp ngoài chỉ để làm container query. CỐ Ý không đặt container-type lên
    // <main> của Shell: làm thế là mọi trang trong app đều bị đóng khung, còn ở
    // đây phạm vi gói gọn trong đúng workspace.
    <div className={`workspace ${className}`}>
      <div
        className="workspace-grid"
        role="group"
        aria-label={ariaLabel ?? t("workspace.aria")}
      >
        {children}
      </div>
    </div>
  );
}

// ============================= WorkspaceColumn ==============================

export function WorkspaceColumn({
  role,
  title,
  ariaLabel,
  actions,
  children,
  className = "",
}: {
  role: WorkspaceRole;
  /** Tiêu đề cột - chữ nhỏ in hoa, cố ý KHÔNG dùng heading to (tối đa 2 cấp) */
  title?: ReactNode;
  /** Nhãn cho trình đọc màn hình; bỏ trống thì lấy nhãn mặc định theo `role` */
  ariaLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  return (
    <section
      className={`workspace-col workspace-col-${role} flex min-w-0 flex-col gap-4 ${className}`}
      aria-label={ariaLabel ?? t(`workspace.col.${role}`)}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {title && <h2 className="workspace-col-title min-w-0">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

// ============================== WorkspaceBlock ==============================

export interface WorkspaceBlockProps {
  /** id vùng nội dung - nút gấp/mở trỏ vào đây bằng aria-controls, phải duy nhất */
  id: string;
  title: ReactNode;
  /** Khóa i18n cho nút (i) cạnh tiêu đề khối - chuyển thẳng xuống <Card> */
  hint?: { titleKey: string; bodyKey: string };
  /** Một dòng cho biết bên trong có gì - CHỈ hiện lúc đang gấp */
  summary?: ReactNode;
  icon?: LucideIcon;
  /** Nút hành động của khối - tự ẩn khi gấp (xem lý do trong thân component) */
  actions?: ReactNode;
  /** Có truyền = khối được điều khiển từ ngoài (thường là useCollapseGroup) */
  collapsed?: boolean;
  /** Chỉ dùng khi KHÔNG điều khiển từ ngoài - giá trị khởi tạo */
  defaultCollapsed?: boolean;
  /** Nhận giá trị gấp/mở MỚI, không phải giá trị cũ */
  onToggle?: (collapsed: boolean) => void;
  children: ReactNode;
  className?: string;
}

export function WorkspaceBlock({
  id,
  title,
  hint,
  summary,
  icon: Icon,
  actions,
  collapsed,
  defaultCollapsed = false,
  onToggle,
  children,
  className = "",
}: WorkspaceBlockProps) {
  const { t } = useT();
  const [internal, setInternal] = useState(defaultCollapsed);
  const controlled = collapsed !== undefined;
  const isCollapsed = controlled ? collapsed : internal;

  function toggle() {
    const next = !isCollapsed;
    if (!controlled) setInternal(next);
    onToggle?.(next);
  }

  const label = isCollapsed
    ? t("workspace.block.expand")
    : t("workspace.block.collapse");

  return (
    <Card
      className={className}
      hint={hint}
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          {Icon && (
            <Icon
              size={15}
              strokeWidth={1.75}
              className="shrink-0 text-[var(--text-muted)]"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0">{title}</span>
        </span>
      }
      actions={
        // min-w-0 + flex-wrap: cột hẹp thì nút hành động xuống hàng chứ không đẩy
        // nút gấp/mở tràn ra khỏi card
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {/* Gấp rồi thì giấu nút hành động: bấm "Viết lại" trong khi không nhìn
              thấy nội dung cũ là ghi đè bản đang có mà không kịp biết mình mất gì */}
          {!isCollapsed && actions}
          <Button
            variant="secondary"
            small
            onClick={toggle}
            aria-expanded={!isCollapsed}
            aria-controls={id}
          >
            {isCollapsed ? (
              <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
            )}
            {label}
          </Button>
        </div>
      }
    >
      {isCollapsed && summary != null && (
        <p className="truncate text-meta text-[var(--text-muted)]">{summary}</p>
      )}
      {/* Thân khối GIỮ NGUYÊN trong DOM và chỉ bị `hidden`, KHÔNG tháo ra: bên
          trong là các card tự đi lấy dữ liệu (VoicePicker, StyleSelect,
          ProjectQcCard…), tháo ra lắp lại là bắt chúng fetch lại từ đầu mỗi lần
          bấm gấp/mở - vài cú bấm thành một cơn bão request. */}
      <div id={id} hidden={isCollapsed}>
        {children}
      </div>
    </Card>
  );
}

// ================================ OutputBlock ===============================

export interface OutputBlockProps {
  status: WorkspaceStatus;
  /** URL video thành phẩm - chỉ được dùng khi status = "done" */
  videoUrl?: string | null;
  /** Ảnh nền lúc video chưa phát */
  posterUrl?: string | null;
  /** 0-100. null/undefined lúc đang chạy = chưa đo được → thanh vô định */
  progress?: number | null;
  /** Tên bước hiện tại, hiện cạnh phần trăm */
  step?: string;
  /** Tỉ lệ khung hình của project, ví dụ "9 / 16" cho video dọc */
  aspect?: string;
  error?: string | null;
  title?: ReactNode;
  /** Khóa i18n cho nút (i) cạnh tiêu đề - chuyển thẳng xuống WorkspaceBlock/Card */
  hint?: { titleKey: string; bodyKey: string };
  summary?: ReactNode;
  actions?: ReactNode;
  /** Nội dung thêm dưới video: chip thời lượng, link sang project… */
  children?: ReactNode;
  id?: string;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onToggle?: (collapsed: boolean) => void;
}

/**
 * Khối ĐẦU TIÊN của cột kết quả. Ba trạng thái, không có trạng thái thứ tư:
 * - chưa chạy  → khung rỗng nói rõ cần làm gì;
 * - đang chạy  → khung nhấp nháy + thanh tiến trình (hoặc thanh vô định);
 * - xong       → chính cái video, xem và tải ngay tại chỗ.
 *
 * Mặc định KHÔNG gấp: đây là thứ người dùng vào trang để xem.
 */
export function OutputBlock({
  status,
  videoUrl,
  posterUrl,
  progress,
  step,
  aspect = "16 / 9",
  error,
  title,
  hint,
  summary,
  actions,
  children,
  id = "workspace-output",
  collapsed,
  defaultCollapsed = false,
  onToggle,
}: OutputBlockProps) {
  const { t } = useT();

  const statusText =
    status === "running"
      ? t("workspace.output.running")
      : status === "done"
        ? videoUrl
          ? t("workspace.output.done")
          : t("workspace.output.no-video")
        : status === "failed"
          ? t("workspace.output.failed")
          : t("workspace.output.idle");

  return (
    <WorkspaceBlock
      id={id}
      icon={Clapperboard}
      title={title ?? t("workspace.output.title")}
      hint={hint}
      summary={summary ?? statusText}
      collapsed={collapsed}
      defaultCollapsed={defaultCollapsed}
      onToggle={onToggle}
      actions={actions}
    >
      <div className="flex flex-col gap-3">
        <div
          className="workspace-media"
          // Tỉ lệ đi qua biến CSS chứ không qua class Tailwind: giá trị đến từ
          // meta.json của project, không phải danh sách cố định biết trước.
          style={{ "--workspace-aspect": aspect } as CSSProperties}
        >
          {status === "done" && videoUrl ? (
            <video
              key={videoUrl}
              src={videoUrl}
              poster={posterUrl ?? undefined}
              controls
              preload="metadata"
              className="workspace-video"
            />
          ) : status === "running" ? (
            <>
              <span className="workspace-shimmer" aria-hidden="true" />
              <div
                className="relative flex flex-col items-center gap-2 px-4 text-center"
                role="status"
                aria-live="polite"
              >
                <Loader2
                  size={22}
                  strokeWidth={1.75}
                  className="animate-spin text-[var(--text-muted)]"
                  aria-hidden="true"
                />
                <p className="text-sm text-[var(--text-muted)]">
                  {step ? `${statusText} · ${step}` : statusText}
                </p>
              </div>
            </>
          ) : status === "failed" ? (
            <EmptyState
              icon={TriangleAlert}
              description={error || t("workspace.output.failed")}
            />
          ) : (
            <EmptyState
              icon={Clapperboard}
              description={
                status === "done" ? t("workspace.output.no-video") : t("workspace.output.idle")
              }
            />
          )}
        </div>

        {status === "running" &&
          (progress == null ? (
            <div
              className="progress-indeterminate"
              role="progressbar"
              aria-label={statusText}
            />
          ) : (
            <ProgressBar progress={progress} step={step} />
          ))}

        {status === "done" && videoUrl && (
          <a
            href={videoUrl}
            download
            className="inline-flex w-fit items-center gap-2 text-meta text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
          >
            <Download size={14} strokeWidth={2} aria-hidden="true" />
            {t("workspace.output.download")}
          </a>
        )}

        {children}
      </div>
    </WorkspaceBlock>
  );
}

// Tiện cho trang import một chỗ thay vì hai
export { useCollapseGroup } from "@/lib/useCollapsible";
export type { CollapseGroup } from "@/lib/useCollapsible";
