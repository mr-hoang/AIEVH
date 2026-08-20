"use client";

import {
  Check,
  ChevronDown,
  Eye,
  FileText,
  Film,
  FolderUp,
  Image as ImageIcon,
  Loader2,
  Music,
  Palette,
  Pause,
  Play,
  RotateCcw,
  Save,
  Smartphone,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  DEFAULT_ADJUST,
  GRADE_LABELS,
  deleteProjectAsset,
  getGradePresets,
  getGradePreviews,
  isDefaultAdjust,
  mediaUrl,
  renderGradeFrame,
  setAssetGrade,
  toGradeAdjust,
  updateAssetDescription,
  updateAssetSequence,
  uploadAsset,
  type FileInfo,
  type GradeAdjust,
  type GradePreviewResult,
} from "@/lib/api";
import { useUploadEvents } from "@/lib/useEvents";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { IconButton } from "@/components/IconButton";
import {
  MediaPreviewModal,
  RevealButton,
  canPreview,
} from "@/components/MediaPreviewModal";
import { Modal } from "@/components/Modal";
import { Panel } from "@/components/Panel";
import { PhoneConnectModal } from "@/components/PhoneConnectModal";
import { formatBytes, isRecentFile } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** Badge "mới" cho file vừa xuất hiện - nhãn PHÂN LOẠI nên không có chấm. */
function NewBadge({ label }: { label: string }) {
  return <Badge tone="running" dot={false} label={label} className="shrink-0" />;
}

/** Placeholder mô tả cụ thể theo loại file - gợi ý người dùng viết gì. */
// Giá trị là KEY dictionary - dịch bằng t() lúc render.
const DESCRIPTION_PLACEHOLDER: Record<FileInfo["kind"], string> = {
  image: "assets.ph.image",
  video: "assets.ph.video",
  audio: "assets.ph.audio",
  other: "assets.ph.other",
};

/** Auto-grow textarea theo nội dung, tối đa ~5 dòng. */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
}

/** Thứ tự nhóm asset khi danh sách dài (>5 file). */
const KIND_GROUPS: { kind: FileInfo["kind"]; label: string }[] = [
  { kind: "video", label: "assets.group.video" },
  { kind: "image", label: "assets.group.image" },
  { kind: "audio", label: "assets.group.audio" },
  { kind: "other", label: "assets.group.other" },
];

/** Icon nhỏ theo loại file - dùng cho dòng compact. */
function KindIcon({ kind }: { kind: FileInfo["kind"] }) {
  const cls = "shrink-0 text-[var(--text-muted)]";
  switch (kind) {
    case "video":
      return <Film size={16} strokeWidth={1.75} className={cls} />;
    case "audio":
      return <Music size={16} strokeWidth={1.75} className={cls} />;
    case "image":
      return <ImageIcon size={16} strokeWidth={1.75} className={cls} />;
    default:
      return <FileText size={16} strokeWidth={1.75} className={cls} />;
  }
}

function AssetPreview({
  file,
  playing,
  onTogglePlay,
  onOpenPreview,
}: {
  file: FileInfo;
  playing: boolean;
  onTogglePlay: () => void;
  /** Click thumbnail ảnh/video → mở modal preview lớn. */
  onOpenPreview?: () => void;
}) {
  const { t, tf } = useT();
  const base =
    "flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius)] bg-[var(--bg-subtle)] border border-[var(--border)]";
  switch (file.kind) {
    case "image":
      return (
        <button
          type="button"
          onClick={onOpenPreview}
          aria-label={tf("common.preview-aria", { name: file.name })}
          className={`${base} cursor-zoom-in`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mediaUrl(file.relPath) + "?v=" + encodeURIComponent(file.mtime)}
            alt={file.name}
            className="h-full w-full object-cover"
          />
        </button>
      );
    case "video":
      return (
        <button
          type="button"
          onClick={onOpenPreview}
          aria-label={tf("common.preview-aria", { name: file.name })}
          className={`${base} cursor-zoom-in`}
        >
          <video
            src={mediaUrl(file.relPath) + "?v=" + encodeURIComponent(file.mtime)}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
            controls={false}
          />
        </button>
      );
    case "audio":
      return (
        <span className={`${base} flex-col gap-1`}>
          <button
            type="button"
            onClick={onTogglePlay}
            aria-label={playing ? t("sfx.stop") : t("sfx.play")}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--primary-soft)] text-[var(--primary)] transition-colors duration-150 hover:bg-[var(--primary)] hover:text-[var(--primary-soft)]"
          >
            {playing ? (
              <Pause size={14} strokeWidth={2} />
            ) : (
              <Play size={14} strokeWidth={2} />
            )}
          </button>
          <Music size={12} strokeWidth={1.75} className="text-[var(--text-muted)]" />
        </span>
      );
    default:
      return (
        <span className={base}>
          <FileText
            size={20}
            strokeWidth={1.5}
            className="text-[var(--text-muted)]"
          />
        </span>
      );
  }
}

