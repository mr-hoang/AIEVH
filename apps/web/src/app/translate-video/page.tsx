"use client";

/**
 * Danh sách phiên "Dịch video" - bày y như trang Text to video: một bảng phiên,
 * mỗi phiên là một video đang được dịch rồi đóng phụ đề. Hai trang đọc theo cùng
 * một cách, người dùng không phải học lại.
 */

import { Languages, Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createTranslateVideo,
  deleteTranslateVideo,
  getTranslateVideos,
  isTranslateVideoJob,
  TRANSLATE_MODE_LABEL,
  TRANSLATE_VIDEO_STATUS_LABEL,
  TRANSLATE_VIDEO_STATUS_TONE,
  type TranslateStatus,
  type TranslateVideoMeta,
} from "@/lib/api";
import { useEvents, useJobEvents } from "@/lib/useEvents";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { TableSkeleton } from "@/components/Skeleton";
import { Toolbar } from "@/components/Toolbar";
// clock() (giây → mm:ss) đã có sẵn ở đây, lib/format.ts chưa có helper tương đương
import { clock } from "@/components/AutoCutCommon";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";

/**
 * Badge trạng thái phiên - một component riêng, y như <AutoCutStatusBadge>.
 *
 * VÌ SAO KHÔNG VIẾT THẲNG TRONG BẢNG: bản cũ nội tuyến
 * `label={LABEL[s.status] ? t(…) : String(s.status)}`, nên server thêm một
 * trạng thái mà web chưa có nhãn là chữ máy (`transcribing`) rơi thẳng vào giữa
 * giao diện tiếng Việt. Nhãn mặc định phải là một câu DỊCH ĐƯỢC.
 */
function TranslateStatusBadge({ status }: { status: TranslateStatus }) {
  const { t } = useT();
  const tone = TRANSLATE_VIDEO_STATUS_TONE[status] ?? "muted";
  const key = TRANSLATE_VIDEO_STATUS_LABEL[status];
  return <Badge tone={tone} label={key ? t(key) : t("common.status-unknown")} />;
}

/** Một dòng mô tả nguồn của phiên: tên file video, hoặc lời nhắc chưa có nguồn. */
function sourceLine(s: TranslateVideoMeta, fallback: string): string {
  const rel = s.source.relPath;
  if (!rel) return fallback;
  const name = rel.split(/[\\/]/).pop() ?? rel;
  return s.source.durationSec ? `${name} · ${clock(s.source.durationSec)}` : name;
}

