"use client";

/**
 * Card "QC tự động" trong trang chi tiết video project.
 * Backend đo bằng ffmpeg (âm lượng, frame đen, đứng hình, chữ lọt vùng bị UI
 * nền tảng che) và trả report ĐỒNG BỘ - một lượt đo có thể mất tới ~2 phút,
 * nên UI phải nói rõ đang đo để người dùng không tưởng trang bị treo.
 */

import { AlertTriangle, Check, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  getQcReport,
  mediaUrl,
  runProjectQc,
  type FileInfo,
  type QcReport,
  type QcStatus,
} from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { MediaPreviewModal, imageFileInfo } from "@/components/MediaPreviewModal";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

/**
 * Tone của Badge cho trạng thái tổng - chỉ dùng 3 tone có sẵn của design
 * system, không bịa tone mới. warn cố ý là chip trung tính, mức độ "cam" thể
 * hiện ở icon --danger trong bảng check bên dưới.
 */
const STATUS_TONE = {
  pass: "success",
  warn: "muted",
  fail: "danger",
} as const;

const STATUS_LABEL: Record<QcStatus, string> = {
  pass: "qc.status-pass",
  warn: "qc.status-warn",
  fail: "qc.status-fail",
};

const CHECK_ICON = {
  pass: Check,
  warn: AlertTriangle,
  fail: XCircle,
} as const;

/** Lỗi backend hay gặp - đổi sang câu song ngữ, message gốc để trong detail. */
const ERROR_KEY: Record<string, string> = {
  NO_VIDEO: "qc.err-no-video",
  FILE_NOT_FOUND: "qc.err-file-not-found",
  QC_TIMEOUT: "qc.err-timeout",
};

