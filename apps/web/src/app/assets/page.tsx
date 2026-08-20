"use client";

import {
  Film,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Music,
  SearchX,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAssets,
  mediaUrl,
  uploadAsset,
  type FileInfo,
} from "@/lib/api";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { MediaPreviewModal } from "@/components/MediaPreviewModal";
import { PageHeader } from "@/components/PageHeader";
import { Segmented } from "@/components/Segmented";
import { TableSkeleton } from "@/components/Skeleton";
import { Toolbar } from "@/components/Toolbar";
import { formatBytes, formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

type Scope = "imports" | "outputs";

function KindIcon({ kind }: { kind: FileInfo["kind"] }) {
  const cls = "shrink-0 text-[var(--text-muted)]";
  switch (kind) {
    case "video":
      return <Film size={15} strokeWidth={1.75} className={cls} />;
    case "audio":
      return <Music size={15} strokeWidth={1.75} className={cls} />;
    case "image":
      return <ImageIcon size={15} strokeWidth={1.75} className={cls} />;
    default:
      return <FileText size={15} strokeWidth={1.75} className={cls} />;
  }
}

export default function AssetsPage() {
  const { t } = useT();
  const [scope, setScope] = useState<Scope>("imports");
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<FileInfo | null>(null);
  // Tìm theo tên file - thư mục imports/ của một người dùng thật dài hàng trăm
  // dòng, cuộn tay tìm một file là việc máy nên làm hộ.
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (s: Scope) => {
    try {
      setFiles(await getAssets(s));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    setFiles(null);
    setPreview(null);
    load(scope);
  }, [scope, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !files) return files;
    return files.filter((f) => f.name.toLowerCase().includes(q));
  }, [files, query]);

  async function doUpload(fileList: FileList | File[]) {
    // Server luôn từ chối upload vào scope "outputs" (400 INVALID_SCOPE)
    if (scope === "outputs") return;
    setUploadError(null);
    setUploading(true);
    // Từng file một try/catch riêng - file lỗi không được nuốt các file đã
    // upload thành công trước đó, và luôn reload để thấy phần đã lên
    const failed: string[] = [];
    try {
      for (const file of Array.from(fileList)) {
        try {
          await uploadAsset(file, scope);
        } catch (e) {
          failed.push(
            `${file.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } finally {
      if (failed.length) setUploadError(failed.join("; "));
      setUploading(false);
      await load(scope);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.assets")}
        hint={{ titleKey: "help.assets.title", bodyKey: "help.assets.body" }}
        subtitle={t("assetsPage.subtitle")}
        actions={
          // Outputs không nhận upload - ẩn nút, giống EmptyState phía dưới
          scope === "imports" ? (
            <Button
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              <Upload size={15} strokeWidth={2} />
              {uploading ? t("common.uploading") : t("assetsPage.upload")}
            </Button>
          ) : undefined
        }
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) doUpload(e.target.files);
          e.target.value = "";
        }}
      />

      {error && (
        <ErrorBanner message={t("assetsPage.load-error")} detail={error} />
      )}
      {uploadError && (
        <ErrorBanner message={t("assetsPage.upload-error")} detail={uploadError} />
      )}

      <div
        onDragOver={(e) => {
          // Vẫn preventDefault ở scope "outputs" để trình duyệt không mở file,
          // nhưng không hiện viền kéo-thả vì thả vào cũng bị bỏ qua
          e.preventDefault();
          if (scope !== "outputs") setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (scope !== "outputs" && e.dataTransfer.files.length)
            doUpload(e.dataTransfer.files);
        }}
        className={`rounded-[var(--radius-lg)] transition-colors duration-150 ${
          dragOver ? "outline-2 outline-dashed outline-[var(--primary)]" : ""
        }`}
      >
        <Card>
          {/* Hai bộ sưu tập vẫn là "tab", nhưng dựng bằng <Segmented> đặt trong
              <Toolbar> - cùng chỗ, cùng hình dạng với bộ lọc của mọi trang danh
              sách khác, thay vì một hàng tab gạch chân chỉ trang này mới có. */}
          <Toolbar
            search={{
              value: query,
              onChange: setQuery,
              placeholder: t("assetsPage.search"),
            }}
          >
            <Segmented
              label={t("assetsPage.scope-aria")}
              value={scope}
              onChange={setScope}
              options={[
                { value: "imports", label: "Imports" },
                { value: "outputs", label: "Outputs" },
              ]}
            />
          </Toolbar>

        {/* Khung chờ CHỈ hiện khi đang tải thật. Tải hỏng thì chỉ còn banner đỏ
            ở trên: để khung chờ chạy tiếp là vừa báo "đang tải" vừa báo "tải lỗi"
            cùng lúc, mà cho danh sách về rỗng thì lại nói dối là "chưa có gì". */}
          {!files ? (
            !error && <TableSkeleton />
          ) : shown && shown.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>{t("common.size")}</th>
                  <th>{t("common.modified")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => (
                  <tr
                    key={f.relPath}
                    className="row-click"
                    onClick={() => setPreview(f)}
                  >
                    <td>
                      <span className="flex items-center gap-2">
                        {/* Ảnh hiện thumbnail thay cho icon - giống bảng Image
                            Projects. Không bọc ZoomableThumb vì cả hàng đã click
                            được để mở đúng modal đó (lồng button trong hàng
                            click được là thừa và dễ bắn hai lần). */}
                        {f.kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`${mediaUrl(f.relPath)}?v=${encodeURIComponent(f.mtime)}`}
                            alt=""
                            className="h-10 w-10 shrink-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-subtle)] object-cover"
                          />
                        ) : (
                          <KindIcon kind={f.kind} />
                        )}
                        {f.name}
                      </span>
                    </td>
                    <td className="text-[var(--text-muted)]">
                      {formatBytes(f.size)}
                    </td>
                    <td className="text-[var(--text-muted)]">
                      {formatRelative(f.mtime)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : files.length > 0 ? (
            // Lọc không ra gì KHÁC với thư mục rỗng: mời upload lúc người dùng
            // chỉ gõ nhầm từ khóa là trả lời sai câu hỏi.
            <EmptyState icon={SearchX} description={t("common.no-match")} />
          ) : (
            <EmptyState
              icon={FolderOpen}
              description={
                scope === "imports"
                  ? t("assetsPage.empty-imports")
                  : t("assetsPage.empty-outputs")
              }
              action={
                scope === "imports" ? (
                  <Button onClick={() => inputRef.current?.click()}>
                    <Upload size={15} strokeWidth={2} />
                    {t("assetsPage.upload")}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      </div>

      {/* Modal dùng chung toàn app - trước đây trang này tự chế card xem trước
          nội tuyến: không đóng được bằng Esc, không có nút "Mở file", và nó đẩy
          bố cục trang xô xuống mỗi lần bấm một file */}
      <MediaPreviewModal file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
