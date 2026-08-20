"use client";

import { Palette, Plus, SearchX, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  createVideoStyle,
  deleteVideoStyle,
  getManagedVideoStyles,
  type ManagedVideoStyle,
} from "@/lib/api";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { CardGridSkeleton } from "@/components/Skeleton";
import { Toolbar } from "@/components/Toolbar";
import { formatRelative } from "@/lib/format";
import { useEvents } from "@/lib/useEvents";
import { useT } from "@/lib/i18n";

/** Cùng lưới với Style Design / Prompts / Skills.

    Lưới nằm TRONG chính <Card> chứa <Toolbar> - ô tìm kiếm và kết quả của nó
    phải ở chung một bề mặt. Vì Card → Panel là hết mức lồng cho phép, thẻ con là
    <Panel> chứ không phải <Card> lồng <Card> (giống hệt trang Style Design). */
const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

/**
 * Quản lý PHONG CÁCH DỰNG (giấy gấp, mực tàu, người que...) - thêm/sửa/xóa như
 * trang Skills và Prompts.
 *
 * KHÁC trang Style Design: Style Design là nhận diện thương hiệu (màu/font/logo)
 * và luôn được cưỡng chế; phong cách dựng là ngôn ngữ thị giác của riêng một
 * video (chất liệu + chuyển động). Hai thứ chồng lên nhau chứ không thay nhau -
 * cùng bộ màu thương hiệu vẫn dựng được video giấy gấp hay video pixel art.
 *
 * BỐ CỤC: lưới thẻ chứ không phải bảng - đây là trang anh em với Style Design,
 * và thứ người dùng cần nhận ra là "phong cách nào" (tên + mô tả chuyển động),
 * không phải so sánh số liệu theo cột.
 */