export function ProjectAssetsCard({
  projectId,
  assets,
  onChanged,
  compact = false,
  title,
  showUpload = true,
}: {
  projectId: string;
  assets: FileInfo[];
  onChanged: () => void;
  /** Chế độ gọn sau khi đã bắt đầu edit - mỗi asset một dòng, click mở chi tiết. */
  compact?: boolean;
  /** Tiêu đề card - dùng khi tách khối (Sound Effect, Khác). */
  title?: string;
  /** false = khối chỉ hiển thị (không dropzone/nút tải lên) - upload dồn về khối chính. */
  showUpload?: boolean;
}) {
  const { t, tf } = useT();
  const cardTitle = title ?? t("assets.title");
  // (i) chỉ gắn ở khối nguồn chính. Khối "Sound effect"/"Khác" chỉ liệt kê lại
  // file AI tự sinh, không có dropzone lẫn nút QR nên chú thích đó sẽ sai chỗ.
  const cardHint = showUpload
    ? {
        titleKey: "help.project-assets.title",
        bodyKey: "help.project-assets.body",
      }
    : undefined;
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Dòng compact đang mở rộng (xem preview + sửa mô tả)
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  // Asset video đang mở modal duyệt chỉnh màu
  const [gradeFile, setGradeFile] = useState<FileInfo | null>(null);

  // Modal "Kết nối điện thoại" (QR upload từ điện thoại cùng WiFi)
  const [phoneOpen, setPhoneOpen] = useState(false);

  // Upload đang đến server (từ điện thoại /m/<id> hoặc tab khác) - SSE kênh
  // "upload", theo id để nhiều upload song song không đè nhau
  const [incoming, setIncoming] = useState<
    Record<string, { received: number; total: number; error?: boolean }>
  >({});
  useUploadEvents((e) => {
    // Chỉ khối chính (showUpload) hiện tiến trình - tránh trùng ở khối SFX/Khác
    if (!showUpload || e.projectId !== projectId) return;
    if (e.done) {
      if (e.error) {
        // Dòng lỗi ngắn, tự ẩn sau 5s
        setIncoming((m) => ({ ...m, [e.id]: { received: 0, total: 0, error: true } }));
        setTimeout(() => {
          setIncoming((m) => {
            if (!(e.id in m)) return m;
            const next = { ...m };
            delete next[e.id];
            return next;
          });
        }, 5000);
      } else {
        setIncoming((m) => {
          const next = { ...m };
          delete next[e.id];
          return next;
        });
        // Video/ảnh mới hiện ngay không cần F5 (mediaUrl đã cache-bust theo mtime)
        onChanged();
      }
      return;
    }
    setIncoming((m) => ({
      ...m,
      [e.id]: { received: e.received ?? 0, total: e.total ?? 0 },
    }));
  });

  // Asset đang mở modal preview lớn (ảnh/video/audio)
  const [previewFile, setPreviewFile] = useState<FileInfo | null>(null);

  // Nhãn preset màu - nguồn chính: GET /api/grade-presets (GRADE_LABELS chỉ là fallback)
  const [gradeLabels, setGradeLabels] =
    useState<Record<string, string>>(GRADE_LABELS);
  useEffect(() => {
    let alive = true;
    getGradePresets()
      .then((list) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const p of list) map[p.id] = p.label;
        setGradeLabels((cur) => ({ ...cur, ...map }));
      })
      .catch(() => {
        // Im lặng - chip sẽ dùng GRADE_LABELS fallback hoặc id thô
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Nhãn hiển thị màu của một asset - "Cinematic", "Cinematic +" (có chỉnh tay), "Tùy chỉnh"… */
  function gradeLabelOf(f: FileInfo): string | null {
    const hasAdjust = !isDefaultAdjust(f.colorAdjust);
    if (!f.colorGrade && !hasAdjust) return null;
    const base = f.colorGrade
      ? (gradeLabels[f.colorGrade] ?? f.colorGrade)
      : t("projects.custom");
    return hasAdjust && f.colorGrade ? `${base} +` : base;
  }

  // Bản nháp mô tả từng file - chỉ giữ khi người dùng đã gõ (không clobber khi reload)
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingFile, setSavingFile] = useState<string | null>(null);
  const [savedFile, setSavedFile] = useState<string | null>(null);
  const [sequenceDrafts, setSequenceDrafts] = useState<
    Record<string, { order: string; role: "main" | "support" }>
  >({});
  const [savingSequence, setSavingSequence] = useState<string | null>(null);

  // File đang xóa - disable nút xóa của đúng file đó
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  // File đang chờ xác nhận xóa (modal gõ DELETE)
  const [deleteTarget, setDeleteTarget] = useState<FileInfo | null>(null);

  // Nghe thử audio: một element dùng chung
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    []
  );

  function togglePlay(file: FileInfo) {
    if (playing === file.name) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(
      mediaUrl(file.relPath) + "?v=" + encodeURIComponent(file.mtime)
    );
    audio.onended = () => setPlaying(null);
    audio.onerror = () => {
      setPlaying(null);
      setError(tf("sfx.play-error", { name: file.name }));
    };
    audioRef.current = audio;
    setPlaying(file.name);
    audio.play().catch(() => setPlaying(null));
  }

  const uploadFiles = useCallback(
    async (list: FileList | File[]) => {
      const files = Array.from(list);
      if (files.length === 0) return;
      setUploading(true);
      setError(null);
      try {
        for (const f of files) {
          await uploadAsset(f, "project", projectId);
        }
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [projectId, onChanged]
  );

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
  }

  async function saveDescription(file: FileInfo) {
    const draft = drafts[file.name];
    if (draft === undefined || draft === (file.description ?? "")) return;
    setSavingFile(file.name);
    setError(null);
    try {
      await updateAssetDescription(projectId, file.name, draft.trim());
      setDrafts((d) => {
        const next = { ...d };
        delete next[file.name];
        return next;
      });
      setSavedFile(file.name);
      setTimeout(() => setSavedFile((v) => (v === file.name ? null : v)), 2500);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingFile(null);
    }
  }

  async function saveSequence(file: FileInfo) {
    const draft = sequenceDrafts[file.name] ?? {
      order: file.sceneOrder ? String(file.sceneOrder) : "",
      role: file.sceneRole ?? "main",
    };
    const order = draft.order.trim() === "" ? null : Number(draft.order);
    if (order !== null && (!Number.isInteger(order) || order < 1 || order > 999)) {
      setError("Số cảnh phải là số nguyên từ 1 đến 999, hoặc để trống để dựng từ trên xuống.");
      return;
    }
    setSavingSequence(file.name);
    setError(null);
    try {
      await updateAssetSequence(projectId, file.name, order, draft.role);
      setSequenceDrafts((all) => {
        const next = { ...all };
        delete next[file.name];
        return next;
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSequence(null);
    }
  }

  async function deleteAsset(file: FileInfo) {
    setDeletingFile(file.name);
    setError(null);
    try {
      await deleteProjectAsset(projectId, file.name);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingFile(null);
      setDeleteTarget(null);
    }
  }

  const renderItem = compact ? renderCompactRow : renderRow;

  // Thanh tiến trình upload đang đến server - dùng chung cho cả hai layout
  const incomingEntries = Object.entries(incoming);
  const uploadBanner =
    showUpload && incomingEntries.length > 0 ? (
      <div className="mb-3 flex flex-col gap-2">
        {incomingEntries.map(([id, u]) => {
          if (u.error) {
            return <Banner key={id} tone="danger" message={t("upload.error")} />;
          }
          const percent =
            u.total > 0
              ? Math.min(100, Math.round((u.received / u.total) * 100))
              : null;
          return (
            <Panel key={id}>
              {percent === null ? (
                <div
                  className="progress-indeterminate"
                  aria-label={t("upload.receiving-unknown")}
                />
              ) : (
                <div
                  className="h-1 overflow-hidden rounded-full bg-[var(--border)]"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <div
                    className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-300"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
              <span className="text-meta text-[var(--text-muted)]">
                {percent === null
                  ? t("upload.receiving-unknown")
                  : tf("upload.receiving", { percent })}
              </span>
            </Panel>
          );
        })}
      </div>
    ) : null;

  // Modal duyệt chỉnh màu - dùng chung cho cả hai layout (compact và đầy đủ)
  const gradeModal = gradeFile ? (
    <GradeModal
      projectId={projectId}
      file={gradeFile}
      onClose={() => setGradeFile(null)}
      onSaved={() => {
        setGradeFile(null);
        onChanged();
      }}
    />
  ) : null;

  // Modal preview media dùng chung - cho cả hai layout
  const previewModal = (
    <MediaPreviewModal
      file={previewFile}
      onClose={() => setPreviewFile(null)}
    />
  );

  // Modal QR kết nối điện thoại - chỉ khối chính (showUpload) mới có nút mở
  const phoneModal = showUpload ? (
    <PhoneConnectModal
      projectId={projectId}
      open={phoneOpen}
      onClose={() => setPhoneOpen(false)}
    />
  ) : null;

  const phoneButton = showUpload ? (
    <Button variant="secondary" small onClick={() => setPhoneOpen(true)}>
      <Smartphone size={13} strokeWidth={2} />
      {t("phone.connect")}
    </Button>
  ) : null;

  // Modal xác nhận xóa asset - bắt gõ DELETE (thay window.confirm)
  const deleteModal = (
    <ConfirmDeleteModal
      open={deleteTarget !== null}
      title={t("assets.delete-title")}
      description={
        deleteTarget && (
          <>
            {t("assets.delete-desc-1")}{" "}
            <span className="font-medium">{deleteTarget.name}</span>? {t("assets.delete-desc-2")}
          </>
        )
      }
      busy={deleteTarget !== null && deletingFile === deleteTarget.name}
      onClose={() => setDeleteTarget(null)}
      onConfirm={() => {
        if (deleteTarget) deleteAsset(deleteTarget);
      }}
    />
  );

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept="video/*,image/*,audio/*"
      className="hidden"
      onChange={(e) => {
        if (e.target.files) uploadFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  const orderedAssets = [...assets].sort((a, b) => {
    if (a.kind !== "video" || b.kind !== "video") return 0;
    const ao = a.sceneOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sceneOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    if ((a.sceneRole ?? "main") !== (b.sceneRole ?? "main")) {
      return (a.sceneRole ?? "main") === "main" ? -1 : 1;
    }
    return assets.indexOf(a) - assets.indexOf(b);
  });

  const assetList =
    orderedAssets.length === 0 ? (
      <EmptyState
        icon={FolderUp}
        description={t("assets.empty")}
      />
    ) : orderedAssets.length > 5 ? (
      // Danh sách dài → phân nhóm theo loại cho dễ nhìn (sound effect AI chép
      // vào nằm nhóm Âm thanh)
      <div className={`${compact ? "mt-1" : "mt-4"} flex flex-col gap-4`}>
        {KIND_GROUPS.map(({ kind, label }) => {
          const group = orderedAssets.filter((f) => f.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind}>
              <p className="t-eyebrow mb-1">
                {t(label)} · {group.length}
              </p>
              <div className="flex flex-col divide-y divide-[var(--border)]">
                {group.map(renderItem)}
              </div>
            </div>
          );
        })}
      </div>
    ) : (
      <div
        className={`${compact ? "mt-1" : "mt-4"} flex flex-col divide-y divide-[var(--border)]`}
      >
        {orderedAssets.map(renderItem)}
      </div>
    );

  if (compact || !showUpload) {
    // Compact (hoặc khối chỉ hiển thị): bỏ dropzone to - nút "Tải lên" nhỏ ở
    // header card, cả card vẫn nhận kéo thả file khi showUpload.
    return (
      <div
        onDragOver={
          showUpload
            ? (e) => {
                e.preventDefault();
                setDragOver(true);
              }
            : undefined
        }
        onDragLeave={showUpload ? () => setDragOver(false) : undefined}
        onDrop={showUpload ? onDrop : undefined}
        className={`rounded-[var(--radius-lg)] transition-shadow duration-150 ${
          dragOver ? "ring-2 ring-[var(--primary)]" : ""
        }`}
      >
        <Card
          title={cardTitle}
          hint={cardHint}
          actions={
            showUpload ? (
              <span className="flex flex-wrap items-center justify-end gap-2">
                {phoneButton}
                <Button
                  variant="secondary"
                  small
                  disabled={uploading}
                  onClick={() => inputRef.current?.click()}
                >
                  <Upload size={13} strokeWidth={2} />
                  {uploading ? t("common.uploading") : t("assets.upload")}
                </Button>
              </span>
            ) : undefined
          }
        >
          {error && <ErrorBanner message={error} />}
          {uploadBanner}
          {showUpload && fileInput}
          {dragOver && (
            <div className="mb-2">
              <Banner tone="info" message={t("assets.drop-here")} />
            </div>
          )}
          {assetList}
        </Card>
        {gradeModal}
        {previewModal}
        {deleteModal}
        {phoneModal}
      </div>
    );
  }

  return (
    <Card title={cardTitle} hint={cardHint} actions={phoneButton ?? undefined}>
      {error && <ErrorBanner message={error} />}
      {uploadBanner}

      {/* Vùng kéo thả + upload */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed px-4 py-6 text-center transition-colors duration-150 ${
          dragOver
            ? "border-[var(--primary)] bg-[var(--primary-soft)]"
            : "border-[var(--border)] bg-[var(--bg-subtle)]"
        }`}
      >
        <FolderUp
          size={24}
          strokeWidth={1.5}
          className="text-[var(--text-muted)]"
        />
        <p className="text-sm text-[var(--text-muted)]">
          {t("assets.drag-hint")}
        </p>
        <Button
          variant="secondary"
          small
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <Upload size={14} strokeWidth={2} />
          {uploading ? t("common.uploading") : t("assets.choose-files")}
        </Button>
        {fileInput}
      </div>

      {/* Danh sách asset */}
      {assetList}
      {gradeModal}
      {previewModal}
      {deleteModal}
      {phoneModal}
    </Card>
  );

  /** Ô sửa mô tả cho AI - dùng chung cho row đầy đủ và row compact mở rộng. */
  function renderDescriptionEditor(f: FileInfo) {
    const value = drafts[f.name] ?? f.description ?? "";
    const dirty =
      drafts[f.name] !== undefined &&
      drafts[f.name] !== (f.description ?? "");
    return (
      <div className="min-w-0 flex-1">
        {/* min-h-8 = chiều cao nút .btn-sm: chỗ này lúc có nút lúc không, chốt
            chiều cao tối thiểu để hàng không giật lên xuống mỗi lần gõ */}
        <div className="mb-1 flex min-h-8 items-center justify-between gap-2">
          <label
            className="text-meta font-medium text-[var(--text-muted)]"
            htmlFor={`asset-desc-${f.relPath}`}
          >
            {t("assets.desc-label")}
          </label>
          {savedFile === f.name && !dirty ? (
            <span className="inline-flex items-center gap-1 text-meta font-medium text-[var(--success)]">
              <Check size={13} strokeWidth={2.5} />
              {t("assets.saved")}
            </span>
          ) : dirty ? (
            <Button
              variant="secondary"
              small
              disabled={savingFile === f.name}
              onClick={() => saveDescription(f)}
              aria-label={tf("assets.save-desc-aria", { name: f.name })}
            >
              <Save size={13} strokeWidth={2} />
              {savingFile === f.name ? t("common.saving") : t("common.save")}
            </Button>
          ) : null}
        </div>
        <textarea
          id={`asset-desc-${f.relPath}`}
          className="input min-h-[62px] w-full resize-none overflow-hidden leading-relaxed"
          rows={2}
          value={value}
          placeholder={t(DESCRIPTION_PLACEHOLDER[f.kind])}
          ref={(el) => {
            if (el) autoGrow(el);
          }}
          onChange={(e) => {
            autoGrow(e.currentTarget);
            setDrafts((d) => ({ ...d, [f.name]: e.target.value }));
          }}
          onBlur={() => saveDescription(f)}
        />
      </div>
    );
  }

  function renderSequenceEditor(f: FileInfo) {
    if (f.kind !== "video") return null;
    const draft = sequenceDrafts[f.name] ?? {
      order: f.sceneOrder ? String(f.sceneOrder) : "",
      role: f.sceneRole ?? "main",
    };
    return (
      <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius)] bg-[var(--bg-subtle)] p-2">
        <label className="flex min-w-[120px] flex-1 flex-col gap-1 text-meta font-medium">
          Số cảnh
          <input
            className="input"
            type="number"
            min={1}
            max={999}
            value={draft.order}
            aria-label={`Số cảnh của ${f.name}`}
            onChange={(e) => setSequenceDrafts((all) => ({
              ...all,
              [f.name]: { ...draft, order: e.target.value },
            }))}
          />
        </label>
        <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-meta font-medium">
          Vai trò
          <select
            className="input"
            value={draft.role}
            aria-label={`Vai trò cảnh của ${f.name}`}
            onChange={(e) => setSequenceDrafts((all) => ({
              ...all,
              [f.name]: { ...draft, role: e.target.value as "main" | "support" },
            }))}
          >
            <option value="main">Cảnh chính</option>
            <option value="support">Cảnh phụ</option>
          </select>
        </label>
        <Button
          variant="secondary"
          small
          disabled={savingSequence === f.name}
          onClick={() => saveSequence(f)}
        >
          {savingSequence === f.name ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          Lưu thứ tự
        </Button>
        <p className="w-full text-meta text-[var(--text-muted)]">
          Để trống số cảnh: hệ thống dùng thứ tự từ trên xuống dưới.
        </p>
      </div>
    );
  }

  /** Badge preset màu đã lưu - đặt cạnh badge "mới"/"Chưa mô tả". */
  function renderGradeChip(f: FileInfo) {
    if (f.kind !== "video") return null;
    const label = gradeLabelOf(f);
    if (!label) return null;
    return (
      <Badge
        tone="running"
        dot={false}
        className="shrink-0"
        label={
          <>
            <Palette size={11} strokeWidth={2} className="shrink-0" />
            {label}
          </>
        }
      />
    );
  }

  /** Nút mở modal duyệt chỉnh màu - chỉ cho asset video. */
  function renderGradeButton(f: FileInfo) {
    if (f.kind !== "video") return null;
    const label = gradeLabelOf(f);
    return (
      <Button
        variant="secondary"
        small
        onClick={() => setGradeFile(f)}
        aria-label={tf("grade.aria", { name: f.name })}
      >
        <Palette size={13} strokeWidth={2} />
        {label ? (
          <>
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--primary)]"
            />
            {t("grade.color-prefix")} {label}
          </>
        ) : (
          t("grade.action")
        )}
      </Button>
    );
  }

  /** Hàng nút thao tác của một asset - Mở file + Chỉnh màu (video) + Xóa. */
  function renderActions(f: FileInfo) {
    const deleting = deletingFile === f.name;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <RevealButton relPath={f.relPath} onError={setError} />
        {renderGradeButton(f)}
        {/* variant destructive thay cho .btn-secondary bị nhuộm đỏ bằng class
            rời: cùng một hành động phá hủy thì phải cùng một hình dạng */}
        <Button
          variant="destructive"
          small
          disabled={deleting}
          onClick={() => setDeleteTarget(f)}
          aria-label={tf("assets.delete-aria", { name: f.name })}
        >
          {deleting ? (
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <Trash2 size={13} strokeWidth={2} />
          )}
          {deleting ? t("common.deleting") : t("common.delete")}
        </Button>
      </div>
    );
  }

  function renderRow(f: FileInfo) {
    const value = drafts[f.name] ?? f.description ?? "";
    const missing = !(f.description ?? "").trim() && !value.trim();
    return (
      <div key={f.relPath} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
        {/* Hàng trên: thumbnail + tên + size + badge - click thumbnail/tên mở preview lớn */}
        <div className="flex items-center gap-3">
          <AssetPreview
            file={f}
            playing={playing === f.name}
            onTogglePlay={() => togglePlay(f)}
            onOpenPreview={() => setPreviewFile(f)}
          />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {canPreview(f.kind) ? (
              <button
                type="button"
                onClick={() => setPreviewFile(f)}
                title={tf("common.preview-aria", { name: f.name })}
                className="truncate text-sm font-medium underline-offset-2 transition-colors duration-150 hover:text-[var(--primary)] hover:underline"
              >
                {f.name}
              </button>
            ) : (
              <span className="truncate text-sm font-medium">{f.name}</span>
            )}
            {isRecentFile(f.mtime) && <NewBadge label={t("common.new")} />}
            <span className="text-meta text-[var(--text-muted)]">
              {formatBytes(f.size)}
            </span>
            {renderGradeChip(f)}
            {missing && <Badge tone="danger" label={t("brief.not-described")} />}
          </div>
        </div>

        {/* Hàng dưới: mô tả full-width + nút chỉnh màu (video) / xóa */}
        {renderSequenceEditor(f)}
        {renderDescriptionEditor(f)}
        {renderActions(f)}
      </div>
    );
  }

  /** Row compact: một dòng gọn, click mở rộng inline xem preview + sửa mô tả. */
  function renderCompactRow(f: FileInfo) {
    const value = drafts[f.name] ?? f.description ?? "";
    const missing = !(f.description ?? "").trim() && !value.trim();
    const open = !!expandedRows[f.relPath];
    return (
      <div key={f.relPath} className="py-1.5 first:pt-0 last:pb-0">
        <button
          type="button"
          onClick={() =>
            setExpandedRows((m) => ({ ...m, [f.relPath]: !m[f.relPath] }))
          }
          aria-expanded={open}
          className="flex w-full items-center gap-2 rounded-[var(--radius)] px-1 py-1 text-left transition-colors duration-150 hover:bg-[var(--bg-subtle)]"
        >
          <KindIcon kind={f.kind} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {f.name}
          </span>
          <span className="shrink-0 text-meta text-[var(--text-muted)]">
            {formatBytes(f.size)}
          </span>
          {isRecentFile(f.mtime) && <NewBadge label={t("common.new")} />}
          {renderGradeChip(f)}
          {missing && (
            <span className="shrink-0">
              <Badge tone="danger" label={t("brief.not-described")} />
            </span>
          )}
          <ChevronDown
            size={14}
            strokeWidth={2}
            className={`shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
        {open && (
          <div className="flex items-start gap-3 px-1 pb-2 pt-2">
            <AssetPreview
              file={f}
              playing={playing === f.name}
              onTogglePlay={() => togglePlay(f)}
              onOpenPreview={() => setPreviewFile(f)}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {renderSequenceEditor(f)}
              {renderDescriptionEditor(f)}
              {renderActions(f)}
            </div>
          </div>
        )}
      </div>
    );
  }
}

/** Cấu hình 6 slider chỉnh tay - range khớp GradeAdjust phía server. */
const ADJUST_SLIDERS: {
  key: keyof GradeAdjust;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}[] = [
  {
    key: "brightness",
    label: "grade.brightness",
    min: -0.3,
    max: 0.3,
    step: 0.01,
    fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`,
  },
  {
    key: "contrast",
    label: "grade.contrast",
    min: 0.7,
    max: 1.4,
    step: 0.01,
    fmt: (v) => v.toFixed(2),
  },
  {
    key: "saturation",
    label: "grade.saturation",
    min: 0,
    max: 2,
    step: 0.01,
    fmt: (v) => v.toFixed(2),
  },
  {
    key: "gamma",
    label: "grade.gamma",
    min: 0.7,
    max: 1.4,
    step: 0.01,
    fmt: (v) => v.toFixed(2),
  },
  {
    key: "temperature",
    label: "grade.temperature",
    min: 4000,
    max: 9500,
    step: 50,
    fmt: (v) => `${Math.round(v)} K`,
  },
  {
    key: "vibrance",
    label: "grade.vibrance",
    min: -0.5,
    max: 0.5,
    step: 0.01,
    fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`,
  },
];

/**
 * CSS filter XẤP XỈ thông số chỉnh tay - áp tức thì lên ảnh preview cho cảm
 * giác realtime khi kéo slider; ảnh CHÍNH XÁC từ grade-frame sẽ thay thế sau.
 * Gamma/nhiệt độ màu chỉ gần đúng (CSS không có filter tương ứng 1:1).
 */
function cssApprox(a: GradeAdjust): string | undefined {
  const f: string[] = [];
  // eq brightness của FFmpeg là cộng (-1..1) → xấp xỉ bằng brightness nhân của CSS
  if (a.brightness !== 0) f.push(`brightness(${(1 + a.brightness).toFixed(3)})`);
  if (a.contrast !== 1) f.push(`contrast(${a.contrast.toFixed(3)})`);
  // vibrance gộp tương đối vào saturate
  const sat = a.saturation * (1 + a.vibrance * 0.6);
  if (sat !== 1) f.push(`saturate(${Math.max(0, sat).toFixed(3)})`);
  // gamma > 1 sáng vùng mid → xấp xỉ nhẹ bằng brightness
  if (a.gamma !== 1) f.push(`brightness(${(1 + (a.gamma - 1) * 0.5).toFixed(3)})`);
  if (a.temperature !== 6500) {
    const k = (6500 - a.temperature) / 2500; // >0 = ấm hơn, <0 = lạnh hơn
    if (k > 0) f.push(`sepia(${Math.min(0.45, k * 0.45).toFixed(3)})`);
    else f.push(`hue-rotate(${(Math.max(-1.2, k) * -10).toFixed(1)}deg)`);
  }
  return f.length ? f.join(" ") : undefined;
}

/**
 * Modal duyệt chỉnh màu cho một asset video - bố cục 2 khung:
 * trái = preview lớn (kèm giữ nút "So với gốc" để so A/B), phải = lưới template
 * màu (ảnh grade-preview có sẵn) + 6 slider chỉnh tay. Kéo slider áp CSS filter
 * xấp xỉ ngay, debounce 500ms gọi grade-frame lấy ảnh chính xác thay thế.
 * Lưu bằng PUT /grade với preset + adjust.
 */
function GradeModal({
  projectId,
  file,
  onClose,
  onSaved,
}: {
  projectId: string;
  file: FileInfo;
  onClose: () => void;
  /** Gọi sau khi lưu thành công - cha đóng modal + reload danh sách asset. */
  onSaved: () => void;
}) {
  const { t, tf } = useT();
  const [result, setResult] = useState<GradePreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Preset đang chọn: null = "Gốc" (không chỉnh màu)
  const [selected, setSelected] = useState<string | null>(
    file.colorGrade ?? null
  );
  // Thông số chỉnh tay - khởi tạo theo colorAdjust đã lưu (nếu có)
  const savedAdjust = useMemo(() => toGradeAdjust(file.colorAdjust), [file]);
  const [adjust, setAdjust] = useState<GradeAdjust>(savedAdjust);
  const [adjustOpen, setAdjustOpen] = useState(true);
  // Đang giữ nút "So với gốc" - khung trái tạm hiện ảnh Gốc
  const [comparing, setComparing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Ảnh CHÍNH XÁC từ grade-frame - key hóa theo tham số để biết còn khớp không
  const [exact, setExact] = useState<{ key: string; relPath: string } | null>(
    null
  );
  const [frameLoading, setFrameLoading] = useState(false);
  const seqRef = useRef(0);
  // Lần đầu mở modal với adjust đã lưu khác mặc định → gọi grade-frame ngay, không debounce
  const immediateRef = useRef(!isDefaultAdjust(savedAdjust));

  useEffect(() => {
    let alive = true;
    getGradePreviews(projectId, file.name)
      .then((r) => {
        if (alive) setResult(r);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [projectId, file.name]);

  const hasAdjust = !isDefaultAdjust(adjust);
  const paramsKey = JSON.stringify({ p: selected, a: adjust });

  // Debounce gọi grade-frame khi thông số chỉnh tay khác mặc định
  useEffect(() => {
    if (!hasAdjust || (exact && exact.key === paramsKey)) {
      setFrameLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setFrameLoading(true);
    const delay = immediateRef.current ? 0 : 500;
    immediateRef.current = false;
    const t = setTimeout(() => {
      renderGradeFrame(projectId, file.name, selected, adjust)
        .then((r) => {
          if (seqRef.current !== seq) return; // đã có yêu cầu mới hơn
          setExact({ key: paramsKey, relPath: r.relPath });
          setFrameLoading(false);
        })
        .catch((e) => {
          if (seqRef.current !== seq) return;
          setFrameLoading(false);
          setError(e instanceof Error ? e.message : String(e));
        });
    }, delay);
    return () => clearTimeout(t);
  }, [paramsKey, hasAdjust, exact, selected, adjust, projectId, file.name]);

  /**
   * Click ô template: khung trái đổi ngay sang ảnh preview có sẵn (không gọi
   * API). Chọn lại đúng preset đã lưu → khôi phục thông số đã lưu; preset khác
   * → về mặc định để khớp với ảnh thumbnail.
   */
  function pickPreset(preset: string | null) {
    setSelected(preset);
    setAdjust(
      preset === (file.colorGrade ?? null) ? savedAdjust : { ...DEFAULT_ADJUST }
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await setAssetGrade(projectId, file.name, selected, adjust);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  // Ô "Gốc" (preset null) luôn đứng đầu lưới
  const previews = result
    ? [
        ...result.previews.filter((p) => p.preset === null),
        ...result.previews.filter((p) => p.preset !== null),
      ]
    : [];
  const originalSrc = previews.find((p) => p.preset === null)?.relPath ?? null;
  const selPreview = previews.find((p) => p.preset === selected) ?? null;
  const selLabel = selPreview?.label ?? (selected ?? t("grade.original"));
  const exactCurrent = exact && exact.key === paramsKey ? exact.relPath : null;

  // Nguồn ảnh khung trái + CSS filter xấp xỉ (chỉ khi chưa có ảnh chính xác)
  let mainSrc: string | null;
  let mainFilter: string | undefined;
  if (comparing) {
    mainSrc = originalSrc;
  } else if (!hasAdjust) {
    mainSrc = selPreview?.relPath ?? originalSrc;
  } else if (exactCurrent) {
    mainSrc = exactCurrent;
  } else {
    mainSrc = selPreview?.relPath ?? originalSrc;
    mainFilter = cssApprox(adjust);
  }

  // Đang ở "Gốc" thuần thì không có gì để so sánh
  const canCompare = !!result && (selected !== null || hasAdjust);

  return (
    <Modal
      wide
      open
      title={tf("grade.title", { name: file.name })}
      onClose={onClose}
      footer={
        <>
          <p className="mr-auto min-w-0 self-center text-meta text-[var(--text-muted)]">
            {t("grade.footer-note")}
          </p>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !result}>
            {saving ? t("common.saving") : t("grade.save")}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}

      {!result && !error && (
        <div className="flex flex-col gap-3 py-10">
          <div className="progress-indeterminate" aria-label={t("grade.creating-previews-aria")} />
          <p className="text-center text-sm text-[var(--text-muted)]">
            {t("grade.creating-previews")}
          </p>
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {/* ===== Khung TRÁI: preview lớn ===== */}
          <div className="flex min-w-0 flex-col gap-2 lg:w-[55%]">
            <div className="relative flex items-center justify-center overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)]">
              {mainSrc && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mediaUrl(mainSrc)}
                  alt={comparing ? t("grade.original") : selLabel}
                  style={mainFilter ? { filter: mainFilter } : undefined}
                  className="max-h-[62vh] w-full object-contain"
                />
              )}
              {/* Hai nhãn đè lên ảnh: vẫn là <Badge> của hệ thống, chỉ thêm
                  đổ bóng để tách khỏi ảnh bên dưới */}
              {comparing && (
                <span className="absolute left-2 top-2">
                  <Badge
                    tone="muted"
                    dot={false}
                    className="shadow-[var(--shadow-card)]"
                    label={t("grade.original")}
                  />
                </span>
              )}
              {frameLoading && !comparing && (
                <span className="absolute right-2 top-2">
                  <Badge
                    tone="muted"
                    dot={false}
                    className="shadow-[var(--shadow-card)]"
                    label={
                      <>
                        <Loader2
                          size={12}
                          strokeWidth={2}
                          className="animate-spin"
                        />
                        {t("grade.rendering")}
                      </>
                    }
                  />
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">
                {comparing
                  ? t("grade.original-comparing")
                  : `${selLabel}${hasAdjust ? " +" : ""}`}
              </span>
              <Button
                variant="secondary"
                small
                className="select-none"
                disabled={!canCompare}
                onPointerDown={() => setComparing(true)}
                onPointerUp={() => setComparing(false)}
                onPointerLeave={() => setComparing(false)}
                onPointerCancel={() => setComparing(false)}
                onBlur={() => setComparing(false)}
                onContextMenu={(e) => e.preventDefault()}
                title={t("grade.compare-title")}
              >
                <Eye size={13} strokeWidth={2} />
                {t("grade.compare")}
              </Button>
            </div>
          </div>

          {/* ===== Khung PHẢI: template màu + điều chỉnh ===== */}
          <div className="flex min-w-0 flex-col gap-4 lg:max-h-[66vh] lg:w-[45%] lg:overflow-y-auto lg:pr-1">
            {result.info.needsTonemap && (
              <Banner tone="info" message={t("grade.hdr-note")} />
            )}

            {/* Template màu */}
            <section className="flex flex-col gap-2">
              <p className="t-eyebrow">{t("grade.templates")}</p>
              <div className="grid grid-cols-3 gap-2">
                {previews.map((p) => {
                  const isSelected = selected === p.preset;
                  return (
                    <button
                      key={p.preset ?? "goc"}
                      type="button"
                      onClick={() => pickPreset(p.preset)}
                      aria-pressed={isSelected}
                      className={`overflow-hidden rounded-[var(--radius)] border-2 text-left transition-colors duration-150 ${
                        isSelected
                          ? "border-[var(--primary)]"
                          : "border-[var(--border)] hover:border-[var(--text-muted)]"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={mediaUrl(p.relPath)}
                        alt={p.label}
                        className="h-[90px] w-full bg-[var(--bg-subtle)] object-cover"
                      />
                      <span className="flex items-center justify-between gap-1 px-1.5 py-1">
                        <span
                          className={`truncate text-xs font-medium ${
                            isSelected ? "text-[var(--primary)]" : ""
                          }`}
                        >
                          {p.label}
                        </span>
                        {isSelected && (
                          <Check
                            size={12}
                            strokeWidth={2.5}
                            className="shrink-0 text-[var(--primary)]"
                          />
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Điều chỉnh */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setAdjustOpen((v) => !v)}
                  aria-expanded={adjustOpen}
                  className="t-eyebrow inline-flex items-center gap-1 transition-colors duration-150 hover:text-[var(--text)]"
                >
                  {t("grade.adjust")}
                  <ChevronDown
                    size={13}
                    strokeWidth={2}
                    className={`transition-transform duration-150 ${
                      adjustOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {hasAdjust && (
                  <button
                    type="button"
                    onClick={() => setAdjust({ ...DEFAULT_ADJUST })}
                    className="inline-flex items-center gap-1 text-meta font-medium text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
                  >
                    <RotateCcw size={13} strokeWidth={2} />
                    {t("grade.reset-all")}
                  </button>
                )}
              </div>

              {adjustOpen && (
                <div className="flex flex-col gap-3">
                  {ADJUST_SLIDERS.map((s) => {
                    const v = adjust[s.key];
                    const dirty = v !== DEFAULT_ADJUST[s.key];
                    const id = `grade-adjust-${s.key}`;
                    return (
                      <div key={s.key} className="flex flex-col gap-1">
                        <div className="flex min-h-6 items-center justify-between gap-2">
                          <label
                            htmlFor={id}
                            className="text-meta font-medium text-[var(--text-muted)]"
                          >
                            {t(s.label)}
                          </label>
                          <span className="flex items-center gap-2">
                            {/* Con số LÀ nội dung (14px): nhãn chỉ đường được
                                phép nhỏ hơn, giá trị đang chỉnh thì không */}
                            <span
                              className={`text-sm tabular-nums ${
                                dirty
                                  ? "font-medium text-[var(--text)]"
                                  : "text-[var(--text-muted)]"
                              }`}
                            >
                              {s.fmt(v)}
                            </span>
                            {dirty && (
                              <IconButton
                                label={tf("grade.reset-aria", {
                                  label: t(s.label),
                                })}
                                size="sm"
                                onClick={() =>
                                  setAdjust((a) => ({
                                    ...a,
                                    [s.key]: DEFAULT_ADJUST[s.key],
                                  }))
                                }
                              >
                                <RotateCcw size={13} strokeWidth={2} />
                              </IconButton>
                            )}
                          </span>
                        </div>
                        <input
                          id={id}
                          type="range"
                          className="slider"
                          min={s.min}
                          max={s.max}
                          step={s.step}
                          value={v}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            setAdjust((a) => ({ ...a, [s.key]: n }));
                          }}
                        />
                      </div>
                    );
                  })}
                  <p className="text-meta text-[var(--text-muted)]">
                    {t("grade.preview-note")}
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </Modal>
  );
}