/** Modal "Video mới" - chỉ hỏi tên, video và ngôn ngữ chọn ở trang chi tiết. */
function CreateModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const session = await createTranslateVideo(
        name.trim() ? { name: name.trim() } : undefined
      );
      onCreated(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      title={t("tv.create-title")}
      open={open}
      onClose={() => {
        if (!creating) onClose();
      }}
      footer={
        <>
          <Button variant="secondary" disabled={creating} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={creating} onClick={onCreate}>
            {creating ? (
              <Loader2 size={15} strokeWidth={2} className="animate-spin" />
            ) : (
              <Languages size={15} strokeWidth={2} />
            )}
            {creating ? t("tv.creating") : t("tv.create")}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={t("tv.create-error")} detail={error} />}

      <Field label={t("tv.name")} htmlFor="tv-name" hint={t("tv.create-hint")}>
        <input
          id="tv-name"
          className="input"
          value={name}
          disabled={creating}
          placeholder={t("tv.name-placeholder")}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

export default function TranslateVideoPage() {
  const { t, tf } = useT();
  const router = useRouter();
  // SSE đứt rồi nối lại → refetch bảng để status không kẹt "đang dịch" mãi
  const { resyncTick } = useEvents();

  const [sessions, setSessions] = useState<TranslateVideoMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Phiên đang chờ xác nhận xóa
  const [target, setTarget] = useState<TranslateVideoMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await getTranslateVideos());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, resyncTick]);

  // Job bóc lời / đóng phụ đề kết thúc → trạng thái phiên đổi, nạp lại bảng
  useJobEvents((job) => {
    if (!isTranslateVideoJob(job)) return;
    if (["done", "failed", "canceled"].includes(job.status)) load();
  });

  // Lọc tại chỗ theo tên + tên file nguồn
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !sessions) return sessions;
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.source.relPath ?? "").toLowerCase().includes(q)
    );
  }, [sessions, query]);

  async function onDelete() {
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTranslateVideo(target.id);
      setTarget(null);
      await load();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  function langLabel(code: string): string {
    const key = `tv.lang.${code}`;
    const label = t(key);
    // Mã lạ (server đổi danh sách trước web) → hiện luôn mã, đừng hiện key thô
    return label === key ? code : label;
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.translate-video")}
        hint={{ titleKey: "help.tv.title", bodyKey: "help.tv.body" }}
        subtitle={t("tv.subtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Languages size={16} strokeWidth={2} />
            {t("tv.new")}
          </Button>
        }
      />

      {error && <ErrorBanner message={t("tv.load-error")} detail={error} />}

      <Card>
        <Toolbar
          search={{
            value: query,
            onChange: setQuery,
            placeholder: t("tv.search"),
          }}
        />
        {shown && shown.length > 0 ? (
          // Bảng nhiều cột - màn hẹp thì cuộn ngang thay vì vỡ layout
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("common.name")}</th>
                  <th>{t("common.status")}</th>
                  <th>{t("tv.col-langs")}</th>
                  <th className="hidden xl:table-cell">{t("tv.col-mode")}</th>
                  <th className="hidden xl:table-cell">{t("common.updated")}</th>
                  <th className="w-10">
                    <span className="sr-only">{t("common.delete")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr
                    key={s.id}
                    className="row-click"
                    onClick={() => router.push(`/translate-video/${s.id}`)}
                  >
                    <td>
                      <span className="font-medium">{s.name}</span>
                      <span className="mt-1 block max-w-[360px] truncate text-meta text-[var(--text-muted)]">
                        {sourceLine(s, t("tv.no-source-yet"))}
                      </span>
                    </td>
                    <td>
                      <TranslateStatusBadge status={s.status} />
                    </td>
                    <td className="text-[var(--text-muted)]">
                      {`${langLabel(s.sourceLang)} → ${langLabel(s.targetLang)}`}
                    </td>
                    <td className="hidden text-[var(--text-muted)] xl:table-cell">
                      {TRANSLATE_MODE_LABEL[s.mode]
                        ? t(TRANSLATE_MODE_LABEL[s.mode])
                        : String(s.mode)}
                    </td>
                    <td className="hidden text-[var(--text-muted)] xl:table-cell">
                      {formatDateTime(s.updatedAt)}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <IconButton
                        size="sm"
                        tone="danger"
                        label={tf("tv.delete-aria", { name: s.name })}
                        onClick={() => {
                          setDeleteError(null);
                          setTarget(s);
                        }}
                      >
                        <Trash2 size={15} strokeWidth={2} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : shown ? (
          query.trim() ? (
            <EmptyState icon={Languages} description={t("common.no-match")} />
          ) : (
            <EmptyState
              icon={Languages}
              description={t("tv.empty")}
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Languages size={16} strokeWidth={2} />
                  {t("tv.new")}
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

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          router.push(`/translate-video/${id}`);
        }}
      />

      {/* Xóa phiên = xóa dữ liệu → bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={target !== null}
        title={t("tv.delete-title")}
        description={<p>{t("tv.delete-desc")}</p>}
        items={target ? [`${target.name} - ${sourceLine(target, t("tv.no-source-yet"))}`] : []}
        busy={deleting}
        error={deleteError}
        onClose={() => setTarget(null)}
        onConfirm={onDelete}
      />
    </div>
  );
}