export function ProjectQcCard({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged?: () => void;
}) {
  const { t, tf } = useT();
  const [report, setReport] = useState<QcReport | null>(null);
  const [stale, setStale] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(
    null
  );
  const [preview, setPreview] = useState<FileInfo | null>(null);
  // Ảnh bằng chứng nằm trong renders/ nên nút "Xóa file rác" có thể quét mất -
  // ảnh nào load hỏng thì ẩn luôn, không để icon ảnh vỡ trên card.
  const [brokenFrames, setBrokenFrames] = useState<string[]>([]);

  // Gom mọi ảnh bằng chứng của các check (hiện chỉ safe-area sinh ra)
  const evidence: string[] = (report?.checks ?? [])
    .flatMap((c) => c.frames ?? [])
    .filter((rel) => !brokenFrames.includes(rel));

  const load = useCallback(async () => {
    try {
      const res = await getQcReport(projectId);
      setReport(res.report);
      setStale(res.stale === true);
    } catch (e) {
      setError({
        message: t("qc.load-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    // t đổi khi đổi ngôn ngữ - không cần nạp lại report vì thế
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onRun() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const { report: fresh } = await runProjectQc(projectId);
      setReport(fresh);
      // Vừa đo trên đúng file hiện tại nên chắc chắn không còn cũ
      setStale(false);
      onChanged?.();
    } catch (e) {
      const known = e instanceof ApiError ? ERROR_KEY[e.code] : undefined;
      setError({
        message: known ? t(known) : t("qc.run-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRunning(false);
    }
  }

  // Chỉ lấy tên file cho gọn, đường dẫn đầy đủ để trong tooltip
  const fileName = report ? report.file.split(/[\\/]/).pop() : null;

  const runButton = (
    <Button small onClick={onRun} disabled={running}>
      {running ? (
        <>
          <Loader2 size={14} strokeWidth={2} className="animate-spin" />
          {t("qc.running")}
        </>
      ) : (
        <>
          <ShieldCheck size={14} strokeWidth={2} />
          {report ? t("qc.rerun") : t("qc.run")}
        </>
      )}
    </Button>
  );

  return (
    <Card
      title={t("qc.title")}
      // Không shrink-0: ở cột hẹp (bố cục 4 cột) badge + nút không đủ chỗ trên
      // một hàng, cho wrap để nút xuống dòng thay vì tràn khỏi card.
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {report && (
            <Badge
              tone={STATUS_TONE[report.status] ?? "muted"}
              label={t(STATUS_LABEL[report.status] ?? "qc.status-warn")}
            />
          )}
          {runButton}
        </div>
      }
    >
      {error && <ErrorBanner message={error.message} detail={error.detail} />}

      {/* Lượt đo dài - nói rõ đang chạy ffmpeg để người dùng chờ được */}
      {running && (
        <p className="mb-3 text-meta text-[var(--text-muted)]">
          {t("qc.slow-note")}
        </p>
      )}

      {!report ? (
        !running && (
          <EmptyState
            icon={ShieldCheck}
            description={t("qc.empty")}
            action={runButton}
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {stale && <Banner tone="danger" message={t("qc.stale")} />}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-[var(--text-muted)]">
            <span>{tf("qc.checked-at", { time: formatRelative(report.checkedAt) })}</span>
            {fileName && (
              <span
                className="max-w-full truncate"
                title={tf("qc.file-title", { file: report.file })}
              >
                {fileName}
              </span>
            )}
            {report.platform && (
              <span>{tf("qc.platform", { platform: report.platform })}</span>
            )}
          </div>

          {/* Danh sách xếp chồng thay vì bảng: card này nằm ở cột hẹp, mà
              `detail` là câu văn dài (có cả khuyến nghị chỉnh bao nhiêu dB) -
              để dạng bảng thì chữ bị cắt và phải cuộn ngang mới đọc được. */}
          <ul className="flex flex-col gap-2">
            {report.checks.map((c) => {
              const Icon = CHECK_ICON[c.status] ?? AlertTriangle;
              // pass = xanh; warn/fail đều dùng --danger, phân biệt bằng
              // hình icon + nền của mục fail (không bịa màu ngoài token)
              const color =
                c.status === "pass" ? "var(--success)" : "var(--danger)";
              return (
                <li
                  key={c.id}
                  className={`flex gap-2 rounded-[var(--radius)] px-2 py-1.5 ${
                    c.status === "fail" ? "bg-[var(--danger-bg)]" : ""
                  }`}
                >
                  <Icon
                    size={14}
                    strokeWidth={2}
                    className="mt-0.5 shrink-0"
                    style={{ color }}
                    aria-label={t(STATUS_LABEL[c.status] ?? "qc.status-warn")}
                  />
                  <div className="min-w-0 flex-1">
                    {/* Nhãn là NỘI DUNG (14px), câu chi tiết là phụ chú (13px):
                        để cả hai cùng 12px thì danh sách đọc thành một khối xám,
                        không thấy được mục nào đang nói về cái gì. */}
                    <p className="text-sm font-medium">{c.label}</p>
                    <p className="text-meta leading-relaxed text-[var(--text-muted)]">
                      {c.detail}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Ảnh bằng chứng vùng bị UI che: máy không phân biệt được chữ với
              cảnh quay nên phải để người dùng tự soi (xem docs/API.md mục QC) */}
          {evidence.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-meta text-[var(--text-muted)]">
                {t("qc.safe-area-hint")}
              </p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {evidence.map((rel) => (
                  <button
                    key={rel}
                    type="button"
                    onClick={() =>
                      setPreview(imageFileInfo(rel, { version: report.checkedAt }))
                    }
                    className="shrink-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] transition-opacity duration-150 hover:opacity-80"
                    title={t("qc.safe-area-open")}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${mediaUrl(rel)}?v=${encodeURIComponent(report.checkedAt)}`}
                      alt={t("qc.safe-area-open")}
                      className="h-28 w-auto bg-[var(--bg-subtle)] object-contain"
                      onError={() =>
                        setBrokenFrames((prev) =>
                          prev.includes(rel) ? prev : [...prev, rel]
                        )
                      }
                    />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Hành vi thật của backend: job assemble-final bị chặn khi QC fail */}
          {report.status === "fail" && (
            <Banner tone="danger" message={t("qc.fail-blocks-final")} />
          )}
        </div>
      )}
      <MediaPreviewModal file={preview} onClose={() => setPreview(null)} />
    </Card>
  );
}
