"use client";

/**
 * Card "Gói xuất bản" trong trang chi tiết video project.
 * Backend đọc transcript + Style Design rồi để AI soạn title/mô tả/hashtag cho
 * từng nền tảng, đồng thời ghi phụ đề .srt/.vtt. Toàn bộ nội dung ở đây là để
 * COPY đi dán lên TikTok/YouTube/Facebook nên mỗi phần có nút copy riêng.
 */

import { Download, FileText, Loader2, Megaphone, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createJob,
  createPublishPack,
  createSubtitles,
  getPublishPack,
  subtitleDownloadUrl,
  type PublishItem,
  type PublishPack,
  type PublishPlatform,
  type Job,
} from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { LinkButton } from "@/components/LinkButton";
import { CopyButton } from "@/components/CopyButton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Panel } from "@/components/Panel";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** Tên thương hiệu - không dịch, giữ nguyên cách viết chính thức. */
const PLATFORM_LABEL: Record<PublishPlatform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
};

/** Một nền tảng: tên + tiêu đề + mô tả + hashtag, mỗi phần copy riêng. */
function PlatformBlock({ item }: { item: PublishItem }) {
  const { t } = useT();
  const hashtagLine = item.hashtags.join(" ");
  return (
    <Panel
      title={PLATFORM_LABEL[item.platform] ?? item.platform}
      actions={
        <CopyButton
          value={item.title}
          label={t("publish.copy-title")}
          size="sm"
        />
      }
    >
      <p className="text-sm font-semibold">{item.title}</p>

      <div className="flex flex-wrap items-start justify-between gap-2">
        {/* Mô tả YouTube có danh sách chương xuống dòng - phải giữ nguyên.
            14px: đây là đoạn văn phải đọc trước khi dán lên nền tảng, để 12px
            thì nó nhỏ hơn cả cái tiêu đề nằm ngay trên. */}
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-[var(--text-muted)]">
          {item.description}
        </p>
        <CopyButton
          value={item.description}
          label={t("publish.copy-desc")}
          size="sm"
        />
      </div>

      {item.hashtags.length > 0 && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {item.hashtags.map((tag) => (
              <Badge key={tag} tone="muted" dot={false} label={tag} />
            ))}
          </div>
          <CopyButton
            value={hashtagLine}
            label={t("publish.copy-tags")}
            size="sm"
          />
        </div>
      )}
    </Panel>
  );
}

