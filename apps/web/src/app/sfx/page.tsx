"use client";

import {
  AudioLines,
  Music,
  Pencil,
  Pause,
  Play,
  SearchX,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteMusic,
  deleteSfx,
  getMusic,
  getSfx,
  mediaUrl,
  patchMusic,
  patchSfx,
  uploadMusic,
  uploadSfx,
  type MusicEntry,
  type SfxEntry,
} from "@/lib/api";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { TableSkeleton } from "@/components/Skeleton";
import { Toolbar } from "@/components/Toolbar";
import { formatDurationMs } from "@/lib/format";
import { useT } from "@/lib/i18n";

const RECOMMENDED_TAG = "hay-dung";

const sfxUrl = (file: string) => mediaUrl("assets/sound-effects/" + file);

const musicFileUrl = (file: string) => mediaUrl("assets/music/" + file);

const isRecommended = (e: SfxEntry) => e.tags.includes(RECOMMENDED_TAG);

/** Lọc theo tên file + tag + mô tả - dùng cho CẢ sound effect LẪN nhạc nền. */
function matches(e: AudioRow, q: string): boolean {
  if (!q) return true;
  const hay = `${e.file} ${e.tags.join(" ")} ${e.description}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((term) => hay.includes(term));
}

/** Sound effect và nhạc nền có ĐÚNG một hình dạng dữ liệu - nên cũng đúng một bảng. */
interface AudioRow {
  file: string;
  tags: string[];
  durationMs: number | null;
  description: string;
}

/**
 * Bảng file audio - dùng chung cho CẢ Sound effects LẪN Nhạc nền.
 *
 * Trước đợt đại tu đây là hai bản chép tay của cùng một bảng, và chúng đã trôi
 * ra khỏi nhau: cột thao tác w-28 ở bên này, w-20 ở bên kia; cụm nút thì ba
 * chiều cao khác nhau (Star 32px, Pencil 32px, nút xóa 30px) đứng cạnh nhau
 * trong đúng một ô. Gộp lại thì lệch kiểu đó không tái diễn được nữa.
 */
function AudioTable<T extends AudioRow>({
  rows,
  tagsLabel,
  playing,
  onPlay,
  onEdit,
  onDelete,
  deletingFile,
  recommend,
  highlight = false,
}: {
  rows: T[];
  /** Nhãn cột tag - sound effect gọi là "Tags", nhạc nền gọi là "Mood" */
  tagsLabel: string;
  playing: string | null;
  onPlay: (file: string) => void;
  onEdit: (row: T) => void;
  onDelete: (row: T) => void;
  deletingFile: string | null;
  /** Cột ngôi sao "đề xuất" - chỉ sound effect có, nhạc nền thì bỏ hẳn */
  recommend?: {
    tag: string;
    isOn: (row: T) => boolean;
    toggle: (row: T) => void;
  };
  /** Hàng nằm trong khu đề xuất - tô nền nhạt màu thương hiệu */
  highlight?: boolean;
}) {
  const { t, tf } = useT();
  return (
    <table className="table">
      <thead>
        <tr>
          <th className="w-12"></th>
          <th>{t("sfx.col-file")}</th>
          <th>{tagsLabel}</th>
          <th>{t("sfx.col-duration")}</th>
          <th>{t("sfx.col-desc")}</th>
          <th className="w-28"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const rec = recommend?.isOn(row) ?? false;
          const isPlaying = playing === row.file;
          return (
            <tr
              key={row.file}
              className={highlight ? "bg-[var(--primary-soft)]" : ""}
            >
              <td>
                <button
                  type="button"
                  onClick={() => onPlay(row.file)}
                  aria-label={isPlaying ? t("sfx.stop") : t("sfx.play")}
                  title={isPlaying ? t("sfx.stop") : t("sfx.play")}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-150 ${
                    isPlaying
                      ? "bg-[var(--primary)]"
                      : "bg-[var(--primary-soft)] text-[var(--primary)] hover:bg-[var(--primary)] hover:text-[var(--primary-soft)]"
                  }`}
                >
                  {isPlaying ? (
                    <Pause
                      size={14}
                      strokeWidth={2}
                      className="text-[var(--primary-soft)]"
                    />
                  ) : (
                    <Play size={14} strokeWidth={2} />
                  )}
                </button>
              </td>
              <td className="font-medium">{row.file}</td>
              <td>
                <span className="flex flex-wrap gap-1">
                  {row.tags
                    .filter((tag) => tag !== recommend?.tag)
                    .map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                </span>
              </td>
              <td className="text-[var(--text-muted)]">
                {formatDurationMs(row.durationMs)}
              </td>
              <td className="max-w-xs truncate text-[var(--text-muted)]">
                {row.description || "-"}
              </td>
              <td>
                <span className="flex items-center justify-end gap-1">
                  {recommend && (
                    <IconButton
                      size="sm"
                      label={rec ? t("sfx.unrecommend") : t("sfx.recommend")}
                      onClick={() => recommend.toggle(row)}
                      className={rec ? "text-[var(--primary)]" : ""}
                    >
                      <Star
                        size={14}
                        strokeWidth={2}
                        fill={rec ? "currentColor" : "none"}
                      />
                    </IconButton>
                  )}
                  <IconButton
                    size="sm"
                    label={tf("sfx.edit-aria", { name: row.file })}
                    onClick={() => onEdit(row)}
                  >
                    <Pencil size={13} strokeWidth={2} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    tone="danger"
                    label={tf("assets.delete-aria", { name: row.file })}
                    disabled={deletingFile === row.file}
                    onClick={() => onDelete(row)}
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </IconButton>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function SfxPage() {
  const { t, tf } = useT();
  const [entries, setEntries] = useState<SfxEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Nghe thử: một audio element dùng chung
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  // Upload modal
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Edit modal
  const [editing, setEditing] = useState<SfxEntry | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editTags, setEditTags] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // File đang xóa - chặn double-submit nút xóa
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  // File đang chờ xác nhận xóa (modal gõ DELETE)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Modal "Thêm nhạc nền" của <MusicSection> mở từ PageHeader - nút thêm của
  // NỬA NHẠC NỀN phải là một <Button> cỡ thường đứng cạnh nút thêm sound effect,
  // không phải nút `small` nhét trong header của card.
  const [musicAddOpen, setMusicAddOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await getSfx());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [load]);

  function togglePlay(entryFile: string) {
    if (playing === entryFile) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(sfxUrl(entryFile));
    audio.onended = () => setPlaying(null);
    audio.onerror = () => {
      setPlaying(null);
      setActionError(tf("sfx.play-error", { name: entryFile }));
    };
    audioRef.current = audio;
    setActionError(null);
    setPlaying(entryFile);
    audio.play().catch(() => setPlaying(null));
  }

  /** Toggle đề xuất - optimistic update, revert nếu API lỗi. */
  async function toggleRecommended(entry: SfxEntry) {
    const next = !isRecommended(entry);
    setActionError(null);
    setEntries((list) =>
      (list ?? []).map((e) =>
        e.file === entry.file
          ? {
              ...e,
              tags: next
                ? [...e.tags, RECOMMENDED_TAG]
                : e.tags.filter((t) => t !== RECOMMENDED_TAG),
            }
          : e
      )
    );
    try {
      const updated = await patchSfx(entry.file, { recommended: next });
      setEntries((list) =>
        (list ?? []).map((e) => (e.file === entry.file ? updated : e))
      );
    } catch (e) {
      // revert
      setEntries((list) =>
        (list ?? []).map((x) => (x.file === entry.file ? entry : x))
      );
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  function openEdit(entry: SfxEntry) {
    setEditing(entry);
    setEditDesc(entry.description);
    setEditTags(entry.tags.join(", "));
    setEditError(null);
  }

  async function onSaveEdit() {
    if (!editing || savingEdit) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const tagList = editTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await patchSfx(editing.file, {
        description: editDesc.trim(),
        tags: tagList,
      });
      setEntries((list) =>
        (list ?? []).map((e) => (e.file === editing.file ? updated : e))
      );
      setEditing(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingEdit(false);
    }
  }

  async function onDelete(entryFile: string) {
    if (deletingFile) return;
    setActionError(null);
    setDeletingFile(entryFile);
    try {
      await deleteSfx(entryFile);
      if (playing === entryFile) {
        audioRef.current?.pause();
        setPlaying(null);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingFile(null);
      setDeleteTarget(null);
    }
  }

  async function onUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadSfx(file, tags.trim(), description.trim());
      setOpen(false);
      setFile(null);
      setTags("");
      setDescription("");
      await load();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  const q = search.trim();
  const filtered = (entries ?? []).filter((e) => matches(e, q));
  const recommended = filtered.filter(isRecommended);
  const library = filtered.filter((e) => !isRecommended(e));

  // Ba trạng thái "rỗng" KHÁC NHAU, và mỗi lúc chỉ được hiện đúng một cái: thư
  // viện chưa có gì / lọc không ra gì / khu này rỗng nhưng khu kia có. Trước đây
  // bốn <EmptyState> có thể cùng xuất hiện một lúc, đọc ra thành bốn lời khuyên
  // trái ngược nhau.
  const loading = entries === null;
  const noEntries = entries !== null && entries.length === 0;
  const noMatch = entries !== null && entries.length > 0 && filtered.length === 0;

  const addButton = (
    <Button onClick={() => setOpen(true)}>
      <Upload size={15} strokeWidth={2} />
      {t("sfx.add")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.sfx")}
        hint={{ titleKey: "help.sfx.title", bodyKey: "help.sfx.body" }}
        subtitle={t("sfx.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setMusicAddOpen(true)}>
              <Music size={15} strokeWidth={2} />
              {t("music.add")}
            </Button>
            {addButton}
          </>
        }
      />

      {error && <ErrorBanner message={t("sfx.load-error")} detail={error} />}
      {actionError && <ErrorBanner message={actionError} />}

      {/* Khu đề xuất - AI ưu tiên dùng khi brief đặt sfxMode "recommended".
          Ô tìm kiếm nằm ở card ĐẦU TIÊN vì nó lọc cả hai bảng sound effect bên
          dưới (số đếm trên tiêu đề mỗi card đã tính theo bộ lọc). */}
      <Card
        title={tf("sfx.recommended-title", { n: recommended.length })}
        actions={
          <Star
            size={16}
            strokeWidth={2}
            fill="currentColor"
            className="text-[var(--primary)]"
          />
        }
      >
        <Toolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t("sfx.search-placeholder"),
          }}
        />
        {/* Khung chờ CHỈ hiện khi đang tải thật. Tải hỏng thì chỉ còn banner đỏ
            ở trên: để khung chờ chạy tiếp là vừa báo "đang tải" vừa báo "tải lỗi"
            cùng lúc, mà cho danh sách về rỗng thì lại nói dối là "chưa có gì". */}
        {loading ? (
          !error && <TableSkeleton rows={3} />
        ) : noEntries ? (
          <EmptyState
            icon={AudioLines}
            description={t("sfx.empty")}
            action={addButton}
          />
        ) : noMatch ? (
          <EmptyState icon={SearchX} description={tf("sfx.no-match", { q })} />
        ) : recommended.length > 0 ? (
          <AudioTable
            rows={recommended}
            tagsLabel={t("common.tags")}
            playing={playing}
            onPlay={togglePlay}
            onEdit={openEdit}
            onDelete={(row) => setDeleteTarget(row.file)}
            deletingFile={deletingFile}
            recommend={{
              tag: RECOMMENDED_TAG,
              isOn: isRecommended,
              toggle: toggleRecommended,
            }}
            highlight
          />
        ) : (
          <EmptyState icon={Star} description={t("sfx.rec-empty")} />
        )}
      </Card>

      {/* Thư viện: ẩn hẳn khi thư viện trống hoặc lọc không ra gì - hai trạng
          thái đó đã được card trên nói rồi, nhắc lại là hai ô trống chồng nhau */}
      {!noEntries && !noMatch && (
        <Card title={tf("sfx.library-title", { n: library.length })}>
          {loading ? (
            !error && <TableSkeleton />
          ) : library.length > 0 ? (
            <AudioTable
              rows={library}
              tagsLabel={t("common.tags")}
              playing={playing}
              onPlay={togglePlay}
              onEdit={openEdit}
              onDelete={(row) => setDeleteTarget(row.file)}
              deletingFile={deletingFile}
              recommend={{
                tag: RECOMMENDED_TAG,
                isOn: isRecommended,
                toggle: toggleRecommended,
              }}
            />
          ) : (
            <EmptyState icon={AudioLines} description={t("sfx.all-in-rec")} />
          )}
        </Card>
      )}

      {/* Nhạc nền - thư viện riêng tại assets/music/, AI tự chọn theo mood khi brief bật */}
      <MusicSection
        addOpen={musicAddOpen}
        onOpenAdd={() => setMusicAddOpen(true)}
        onCloseAdd={() => setMusicAddOpen(false)}
      />

      {/* Modal upload */}
      <Modal
        title={t("sfx.add")}
        open={open}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={onUpload} disabled={!file || uploading}>
              {uploading ? t("common.uploading") : t("assets.upload")}
            </Button>
          </>
        }
      >
        {uploadError && <ErrorBanner message={uploadError} />}
        <Field label={t("sfx.file-label")} htmlFor="sfx-file">
          <input
            id="sfx-file"
            type="file"
            accept="audio/*"
            className="input h-auto py-1.5"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label={t("sfx.tags-label")} htmlFor="sfx-tags">
          <input
            id="sfx-tags"
            className="input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("sfx.tags-placeholder")}
          />
        </Field>
        <Field label={t("sfx.col-desc")} htmlFor="sfx-desc">
          <textarea
            id="sfx-desc"
            className="input"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("sfx.desc-placeholder")}
          />
        </Field>
      </Modal>

      {/* Modal sửa description + tags */}
      <Modal
        title={
          editing
            ? tf("sfx.edit-modal-title", { name: editing.file })
            : t("sfx.edit-fallback")
        }
        open={editing !== null}
        onClose={() => {
          if (!savingEdit) setEditing(null);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={savingEdit}
              onClick={() => setEditing(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={onSaveEdit} disabled={savingEdit}>
              {savingEdit ? t("common.saving") : t("common.save")}
            </Button>
          </>
        }
      >
        {editError && <ErrorBanner message={editError} />}
        <Field label={t("sfx.col-desc")} htmlFor="sfx-edit-desc">
          <textarea
            id="sfx-edit-desc"
            className="input"
            rows={2}
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            placeholder={t("sfx.desc-placeholder")}
          />
        </Field>
        <Field
          label={t("sfx.tags-label")}
          htmlFor="sfx-edit-tags"
          hint={t("sfx.rec-tag-hint")}
        >
          <input
            id="sfx-edit-tags"
            className="input"
            value={editTags}
            onChange={(e) => setEditTags(e.target.value)}
            placeholder={t("sfx.tags-placeholder")}
          />
        </Field>
      </Modal>

      {/* Modal xác nhận xóa sound effect - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={deleteTarget !== null}
        title={t("sfx.delete-title")}
        description={
          deleteTarget && (
            <>
              {t("sfx.delete-desc-1")}{" "}
              <span className="font-medium">{deleteTarget}</span>? {t("sfx.delete-desc-2")}
            </>
          )
        }
        busy={deleteTarget !== null && deletingFile === deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) onDelete(deleteTarget);
        }}
      />
    </div>
  );
}

/**
 * Section "Nhạc nền" - thư viện assets/music/ (cùng pattern với sound effects).
 * Tags = mood (nang-luong, chill, cam-hung, cang-thang, vui-ve…) để AI chọn
 * bài hợp nội dung khi brief đặt musicMode "auto".
 *
 * DÙNG ĐÚNG BA KHUÔN của nửa Sound effect ở trên - trước đây nửa dưới lệch hẳn
 * nửa trên trong cùng một trang: nút thêm là `small` nhét trong header card
 * (trên kia là <Button> cỡ thường ở PageHeader), không có ô tìm kiếm nào, và
 * banner lỗi nằm TRONG card. Ba chỗ lệch đó nay đã khớp: nút thêm do trang mẹ
 * dựng ở PageHeader (nên `addOpen` là prop), có <Toolbar search> riêng, và
 * <ErrorBanner> đứng cấp trang - fragment này là con trực tiếp của cột gap-4.
 */
function MusicSection({
  addOpen,
  onOpenAdd,
  onCloseAdd,
}: {
  addOpen: boolean;
  onOpenAdd: () => void;
  onCloseAdd: () => void;
}) {
  const { t, tf } = useT();
  const [entries, setEntries] = useState<MusicEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Nghe thử: một audio element dùng chung
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  // Upload modal
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Edit modal
  const [editing, setEditing] = useState<MusicEntry | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editTags, setEditTags] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // File đang xóa - chặn double-submit nút xóa
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  // File đang chờ xác nhận xóa (modal gõ DELETE)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await getMusic());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [load]);

  function togglePlay(entryFile: string) {
    if (playing === entryFile) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(musicFileUrl(entryFile));
    audio.onended = () => setPlaying(null);
    audio.onerror = () => {
      setPlaying(null);
      setActionError(tf("sfx.play-error", { name: entryFile }));
    };
    audioRef.current = audio;
    setActionError(null);
    setPlaying(entryFile);
    audio.play().catch(() => setPlaying(null));
  }

  function openEdit(entry: MusicEntry) {
    setEditing(entry);
    setEditDesc(entry.description);
    setEditTags(entry.tags.join(", "));
    setEditError(null);
  }

  async function onSaveEdit() {
    if (!editing || savingEdit) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const tagList = editTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = await patchMusic(editing.file, {
        description: editDesc.trim(),
        tags: tagList,
      });
      setEntries((list) =>
        (list ?? []).map((e) => (e.file === editing.file ? updated : e))
      );
      setEditing(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingEdit(false);
    }
  }

  async function onDelete(entryFile: string) {
    if (deletingFile) return;
    setActionError(null);
    setDeletingFile(entryFile);
    try {
      await deleteMusic(entryFile);
      if (playing === entryFile) {
        audioRef.current?.pause();
        setPlaying(null);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingFile(null);
      setDeleteTarget(null);
    }
  }

  async function onUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadMusic(file, tags.trim(), description.trim());
      onCloseAdd();
      setFile(null);
      setTags("");
      setDescription("");
      await load();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  const q = search.trim();
  const filtered = (entries ?? []).filter((e) => matches(e, q));

  return (
    <>
      {/* Banner lỗi ở CẤP TRANG (fragment này là con của cột gap-4), giống nửa
          sound effect - nhét trong card thì hai nửa cùng một trang lại báo lỗi
          ở hai độ sâu khác nhau. */}
      {error && <ErrorBanner message={t("music.load-error")} detail={error} />}
      {actionError && <ErrorBanner message={actionError} />}

      <Card
        title={tf("music.title", { n: entries?.length ?? 0 })}
        actions={
          <Music size={16} strokeWidth={2} className="text-[var(--primary)]" />
        }
      >
        <Toolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t("music.search"),
          }}
        />

        {/* Khung chờ CHỈ hiện khi đang tải thật - tải hỏng thì chỉ còn banner đỏ. */}
        {entries === null ? (
          !error && <TableSkeleton rows={3} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Music}
            description={t("music.empty")}
            action={
              <Button onClick={onOpenAdd}>
                <Upload size={15} strokeWidth={2} />
                {t("music.add")}
              </Button>
            }
          />
        ) : filtered.length > 0 ? (
          <AudioTable
            rows={filtered}
            tagsLabel={t("music.col-mood")}
            playing={playing}
            onPlay={togglePlay}
            onEdit={openEdit}
            onDelete={(row) => setDeleteTarget(row.file)}
            deletingFile={deletingFile}
          />
        ) : (
          <EmptyState icon={SearchX} description={t("common.no-match")} />
        )}
      </Card>

      {/* Modal upload nhạc */}
      <Modal
        title={t("music.add")}
        open={addOpen}
        onClose={onCloseAdd}
        footer={
          <>
            <Button variant="secondary" onClick={onCloseAdd}>
              {t("common.cancel")}
            </Button>
            <Button onClick={onUpload} disabled={!file || uploading}>
              {uploading ? t("common.uploading") : t("assets.upload")}
            </Button>
          </>
        }
      >
        {uploadError && <ErrorBanner message={uploadError} />}
        <Field label={t("music.file-label")} htmlFor="music-file">
          <input
            id="music-file"
            type="file"
            accept="audio/*"
            className="input h-auto py-1.5"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label={t("music.tags-label")} htmlFor="music-tags">
          <input
            id="music-tags"
            className="input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("music.tags-placeholder")}
          />
        </Field>
        <Field label={t("sfx.col-desc")} htmlFor="music-desc">
          <textarea
            id="music-desc"
            className="input"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("music.desc-placeholder")}
          />
        </Field>
      </Modal>

      {/* Modal sửa description + tags */}
      <Modal
        title={
          editing
            ? tf("sfx.edit-modal-title", { name: editing.file })
            : t("music.edit-fallback")
        }
        open={editing !== null}
        onClose={() => {
          if (!savingEdit) setEditing(null);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={savingEdit}
              onClick={() => setEditing(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={onSaveEdit} disabled={savingEdit}>
              {savingEdit ? t("common.saving") : t("common.save")}
            </Button>
          </>
        }
      >
        {editError && <ErrorBanner message={editError} />}
        <Field label={t("sfx.col-desc")} htmlFor="music-edit-desc">
          <textarea
            id="music-edit-desc"
            className="input"
            rows={2}
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            placeholder={t("music.desc-placeholder")}
          />
        </Field>
        <Field label={t("music.tags-label")} htmlFor="music-edit-tags">
          <input
            id="music-edit-tags"
            className="input"
            value={editTags}
            onChange={(e) => setEditTags(e.target.value)}
            placeholder={t("music.tags-placeholder")}
          />
        </Field>
      </Modal>

      {/* Modal xác nhận xóa bài nhạc - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={deleteTarget !== null}
        title={t("music.delete-title")}
        description={
          deleteTarget && (
            <>
              {t("music.delete-desc-1")}{" "}
              <span className="font-medium">{deleteTarget}</span>? {t("sfx.delete-desc-2")}
            </>
          )
        }
        busy={deleteTarget !== null && deletingFile === deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) onDelete(deleteTarget);
        }}
      />
    </>
  );
}