export default function VideoStylesPage() {
  const { t, tf } = useT();
  const router = useRouter();
  const { resyncTick } = useEvents();

  const [list, setList] = useState<ManagedVideoStyle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Modal "Tạo phong cách"
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Chọn nhiều phong cách để xóa
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setList(await getManagedVideoStyles());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Nạp lần đầu + nạp lại sau mỗi lần SSE nối lại: phong cách có thể vừa bị một
  // phiên AI khác (hoặc tab khác) sửa trong lúc mất kết nối
  useEffect(() => {
    load();
  }, [load, resyncTick]);

  function openCreate() {
    setName("");
    setCloneFrom("");
    setCreateError(null);
    setCreateOpen(true);
  }

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onDeleteSelected() {
    if (bulkDeleting || selected.size === 0 || !list) return;
    const targets = list.filter((s) => selected.has(s.id));
    setBulkDeleting(true);
    setBulkErrors([]);
    // Xóa TUẦN TỰ và gom lỗi lại - xóa nửa chừng rồi văng ra thì người dùng
    // không biết cái nào đã đi cái nào còn.
    const errors: string[] = [];
    for (const s of targets) {
      try {
        // force khi đang có project dùng: modal ĐÃ liệt kê đủ tên phong cách và
        // nói rõ project của chúng sẽ về "AI tự quyết" - giống hệt trang chi tiết.
        await deleteVideoStyle(s.id, s.usageCount > 0);
      } catch (e) {
        errors.push(
          `${s.name} (${s.id}): ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    setBulkDeleting(false);
    setBulkDeleteOpen(false);
    setSelected(new Set());
    setBulkErrors(errors);
    await load();
  }

  async function onCreate() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      // Không clone thì gửi kèm nội dung rỗng-nhưng-hợp-lệ để người dùng vào
      // trang chi tiết sửa tiếp: server bắt buộc 4 field không rỗng, mà bắt gõ
      // đủ cả art/avoid/motion ngay trong modal tạo thì quá nặng cho một hộp thoại.
      const style = await createVideoStyle(
        cloneFrom
          ? { name: name.trim(), cloneFrom }
          : {
              name: name.trim(),
              art: PLACEHOLDER_ART,
              avoid: PLACEHOLDER_AVOID,
              motion: PLACEHOLDER_MOTION,
              palette: "brand",
            },
      );
      setCreateOpen(false);
      router.push(`/video-styles/${style.id}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = (list ?? []).filter((s) =>
    q ? `${s.name} ${s.id} ${s.motion}`.toLowerCase().includes(q) : true
  );
  // Đổi từ khóa tìm kiếm thì BỬe những mục đã tick mà giờ không còn hiện.
  // Không dọn thì: lọc "a" → chọn 5 → đổi sang "b" → thanh công cụ vẫn báo
  // "5 đã chọn" trong khi màn hình toàn hàng khác, và "Xóa đã chọn" xóa luôn
  // 5 mục người dùng không nhìn thấy.
  useEffect(() => {
    const visible = new Set(filtered.map((s) => s.id));
    setSelected((cur) => {
      const next = new Set([...cur].filter((id) => visible.has(id)));
      return next.size === cur.size ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, list]);

  const selectedInUse = (list ?? []).filter(
    (s) => selected.has(s.id) && s.usageCount > 0
  ).length;

  const createButton = (
    <Button onClick={openCreate}>
      <Plus size={16} strokeWidth={2} />
      {t("vstyle.page.create")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.video-styles")}
        hint={{
          titleKey: "help.video-styles.title",
          bodyKey: "help.video-styles.body",
        }}
        subtitle={t("vstyle.page.subtitle")}
        actions={createButton}
      />

      {error && (
        <ErrorBanner message={t("vstyle.page.load-error")} detail={error} />
      )}
      {bulkErrors.length > 0 && (
        <ErrorBanner
          message={tf("vstyle.page.delete-errors", { n: bulkErrors.length })}
          detail={bulkErrors.join("\n")}
        />
      )}

      {/* Số lượng nằm trên TIÊU ĐỀ card, không phải một dòng chữ mờ lơ lửng
          dưới đáy danh sách - ở đó nó vừa dễ bỏ sót vừa không thuộc về cái gì */}
      <Card title={tf("vstyle.page.count", { n: list?.length ?? 0 })}>
        <Toolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t("vstyle.search"),
          }}
          selectedCount={selected.size}
          onClearSelection={() => setSelected(new Set())}
          bulkActions={
            <Button
              variant="destructive"
              small
              disabled={bulkDeleting}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 size={14} strokeWidth={2} />
              {bulkDeleting ? t("common.deleting") : t("common.delete-selected")}
            </Button>
          }
        />
        {/* Khung chờ CHỈ hiện khi đang tải thật. Tải hỏng thì chỉ còn banner đỏ
            ở trên: để khung chờ chạy tiếp là vừa báo "đang tải" vừa báo "tải lỗi"
            cùng lúc, mà cho danh sách về rỗng thì lại nói dối là "chưa có gì". */}
        {list === null ? (
          !error && (
            <div className={GRID}>
              <CardGridSkeleton count={8} />
            </div>
          )
        ) : filtered.length > 0 ? (
          <div className={GRID}>
            {filtered.map((s) => (
              // Vỏ ngoài chỉ để bắt click/Enter - đi qua onClick của vỏ thì
              // stopPropagation của ô tick mới chặn được điều hướng.
              <div
                key={s.id}
                role="link"
                tabIndex={0}
                onClick={() => router.push(`/video-styles/${s.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") router.push(`/video-styles/${s.id}`);
                }}
                className="cursor-pointer"
              >
                <Panel className="h-full transition-colors duration-150 hover:border-[var(--primary)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="flex items-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className="checkbox block"
                        aria-label={tf("common.select-aria", { name: s.name })}
                        checked={selected.has(s.id)}
                        disabled={bulkDeleting}
                        onChange={() => toggleSelect(s.id)}
                      />
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {s.name}
                    </p>
                    {s.builtin && (
                      <Badge
                        tone="muted"
                        dot={false}
                        label={t("vstyle.page.builtin")}
                      />
                    )}
                    {s.palette === "loose" && (
                      <Badge
                        tone="danger"
                        dot={false}
                        label={t("vstyle.loose-badge")}
                      />
                    )}
                  </div>

                  <p className="truncate font-mono text-meta text-[var(--text-muted)]">
                    {s.id}
                  </p>

                  <p className="line-clamp-3 text-sm text-[var(--text-muted)]">
                    {s.motion}
                  </p>

                  <div className="mt-auto flex items-center gap-2 pt-1 text-meta text-[var(--text-muted)]">
                    <span className="truncate">
                      {s.usageCount > 0
                        ? tf("vstyle.page.usage-n", { n: s.usageCount })
                        : t("vstyle.page.usage-none")}
                    </span>
                    <span className="ml-auto shrink-0">
                      {formatRelative(s.updatedAt)}
                    </span>
                  </div>
                </Panel>
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={Palette}
            description={t("vstyle.page.empty")}
            action={createButton}
          />
        ) : (
          <EmptyState icon={SearchX} description={t("vstyle.no-match")} />
        )}
      </Card>

      {/* Xóa nhiều: liệt kê đủ tên rồi mới bắt gõ DELETE, và nói trước chuyện
          project đang dùng sẽ quay về "AI tự quyết" */}
      <ConfirmDeleteModal
        open={bulkDeleteOpen}
        title={t("vstyle.page.delete-selected-title")}
        description={
          <>
            <p>{tf("vstyle.page.delete-desc", { n: selected.size })}</p>
            {selectedInUse > 0 && (
              <p className="mt-2">
                {tf("vstyle.page.delete-in-use", { n: selectedInUse })}
              </p>
            )}
          </>
        }
        items={(list ?? [])
          .filter((s) => selected.has(s.id))
          .map((s) => s.name)}
        busy={bulkDeleting}
        confirmLabel={tf("vstyle.page.delete-n", { n: selected.size })}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={onDeleteSelected}
      />

      {/* Modal tạo phong cách mới - chỉ hỏi tên + nguồn chép, phần nội dung dài
          (chỉ đạo mỹ thuật, chuyển động) sửa ở trang chi tiết cho đủ chỗ */}
      <Modal
        title={t("vstyle.page.create")}
        open={createOpen}
        onClose={() => {
          if (!creating) setCreateOpen(false);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={onCreate} disabled={!name.trim() || creating}>
              <Plus size={15} strokeWidth={2} />
              {creating ? t("common.creating") : t("vstyle.page.create-short")}
            </Button>
          </>
        }
      >
        {createError && (
          <ErrorBanner message={t("vstyle.page.create-error")} detail={createError} />
        )}
        <Field label={t("vstyle.page.name-label")} htmlFor="vstyle-new-name">
          <input
            id="vstyle-new-name"
            className="input"
            autoFocus
            value={name}
            disabled={creating}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("vstyle.page.name-placeholder")}
          />
        </Field>
        <Field
          label={t("vstyle.page.clone-from")}
          htmlFor="vstyle-new-clone"
          hint={t("vstyle.page.clone-hint")}
        >
          <select
            id="vstyle-new-clone"
            className="input"
            value={cloneFrom}
            disabled={creating}
            onChange={(e) => setCloneFrom(e.target.value)}
          >
            <option value="">{t("vstyle.page.blank")}</option>
            {(list ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </Modal>
    </div>
  );
}

// Nội dung nháp cho phong cách tạo từ đầu. CỐ Ý viết tiếng Anh phần art/avoid -
// đó là prompt gửi Gemini, và cố ý viết trung tính để nhìn là biết phải sửa.
const PLACEHOLDER_ART =
  "Describe the material and drawing technique here in English: what it is made of, how it is lit, how deep the scene is.";
const PLACEHOLDER_AVOID = "no photographic realism, no 3D glossy render";
const PLACEHOLDER_MOTION =
  "Mô tả cách hình vào/ra, kiểu chuyển cảnh, nhịp và kiểu chữ của phong cách này.";
