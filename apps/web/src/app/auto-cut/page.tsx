"use client";

/**
 * Danh sách phiên "Auto cut videos" - bày giống trang Videos Project để người
 * dùng không phải học lại cách đọc bảng.
 */

import { Scissors, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteAutoCut,
  getAutoCutSessions,
  isAutoCutJob,
  type AutoCutMeta,
} from "@/lib/api";
import { useEvents, useJobEvents } from "@/lib/useEvents";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { IconButton } from "@/components/IconButton";
import { PageHeader } from "@/components/PageHeader";
import { TableSkeleton } from "@/components/Skeleton";
import { Toolbar } from "@/components/Toolbar";
import { AutoCutCreateModal } from "@/components/AutoCutCreateModal";
import {
  AutoCutStatusBadge,
  MODE_LABEL,
  aspectLabel,
} from "@/components/AutoCutCommon";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";

export default function AutoCutPage() {
  const { t, tf } = useT();
  const router = useRouter();
  // SSE đứt rồi nối lại → refetch bảng để status không kẹt "đang chạy" mãi
  const { resyncTick } = useEvents();

  const [sessions, setSessions] = useState<AutoCutMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Phiên đang chờ xác nhận xóa
  const [target, setTarget] = useState<AutoCutMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await getAutoCutSessions());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, resyncTick]);

  // Job auto-cut kết thúc → trạng thái phiên đổi, nạp lại bảng
  useJobEvents((job) => {
    if (!isAutoCutJob(job)) return;
    if (["done", "failed", "canceled"].includes(job.status)) load();
  });

  // Lọc tại chỗ theo tên + đường dẫn nguồn - danh sách phiên nằm sẵn trong bộ nhớ
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !sessions) return sessions;
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.source.relPath.toLowerCase().includes(q)
    );
  }, [sessions, query]);

  async function onDelete() {
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAutoCut(target.id);
      setTarget(null);
      await load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.auto-cut")}
        hint={{ titleKey: "help.autocut.title", bodyKey: "help.autocut.body" }}
        subtitle={t("autocut.subtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Scissors size={16} strokeWidth={2} />
            {t("autocut.new")}
          </Button>
        }
      />

      {error && <ErrorBanner message={t("autocut.load-error")} detail={error} />}

      <Card>
        <Toolbar
          search={{
            value: query,
            onChange: setQuery,
            placeholder: t("autocut.search"),
          }}
        />
        {shown && shown.length > 0 ? (
          // Bảng nhiều cột - màn hẹp thì cuộn ngang thay vì vỡ layout
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  {/* Cột phụ ẩn dưới xl - giống Text to video và Dịch video:
                      để đủ 7 cột trên màn hẹp là CẢ TRANG trượt ngang, kéo theo
                      cả rail trái, chứ không phải chỉ bảng cuộn trong khung. */}
                  <th>{t("common.name")}</th>
                  <th>{t("common.status")}</th>
                  <th className="hidden xl:table-cell">
                    {t("autocut.col-mode")}
                  </th>
                  <th className="hidden xl:table-cell">
                    {t("autocut.col-aspect")}
                  </th>
                  <th>{t("autocut.col-segments")}</th>
                  <th className="hidden xl:table-cell">
                    {t("common.updated")}
                  </th>
                  <th className="w-10">
                    <span className="sr-only">{t("common.delete")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const created = s.segments.filter((x) => x.projectId).length;
                  return (
                    <tr
                      key={s.id}
                      className="row-click"
                      onClick={() => router.push(`/auto-cut/${s.id}`)}
                    >
                      <td>
                        <span className="font-medium">{s.name}</span>
                        {/* Đường dẫn dài phải cắt bớt, không thì một file nằm
                            sâu 6 cấp thư mục là toác nguyên cột. */}
                        <span className="mt-1 block max-w-[360px] truncate text-meta text-[var(--text-muted)]">
                          {s.source.relPath}
                        </span>
                      </td>
                      <td>
                        <AutoCutStatusBadge status={s.status} />
                      </td>
                      <td className="hidden text-[var(--text-muted)] xl:table-cell">
                        {t(MODE_LABEL[s.mode] ?? "autocut.mode.time")}
                      </td>
                      <td className="hidden text-[var(--text-muted)] xl:table-cell">
                        {aspectLabel(s.output.aspect, t)}
                      </td>
                      <td className="text-[var(--text-muted)]">
                        {s.segments.length} / {created}
                      </td>
                      <td className="hidden text-[var(--text-muted)] xl:table-cell">
                        {formatDateTime(s.updatedAt)}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <IconButton
                          size="sm"
                          tone="danger"
                          label={tf("autocut.delete-aria", { name: s.name })}
                          onClick={() => {
                            setDeleteError(null);
                            setTarget(s);
                          }}
                        >
                          <Trash2 size={15} strokeWidth={2} />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : shown ? (
          // Lọc không ra gì KHÁC với chưa có phiên nào: gợi ý "tạo phiên mới"
          // lúc người dùng chỉ gõ nhầm từ khóa là trả lời sai câu hỏi.
          query.trim() ? (
            <EmptyState icon={Scissors} description={t("common.no-match")} />
          ) : (
            <EmptyState
              icon={Scissors}
              description={t("autocut.empty")}
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Scissors size={16} strokeWidth={2} />
                  {t("autocut.new")}
                </Button>
              }
            />
          )
        ) : (
          // Khung chờ CHỈ hiện khi đang tải thật. Tải hỏng thì chỉ còn banner đỏ
          // ở trên: để khung chờ chạy tiếp là vừa báo "đang tải" vừa báo "tải
          // lỗi" cùng lúc, mà cho danh sách về rỗng thì lại nói dối "chưa có gì".
          !error && <TableSkeleton />
        )}
      </Card>

      <AutoCutCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          router.push(`/auto-cut/${id}`);
        }}
      />

      {/* Xóa phiên = xóa dữ liệu → bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={target !== null}
        title={t("autocut.delete-title")}
        description={<p>{t("autocut.delete-desc")}</p>}
        items={target ? [`${target.name} - ${target.source.relPath}`] : []}
        busy={deleting}
        error={deleteError}
        onClose={() => setTarget(null)}
        onConfirm={onDelete}
      />
    </div>
  );
}