export function ProjectPublishCard({
  projectId,
  version,
  jobs,
}: {
  projectId: string;
  /** updatedAt của project - cache-bust link tải phụ đề sau khi soạn lại. */
  version?: string;
  /** Jobs của project cập nhật sống qua SSE ở trang cha. */
  jobs: Job[];
}) {
  const { t, tf } = useT();
  const [pack, setPack] = useState<PublishPack | null>(null);
  const [cues, setCues] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdTranscriptJob, setCreatedTranscriptJob] = useState<Job | null>(null);
  // Thiếu transcript KHÔNG phải lỗi hệ thống - hiện hướng dẫn nhẹ nhàng
  const [noTranscript, setNoTranscript] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(
    null
  );

  const load = useCallback(async () => {
    try {
      const res = await getPublishPack(projectId);
      setPack(res.pack);
      if (res.hasTranscript !== undefined) setNoTranscript(!res.hasTranscript);
    } catch (e) {
      setError({
        message: t("publish.load-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    // t chỉ đổi khi đổi ngôn ngữ - không phải lý do nạp lại pack
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const transcriptJob =
    (createdTranscriptJob
      ? jobs.find((job) => job.id === createdTranscriptJob.id) ?? createdTranscriptJob
      : null) ?? jobs.find((job) => job.type === "project-transcript") ?? null;
  const transcriptBusy =
    transcriptJob?.status === "queued" || transcriptJob?.status === "running";

  // Khi job hoàn tất, hỏi lại backend thay vì tự đoán file đã được ghi chưa.
  useEffect(() => {
    if (transcriptJob?.status === "done") {
      void load();
    }
  }, [load, transcriptJob?.id, transcriptJob?.status]);

  async function onTranscribe() {
    if (transcriptBusy) return;
    setError(null);
    try {
      const job = await createJob({ projectId, type: "project-transcript" });
      setCreatedTranscriptJob(job);
    } catch (e) {
      setError({
        message: t("publish.transcript-error"),
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function onGenerate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNoTranscript(false);
    try {
      const { pack: fresh } = await createPublishPack(projectId);
      setPack(fresh);
      // Server đã ghi .srt/.vtt trong lượt soạn; gọi thêm để lấy SỐ CUE hiển
      // thị (ghi lại đúng nội dung đó nên vô hại). Lỗi ở đây không đáng báo.
      try {
        const sub = await createSubtitles(projectId);
        setCues(sub.cues);
      } catch {
        setCues(null);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "NO_TRANSCRIPT") {
        setNoTranscript(true);
      } else {
        setError({
          message: t("publish.error"),
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const transcriptName = pack?.transcriptRel.split(/[\\/]/).pop() ?? null;

  const generateButton = (
    <Button small onClick={onGenerate} disabled={busy || noTranscript || transcriptBusy}>
      {busy ? (
        <>
          <Loader2 size={14} strokeWidth={2} className="animate-spin" />
          {t("publish.generating")}
        </>
      ) : (
        <>
          <Sparkles size={14} strokeWidth={2} />
          {pack ? t("publish.regenerate") : t("publish.generate")}
        </>
      )}
    </Button>
  );

  return (
    <Card
      title={t("publish.title")}
      hint={{ titleKey: "help.publish.title", bodyKey: "help.publish.body" }}
      actions={generateButton}
    >
      {error && <ErrorBanner message={error.message} detail={error.detail} />}

      {/* Chưa có transcript là trạng thái BÌNH THƯỜNG của project mới - chỉ
          hướng dẫn bước tiếp theo, không dựng banner lỗi đỏ */}
      {noTranscript && (
        <div className="mb-3 flex flex-col items-start gap-2">
          <Banner tone="muted" message={t("publish.no-transcript")} />
          <Button
            variant="secondary"
            small
            disabled={transcriptBusy}
            onClick={onTranscribe}
          >
            {transcriptBusy ? (
              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
            ) : (
              <FileText size={14} strokeWidth={2} />
            )}
            {transcriptBusy ? t("publish.transcribing") : t("publish.transcribe")}
          </Button>
          {transcriptJob?.status === "queued" && (
            <Banner tone="muted" message={t("publish.transcript-queued")} />
          )}
          {transcriptJob?.status === "running" && (
            <Banner
              tone="muted"
              message={tf("publish.transcript-progress", {
                progress: transcriptJob.progress ?? 0,
                step: transcriptJob.step || t("publish.transcribing"),
              })}
            />
          )}
          {transcriptJob?.status === "failed" && (
            <ErrorBanner
              message={t("publish.transcript-error")}
              detail={transcriptJob.step}
            />
          )}
        </div>
      )}

      {!noTranscript && transcriptJob?.status === "done" && !pack && (
        <div className="mb-3">
          <Banner tone="success" message={t("publish.transcript-done")} />
        </div>
      )}

      {!pack ? (
        !busy && (
          <EmptyState
            icon={Megaphone}
            description={t("publish.empty")}
            action={generateButton}
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-[var(--text-muted)]">
            <span>
              {tf("publish.generated-at", {
                time: formatRelative(pack.generatedAt),
              })}
            </span>
            {transcriptName && (
              <span className="max-w-full truncate" title={pack.transcriptRel}>
                {tf("publish.from-transcript", { file: transcriptName })}
              </span>
            )}
          </div>

          {pack.items.map((item) => (
            <PlatformBlock key={item.platform} item={item} />
          ))}

          {/* Phụ đề: link tải thật (cookie token của dashboard, ?k= khi ở /m) */}
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
            <span className="text-sm font-medium">
              {t("publish.subtitles")}
            </span>
            <LinkButton
              small
              download
              href={subtitleDownloadUrl(projectId, "srt", version)}
            >
              <Download size={14} strokeWidth={2} aria-hidden="true" />
              {t("publish.download-srt")}
            </LinkButton>
            <LinkButton
              small
              download
              href={subtitleDownloadUrl(projectId, "vtt", version)}
            >
              <Download size={14} strokeWidth={2} aria-hidden="true" />
              {t("publish.download-vtt")}
            </LinkButton>
            {cues !== null && (
              <span className="text-meta text-[var(--text-muted)]">
                {tf("publish.cues", { n: cues })}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
