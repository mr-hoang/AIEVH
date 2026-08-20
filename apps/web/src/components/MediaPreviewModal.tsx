"use client";

import { ExternalLink, FolderOpen, Loader2, Maximize2 } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { mediaUrl, revealFile, type FileInfo } from "@/lib/api";
import { Button } from "@/components/Button";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Modal } from "@/components/Modal";
import { useT } from "@/lib/i18n";

/** File có xem trước được trong modal không (ảnh/video/audio). */
export function canPreview(kind: FileInfo["kind"]): boolean {
  return kind === "image" || kind === "video" || kind === "audio";
}

/**
 * Dựng FileInfo tối thiểu cho modal xem trước từ một đường dẫn ảnh.
 *
 * Nhiều chỗ (thumbnail project, ảnh Image Project, logo Style) chỉ có relPath
 * chứ không có FileInfo đầy đủ từ API. Trước đây mỗi trang tự chế một object
 * riêng nên chỗ thì thiếu cache-bust, chỗ thì đặt tên file khác nhau.
 *
 * `version` dùng để cache-bust (mtime/updatedAt) - ảnh render đè lên cùng tên.
 */
export function imageFileInfo(
  relPath: string,
  opts: { name?: string; version?: string } = {},
): FileInfo {
  return {
    name: opts.name ?? relPath.split("/").pop() ?? relPath,
    relPath,
    size: 0,
    mtime: opts.version ?? "",
    kind: "image",
  };
}

/**
 * Ảnh bấm được để xem lớn - dùng CHUNG cho mọi thumbnail trong app.
 *
 * Trước đây mỗi nơi một kiểu: có nơi ảnh trơ không bấm được, có nơi tự chế
 * lightbox riêng không đóng được bằng Esc. Gói vào đây để chỗ nào cũng có cùng
 * gợi ý thị giác (con trỏ phóng to + lớp phủ khi rê chuột) và cùng cách mở.
 */
