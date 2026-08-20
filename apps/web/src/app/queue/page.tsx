"use client";

import { Filter, ListVideo, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelJob,
  getJob,
  getJobs,
  type Job,
  type JobStatus,
} from "@/lib/api";
import { useEvents, useJobEvents, useJobLogEvents } from "@/lib/useEvents";
import { Card } from "@/components/Card";
import { JobBadge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { IconButton } from "@/components/IconButton";
import { PageHeader } from "@/components/PageHeader";
import { ProgressBar } from "@/components/ProgressBar";
import { TableSkeleton } from "@/components/Skeleton";
import { FilterChip, Toolbar } from "@/components/Toolbar";
import { formatJobDuration, formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

// Giá trị là KEY dictionary - dịch bằng t() lúc render.
const TYPE_LABEL: Record<Job["type"], string> = {
  "scene-draft": "queue.type.scene-draft",
  "scene-final": "queue.type.scene-final",
  "assemble-draft": "queue.type.assemble-draft",
  "assemble-final": "queue.type.assemble-final",
  "image-gen": "queue.type.image-gen",
  "auto-cut": "queue.type.auto-cut",
  "auto-trim": "queue.type.auto-trim",
  "text-to-video": "queue.type.text-to-video",
  "translate-video": "queue.type.translate-video",
};

/* Lọc theo trạng thái. "canceled" cố ý KHÔNG có chip riêng: job hủy là thứ
   người dùng vừa tự tay bỏ đi, không ai đi tìm lại nó - còn thêm chip thứ năm
   thì hàng chip dài hơn cả thông tin nó lọc ra. Bấm "Tất cả" vẫn thấy đủ. */
const STATUS_FILTERS: readonly JobStatus[] = [
  "queued",
  "running",
  "done",
  "failed",
];

// Nhãn badge dùng lại nguyên xi - chip lọc và badge trong bảng phải đọc ra
// cùng một chữ, không thì người dùng lọc "Lỗi" mà bảng hiện "failed".
const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "badge.job.queued",
  running: "badge.job.running",
  done: "badge.job.done",
  failed: "badge.job.failed",
  canceled: "badge.job.canceled",
};

function LogPanel({
  jobId,
  onClose,
}: {
  jobId: string;
  onClose: () => void;
}) {
  const { t, tf } = useT();
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    setLog("");
    setJob(null);
    (async () => {
      try {
        const j = await getJob(jobId);
        if (!alive) return;
        setJob(j);
        setLog(j.log ?? "");
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [jobId]);

  // Dòng log mới qua SSE
  useJobLogEvents((e) => {
    if (e.jobId !== jobId) return;
    setLog((prev) => (prev ? `${prev}\n${e.line}` : e.line));
  });

  // Trạng thái job đổi
  useJobEvents((j) => {
    if (j.id === jobId) setJob((prev) => (prev ? { ...prev, ...j } : j));
  });

  // Auto-scroll xuống cuối
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <Card
      title={tf("queue.log-title", { id: jobId })}
      actions={
        <IconButton label={t("queue.close-log")} onClick={onClose}>
          <X size={15} strokeWidth={2} />
        </IconButton>
      }
    >
      {error && <ErrorBanner message={t("queue.log-error")} detail={error} />}
      {job && (
        <div className="mb-3 flex items-center gap-3 text-sm text-[var(--text-muted)]">
          <JobBadge status={job.status} />
          <span>
            {job.projectId} · {t(TYPE_LABEL[job.type])}
            {job.sceneId ? ` · ${job.sceneId}` : ""}
          </span>
          {job.status === "running" && (
            <span className="flex-1">
              <ProgressBar progress={job.progress} step={job.step} />
            </span>
          )}
        </div>
      )}
      <pre
        ref={preRef}
        className="max-h-96 min-h-40 overflow-auto rounded-[var(--radius)] bg-[var(--bg-subtle)] p-3 font-mono text-meta whitespace-pre-wrap"
      >
        {log || t("queue.no-log")}
      </pre>
    </Card>
  );
}

export default function QueuePage() {
  const { t } = useT();
  const { resyncTick } = useEvents();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  // Lọc theo trạng thái (multi-select, OR). Rỗng = tất cả.
  const [statusFilter, setStatusFilter] = useState<JobStatus[]>([]);
  // Tìm theo tên project / id job - đây là danh sách dài nhất của dashboard,
  // 50 job gần nhất mà chỉ lọc được theo trạng thái thì vẫn phải dò bằng mắt.
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setJobs(await getJobs(50));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Load lần đầu + refetch mỗi khi SSE reconnect (resyncTick tăng) - trong lúc
  // đứt kết nối job có thể đã đổi trạng thái mà không nhận được event.
  useEffect(() => {
    load();
  }, [load, resyncTick]);

  // Realtime: upsert job vào danh sách
  useJobEvents((job) => {
    setJobs((prev) => {
      // Danh sách chưa load xong → refetch để không nuốt mất event
      if (!prev) {
        load();
        return prev;
      }
      const idx = prev.findIndex((j) => j.id === job.id);
      if (idx === -1) return [job, ...prev];
      const next = [...prev];
      next[idx] = job;
      return next;
    });
  });

  // Số job mỗi trạng thái - chip lọc nói luôn còn bao nhiêu, không bắt bấm thử
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<JobStatus, number>> = {};
    for (const j of jobs ?? []) {
      counts[j.status] = (counts[j.status] ?? 0) + 1;
    }
    return counts;
  }, [jobs]);

  const filtered = useMemo(() => {
    if (!jobs) return null;
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (statusFilter.length > 0 && !statusFilter.includes(j.status))
        return false;
      if (!q) return true;
      return `${j.id} ${j.projectId} ${j.sceneId ?? ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [jobs, statusFilter, query]);

  function toggleStatus(status: JobStatus) {
    setStatusFilter((cur) =>
      cur.includes(status)
        ? cur.filter((s) => s !== status)
        : [...cur, status]
    );
  }

  async function onCancel(id: string) {
    if (cancelingId) return;
    setCancelError(null);
    setCancelingId(id);
    try {
      await cancelJob(id);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.queue")}
        hint={{ titleKey: "help.queue.title", bodyKey: "help.queue.body" }}
        subtitle={t("queue.subtitle")}
      />

      {error && (
        <ErrorBanner message={t("queue.load-error")} detail={error} />
      )}
      {cancelError && (
        <ErrorBanner message={t("queue.cancel-error")} detail={cancelError} />
      )}

      <Card>
        <Toolbar
          search={{
            value: query,
            onChange: setQuery,
            placeholder: t("queue.search"),
          }}
        >
          <Filter
            size={14}
            strokeWidth={2}
            className="text-[var(--text-muted)]"
            aria-label={t("queue.filter-by-status")}
          />
          <FilterChip
            active={statusFilter.length === 0}
            onClick={() => setStatusFilter([])}
          >
            {t("common.all")}
          </FilterChip>
          {STATUS_FILTERS.map((status) => (
            <FilterChip
              key={status}
              active={statusFilter.includes(status)}
              onClick={() => toggleStatus(status)}
            >
              {t(STATUS_LABEL[status])}
              <span className="opacity-70">{statusCounts[status] ?? 0}</span>
            </FilterChip>
          ))}
        </Toolbar>

        {/* Khung chờ CHỈ hiện khi đang tải thật. Tải hỏng thì chỉ còn banner đỏ
            ở trên: để khung chờ chạy tiếp là vừa báo "đang tải" vừa báo "tải lỗi"
            cùng lúc, mà cho danh sách về rỗng thì lại nói dối là "chưa có gì". */}
        {!jobs ? (
          !error && <TableSkeleton />
        ) : filtered && filtered.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Project</th>
                <th>{t("queue.col-type")}</th>
                <th>{t("common.status")}</th>
                <th className="w-64">{t("queue.col-progress")}</th>
                <th>{t("queue.col-time")}</th>
                <th className="w-24">
                  <span className="sr-only">{t("common.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => (
                <tr
                  key={j.id}
                  className="row-click"
                  onClick={() => setSelectedId(j.id)}
                >
                  <td className="font-mono text-meta">{j.id}</td>
                  <td className="font-medium">
                    {j.projectId}
                    {j.sceneId && (
                      <span className="ml-1 text-meta text-[var(--text-muted)]">
                        · {j.sceneId}
                      </span>
                    )}
                  </td>
                  <td className="text-[var(--text-muted)]">
                    {t(TYPE_LABEL[j.type])}
                  </td>
                  <td>
                    <JobBadge status={j.status} />
                  </td>
                  <td>
                    {j.status === "running" ? (
                      <ProgressBar progress={j.progress} step={j.step} />
                    ) : (
                      <span className="text-meta text-[var(--text-muted)]">
                        {j.status === "done" ? "100%" : "-"}
                      </span>
                    )}
                  </td>
                  <td className="text-[var(--text-muted)]">
                    <span title={formatRelative(j.createdAt)}>
                      {formatJobDuration(j.startedAt, j.finishedAt)}
                    </span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {(j.status === "queued" || j.status === "running") && (
                      <Button
                        variant="destructive"
                        small
                        disabled={cancelingId === j.id}
                        onClick={() => onCancel(j.id)}
                      >
                        <Square size={12} strokeWidth={2} />
                        {cancelingId === j.id ? t("queue.canceling") : t("common.cancel")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : jobs.length > 0 ? (
          <EmptyState icon={Filter} description={t("common.no-match")} />
        ) : (
          <EmptyState icon={ListVideo} description={t("queue.empty")} />
        )}
      </Card>

      {selectedId && (
        <LogPanel jobId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
