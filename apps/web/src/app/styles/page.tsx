"use client";

import { Palette, SearchX, Trash2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  createStyle,
  deleteStyle,
  getStyles,
  mediaUrl,
  type StyleColors,
  type StyleDesign,
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
import { TagInput } from "@/components/TagInput";
import { Toolbar } from "@/components/Toolbar";
import { refreshStyles } from "@/components/StyleSelect";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** Thứ tự 5 màu trên dải swatch - trùng thứ tự form editor. */
const SWATCH_KEYS: (keyof StyleColors)[] = [
  "primary",
  "secondary",
  "background",
  "text",
  "accent",
];

/** Cùng lưới với Prompts / Skills / Phong cách dựng - bốn trang lưới thẻ của
    dashboard phải xuống hàng ở đúng những ngưỡng giống nhau.

    Lưới nằm TRONG chính <Card> chứa <Toolbar>: trước đây nó là anh em ruột nằm
    ngoài card, nên ô tìm kiếm ở một bề mặt còn kết quả của nó không thuộc bề mặt
    nào. Vì Card → Panel là hết mức lồng cho phép, thẻ con là <Panel> chứ không
    phải <Card> lồng <Card>. */
const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

/** Dải 5 ô màu của style - màu style là DATA của user, render bằng inline style. */
function SwatchStrip({ colors }: { colors: StyleColors }) {
  return (
    <div className="flex h-10 overflow-hidden rounded-[var(--radius)]">
      {SWATCH_KEYS.map((k) => (
        <span
          key={k}
          className="flex-1"
          style={{ backgroundColor: colors[k] }}
          title={`${k}: ${colors[k]}`}
        />
      ))}
    </div>
  );
}

export default function StylesPage() {
  const { t, tf } = useT();
  const router = useRouter();
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [list, setList] = useState<StyleDesign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Modal "Tạo style"
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [cloneFrom, setCloneFrom] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Chọn nhiều style để xóa
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await getStyles();
      setDefaultId(r.defaultId);
      setList(r.styles);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setName("");
    setTags([]);
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
    // Xóa TUẦN TỰ - lỗi nào (vd style cuối cùng / LAST_STYLE) gom hiện sau
    const errors: string[] = [];
    for (const s of targets) {
      try {
        await deleteStyle(s.id);
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
    refreshStyles();
    await load();
  }

  async function onCreate() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const s = await createStyle({
        name: name.trim(),
        ...(tags.length > 0 ? { tags } : {}),
        ...(cloneFrom ? { cloneFrom } : {}),
      });
      refreshStyles();
      setCreateOpen(false);
      router.push(`/styles/${s.id}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = (list ?? []).filter((s) =>
    q
      ? `${s.name} ${s.id} ${s.tags.join(" ")}`.toLowerCase().includes(q)
      : true
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
    // filtered là mảng mới mỗi lượt render nên phụ thuộc vào `q` và `list`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, list]);

  const createButton = (
    <Button onClick={openCreate}>
      <Plus size={16} strokeWidth={2} />
      {t("stylesPage.create")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("nav.styles")}
        hint={{ titleKey: "help.styles.title", bodyKey: "help.styles.body" }}
        subtitle={t("stylesPage.subtitle")}
        actions={createButton}
      />

      {error && (
        <ErrorBanner message={t("stylesPage.load-error")} detail={error} />
      )}
      {bulkErrors.length > 0 && (
        <ErrorBanner
          message={tf("stylesPage.delete-errors", { n: bulkErrors.length })}
          detail={bulkErrors.join("\n")}
        />
      )}

      {/* Thanh công cụ + số lượng nằm TRONG card, ngay trên lưới: trước đây
          thanh "đã chọn N style" lơ lửng trên nền trang, không thuộc về cái gì */}
      <Card title={tf("stylesPage.count", { n: list?.length ?? 0 })}>
        <Toolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t("stylesPage.search"),
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
              // Vỏ ngoài chỉ để bắt click/Enter - nhờ đi qua onClick của vỏ mà
              // stopPropagation của ô tick vẫn chặn được điều hướng (khác hẳn
              // khi bọc bằng <Link>).
              <div
                key={s.id}
                role="link"
                tabIndex={0}
                onClick={() => router.push(`/styles/${s.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") router.push(`/styles/${s.id}`);
                }}
                className="cursor-pointer"
              >
                <Panel className="h-full transition-colors duration-150 hover:border-[var(--primary)]">
                  <div className="flex items-center gap-2">
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
                    {s.id === defaultId && (
                      <Badge
                        tone="running"
                        dot={false}
                        label={t("styles.default")}
                      />
                    )}
                  </div>

                  <SwatchStrip colors={s.colors} />

                  {s.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {s.tags.map((tag) => (
                        <span key={tag} className="chip">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-auto flex items-center gap-2">
                    {s.logoPath && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaUrl(s.logoPath)}
                        alt={tf("stylesPage.logo-alt", { name: s.name })}
                        className="h-6 w-auto max-w-[96px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] object-contain p-1"
                      />
                    )}
                    <span className="ml-auto text-meta text-[var(--text-muted)]">
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
            description={t("stylesPage.empty")}
            action={createButton}
          />
        ) : (
          <EmptyState icon={SearchX} description={t("stylesPage.no-match")} />
        )}
      </Card>

      {/* Modal xác nhận xóa nhiều style - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={bulkDeleteOpen}
        title={t("stylesPage.delete-selected-title")}
        description={
          <p>{tf("stylesPage.delete-desc", { n: selected.size })}</p>
        }
        items={(list ?? [])
          .filter((s) => selected.has(s.id))
          .map((s) => s.name)}
        busy={bulkDeleting}
        confirmLabel={tf("stylesPage.delete-n", { n: selected.size })}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={onDeleteSelected}
      />

      {/* Modal tạo style mới */}
      <Modal
        title={t("stylesPage.create")}
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
              {creating ? t("common.creating") : t("stylesPage.create")}
            </Button>
          </>
        }
      >
        {createError && (
          <ErrorBanner message={t("stylesPage.create-error")} detail={createError} />
        )}
        <Field label={t("stylesPage.name-label")} htmlFor="style-new-name">
          <input
            id="style-new-name"
            className="input"
            autoFocus
            value={name}
            disabled={creating}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("stylesPage.name-placeholder")}
          />
        </Field>
        <Field label={t("common.tags")} htmlFor="style-new-tags">
          <TagInput id="style-new-tags" tags={tags} onChange={setTags} />
        </Field>
        <Field
          label={t("stylesPage.clone-from")}
          htmlFor="style-new-clone"
          hint={t("stylesPage.clone-hint")}
        >
          <select
            id="style-new-clone"
            className="input"
            value={cloneFrom}
            disabled={creating}
            onChange={(e) => setCloneFrom(e.target.value)}
          >
            <option value="">{t("stylesPage.blank")}</option>
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