export function ZoomableThumb({
  file,
  alt,
  onOpen,
  className = "",
  imgClassName = "h-full w-full object-contain",
  iconSize = 16,
}: {
  file: FileInfo;
  alt: string;
  onOpen: (file: FileInfo) => void;
  /** Class cho khung bọc (kích thước, viền, nền) */
  className?: string;
  /** Class cho chính thẻ img (object-contain hay object-cover) */
  imgClassName?: string;
  iconSize?: number;
}) {
  const { t } = useT();
  const url =
    mediaUrl(file.relPath) +
    (file.mtime ? `?v=${encodeURIComponent(file.mtime)}` : "");
  return (
    <button
      type="button"
      onClick={() => onOpen(file)}
      title={t("media.zoom-title")}
      aria-label={t("media.zoom-title")}
      className={`group relative block cursor-zoom-in overflow-hidden ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className={imgClassName} />
      {/* Lớp phủ chỉ hiện khi rê chuột - để người dùng biết ảnh bấm được.
          NGOẠI LỆ MÀU CÓ CHỦ Ý (đã ghi trong ALLOW của scripts/check-design-system.mjs):
          `bg-black/45` + `text-white` nằm ngoài bảng token vì lớp phủ này đè lên
          MEDIA BẤT KỲ - ảnh có thể sáng trắng hoặc đen kịt, không theo theme của
          dashboard. Dùng --bg-subtle/--text ở đây thì icon tàng hình đúng một
          nửa số ảnh. Ngoại lệ chỉ áp cho lớp phủ trên media, không lan ra chỗ khác. */}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <Maximize2 size={iconSize} strokeWidth={2} className="text-white" />
      </span>
    </button>
  );
}

/**
 * Nút "Mở file" - mở Explorer/Finder trên máy và chọn đúng file.
 * Lỗi báo qua onError (cắm vào cơ chế báo lỗi sẵn có của chỗ dùng).
 */
export function RevealButton({
  relPath,
  onError,
  small = true,
  className = "",
}: {
  relPath: string;
  onError: (message: string) => void;
  /**
   * Mặc định cỡ nhỏ 30px vì nút này hay nằm trong hàng danh sách asset dày đặc.
   * Trong FOOTER của modal thì truyền `small={false}` - luật chung là nút footer
   * luôn cao 36px, không được có cỡ thứ tư.
   */
  small?: boolean;
  className?: string;
}) {
  const { t, tf } = useT();
  const [busy, setBusy] = useState(false);
  async function onClick(e: MouseEvent<HTMLButtonElement>) {
    // Nút nằm trong hàng/thumbnail clickable - không cho lan ra mở preview
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await revealFile(relPath);
    } catch (err) {
      onError(
        tf("media.reveal-error", {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      variant="secondary"
      small={small}
      className={className}
      disabled={busy}
      onClick={onClick}
      title={t("media.reveal-title")}
      aria-label={tf("media.reveal-aria", { path: relPath })}
    >
      {busy ? (
        <Loader2 size={14} strokeWidth={2} className="animate-spin" />
      ) : (
        <FolderOpen size={14} strokeWidth={2} />
      )}
      {t("common.open-file")}
    </Button>
  );
}

/**
 * Modal xem trước media dùng chung - ảnh/video hiển thị lớn, audio phát ngay.
 * Đóng bằng Esc hoặc click nền (Modal sẵn có). Footer có "Mở tab mới" (link
 * /media) và "Mở file" (reveal trong Explorer/Finder).
 */
export function MediaPreviewModal({
  file,
  onClose,
}: {
  file: FileInfo | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  // Đổi sang file khác → xóa lỗi reveal cũ
  useEffect(() => {
    setError(null);
  }, [file?.relPath]);

  if (!file) return null;
  // Cache-bust theo mtime - file render/draft ghi đè cùng tên
  const url = mediaUrl(file.relPath) + `?v=${encodeURIComponent(file.mtime)}`;

  return (
    <Modal
      wide
      open
      title={file.name}
      onClose={onClose}
      footer={
        // [phụ] … [chính]: luôn có đường thoát bằng nút Đóng chứ không chỉ dấu X,
        // và mọi nút đều là <Button> cỡ mặc định 36px.
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <RevealButton relPath={file.relPath} small={false} onError={setError} />
          {/* Mở tab mới: <Button> chứ không phải <a> đội lốt nút - footer chỉ có
              một hình dạng nút duy nhất. window.open ngay trong handler do người
              dùng bấm nên không bị trình duyệt chặn popup. */}
          <Button
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink size={14} strokeWidth={2} />
            {t("media.open-tab")}
          </Button>
        </>
      }
    >
      {/* Lỗi luôn ở ĐẦU thân modal - trước đây nó nằm lẫn trong footer ở 12px */}
      {error && <ErrorBanner message={error} />}

      {file.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="mx-auto max-h-[66vh] max-w-full rounded-[var(--radius)] bg-[var(--bg-subtle)] object-contain"
        />
      ) : file.kind === "video" ? (
        <video
          controls
          autoPlay
          src={url}
          className="mx-auto max-h-[66vh] max-w-full rounded-[var(--radius)] bg-[var(--bg-subtle)]"
        />
      ) : file.kind === "audio" ? (
        <audio controls autoPlay src={url} className="w-full" />
      ) : (
        // File không xem trước được (zip, json…) - vẫn phải mở thẳng được,
        // trang Assets trước đây có link này nên không được làm mất
        <p className="text-sm text-[var(--text-muted)]">
          {t("media.no-preview")}{" "}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-[var(--primary)] hover:underline"
          >
            {t("media.open-direct")}
          </a>
        </p>
      )}
      {/* Đường dẫn tương đối - biết file nằm đâu trong repo mà không phải mở Explorer */}
      <p className="break-all text-meta text-[var(--text-muted)]">
        {file.relPath}
      </p>
    </Modal>
  );
}
