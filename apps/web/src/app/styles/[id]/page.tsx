"use client";

/**
 * Chi tiết một Style Design - bộ nhận diện (màu, font, logo, tone).
 *
 * Bố cục dùng bộ khối workspace 3 cột dùng chung, KHÔNG tự dựng lưới bằng media
 * query nữa: bề rộng thật của vùng nội dung còn phụ thuộc rail trái và panel
 * phải đang gấp hay mở, nên số cột phải do container query của `.workspace-grid`
 * quyết định (xem ghi chú "Workspace 3 cột" trong globals.css).
 *
 * Mọi hành động cấp trang (Lưu, Đặt mặc định, Xóa) nằm trên PageHeader - giống
 * các trang chi tiết khác - chứ không còn một thanh hành động tự chế ở đáy trang.
 */

import {
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Save,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  deleteStyle,
  deleteStyleFont,
  getStyles,
  setDefaultStyle,
  styleFontGoogle,
  updateStyle,
  uploadStyleFont,
  uploadStyleLogo,
  type FileInfo,
  type StyleColors,
  type StyleDesign,
  type StyleEffects,
  type StyleFontSlot,
} from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { CheckboxField, Field } from "@/components/Field";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { ErrorBanner } from "@/components/ErrorBanner";
import { IconButton } from "@/components/IconButton";
import {
  MediaPreviewModal,
  ZoomableThumb,
  imageFileInfo,
} from "@/components/MediaPreviewModal";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { Skeleton } from "@/components/Skeleton";
import { TagInput } from "@/components/TagInput";
import { Workspace, WorkspaceColumn } from "@/components/Workspace";
import { refreshStyles } from "@/components/StyleSelect";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

// label là KEY dictionary - dịch bằng t() lúc render.
const COLOR_FIELDS: { key: keyof StyleColors; label: string }[] = [
  { key: "primary", label: "styleDetail.color.primary" },
  { key: "secondary", label: "styleDetail.color.secondary" },
  { key: "background", label: "styleDetail.color.background" },
  { key: "text", label: "styleDetail.color.text" },
  { key: "accent", label: "styleDetail.color.accent" },
];

// Khớp server: chấp nhận cả hex 6 và 8 chữ số (#rrggbb / #rrggbbaa)
const HEX_RE = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
// Fallback CHỈ cho value của <input type="color"> khi hex user gõ chưa hợp lệ
// - đây là DATA brand của user, không phải màu UI (token UI nằm ở globals.css).
const COLOR_INPUT_FALLBACK = "#000000";

/** Lấy #rrggbb (6 chữ số đầu) - <input type="color"> và gradient preview
 *  cần dạng 6 chữ số, hex 8 chữ số đưa thẳng vào là đen thui/không nhận. */
function hex6(v: string): string {
  return v.slice(0, 7).toLowerCase();
}

/** Hiệu ứng mặc định cho style cũ chưa có field effects. */
const DEFAULT_EFFECTS: StyleEffects = { gradient: true, liquidGlass: true };

/** Font Google phổ biến hỗ trợ đầy đủ glyph tiếng Việt - gợi ý datalist. */
const GOOGLE_FONT_SUGGESTIONS = [
  "Be Vietnam Pro",
  "Inter",
  "Montserrat",
  "Roboto",
  "Lexend",
  "Nunito",
  "Archivo",
  "Space Grotesk",
  "Sora",
  "Manrope",
];

const FONT_SLOTS: { slot: StyleFontSlot; label: string }[] = [
  { slot: "heading", label: "styleDetail.font.heading" },
  { slot: "body", label: "styleDetail.font.body" },
];

function ColorField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useT();
  const valid = HEX_RE.test(value);
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} ${t("styleDetail.palette-aria")}`}
          className="h-9 w-9 shrink-0 cursor-pointer rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-1"
          value={valid ? hex6(value) : COLOR_INPUT_FALLBACK}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        {/* `.input` chuẩn 14px - ô này chứa DỮ LIỆU brand người dùng gõ vào, thu
            nhỏ xuống 12px thì chính thứ cần đọc lại là chữ nhỏ nhất màn hình */}
        <input
          id={id}
          className="input min-w-0 flex-1 font-mono"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#rrggbb"
        />
      </div>
    </Field>
  );
}

/**
 * Preview mini - dải 5 swatch + chữ mẫu trên nền style. Mọi màu ở đây là
 * DATA brand của user (inline style), không phải token UI.
 */
function StylePreview({ style }: { style: StyleDesign }) {
  const c = style.colors;
  const fx = style.effects ?? DEFAULT_EFFECTS;
  const highlightStyle: CSSProperties =
    fx.gradient && HEX_RE.test(c.primary) && HEX_RE.test(c.secondary)
      ? {
          backgroundImage: `linear-gradient(90deg, ${hex6(c.primary)}, ${hex6(c.secondary)})`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }
      : { color: c.primary };
  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
      <div className="flex h-8">
        {COLOR_FIELDS.map(({ key }) => (
          <span
            key={key}
            className="flex-1"
            style={{ backgroundColor: c[key] }}
            title={`${key}: ${c[key]}`}
          />
        ))}
      </div>
      <div
        className="flex items-baseline gap-4 px-4 py-3"
        style={{ backgroundColor: c.background }}
      >
        {/* 26px là DỮ LIỆU thương hiệu (mẫu chữ), không phải chrome của app -
            nên nó nằm ngoài thang chữ ba bậc, cố ý giữ nguyên */}
        <span
          className="text-[26px] font-bold leading-none"
          style={{ color: c.text }}
        >
          Aa Ắộ
        </span>
        <span className="text-[26px] font-bold leading-none" style={highlightStyle}>
          Aa Ắộ
        </span>
      </div>
    </div>
  );
}

export default function StyleDetailPage() {
  const params = useParams<{ id: string }>();
  const styleId = params.id;
  const router = useRouter();
  const { t, tf } = useT();

  const [style, setStyle] = useState<StyleDesign | null>(null);
  // Xem logo ở kích thước thật - logo 14px cao thì không kiểm được chất lượng
  const [preview, setPreview] = useState<FileInfo | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [settingDefault, setSettingDefault] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Tải font từ Google theo tên - trạng thái riêng từng slot
  const [fontDl, setFontDl] = useState<
    Partial<Record<StyleFontSlot, { busy?: boolean; error?: string }>>
  >({});

  // Upload file font thủ công - một input file dùng chung cho cả hai slot
  const [fontBusy, setFontBusy] = useState<StyleFontSlot | null>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const fontSlotRef = useRef<StyleFontSlot>("heading");

  const load = useCallback(async () => {
    try {
      // Hợp đồng không có GET /api/styles/:id - lấy danh sách rồi tìm theo id
      const r = await getStyles();
      setDefaultId(r.defaultId);
      const s = r.styles.find((x) => x.id === styleId) ?? null;
      if (!s) {
        setNotFound(true);
        return;
      }
      setStyle(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [styleId]);

  useEffect(() => {
    load();
  }, [load]);

  function patch(p: Partial<StyleDesign>) {
    setSaved(false);
    setStyle((s) => (s ? { ...s, ...p } : s));
  }

  const effects = style?.effects ?? DEFAULT_EFFECTS;

  async function onSave() {
    if (!style || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const s = await updateStyle(styleId, {
        name: style.name,
        tags: style.tags,
        colors: style.colors,
        fonts: style.fonts,
        effects: style.effects ?? DEFAULT_EFFECTS,
        tone: style.tone,
        guidelines: style.guidelines,
      });
      setStyle(s);
      setSaved(true);
      refreshStyles();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onSetDefault() {
    if (settingDefault) return;
    setSettingDefault(true);
    setSaveError(null);
    try {
      const { defaultId: next } = await setDefaultStyle(styleId);
      setDefaultId(next);
      refreshStyles();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingDefault(false);
    }
  }

  // Modal xác nhận xóa style - bắt gõ DELETE (thay window.confirm)
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteStyle(styleId);
      refreshStyles();
      router.push("/styles");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  async function onLogoPicked(file: File) {
    setUploadingLogo(true);
    setSaveError(null);
    try {
      const s = await uploadStyleLogo(styleId, file);
      setStyle((cur) => (cur ? { ...cur, logoPath: s.logoPath } : s));
      refreshStyles();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingLogo(false);
    }
  }

  /** Tải font từ Google Fonts theo tên đang gõ trong ô của slot. */
  async function onFontGoogle(slot: StyleFontSlot) {
    if (!style || fontDl[slot]?.busy) return;
    const family = style.fonts[slot].trim();
    if (!family) {
      setFontDl((m) => ({
        ...m,
        [slot]: { error: t("styleDetail.font-name-required") },
      }));
      return;
    }
    setFontDl((m) => ({ ...m, [slot]: { busy: true } }));
    try {
      const s = await styleFontGoogle(styleId, slot, family);
      // Chỉ merge phần server đổi - không clobber các field đang sửa dở
      setStyle((cur) =>
        cur
          ? { ...cur, fonts: s.fonts, fontFiles: s.fontFiles, updatedAt: s.updatedAt }
          : s
      );
      setFontDl((m) => ({ ...m, [slot]: {} }));
      refreshStyles();
    } catch (e) {
      setFontDl((m) => ({
        ...m,
        [slot]: { error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  async function onFontPicked(slot: StyleFontSlot, file: File) {
    setFontBusy(slot);
    setSaveError(null);
    try {
      const s = await uploadStyleFont(styleId, slot, file);
      setStyle((cur) => (cur ? { ...cur, fontFiles: s.fontFiles } : s));
      refreshStyles();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setFontBusy(null);
    }
  }

  async function onFontRemove(slot: StyleFontSlot) {
    setFontBusy(slot);
    setSaveError(null);
    try {
      const s = await deleteStyleFont(styleId, slot);
      setStyle((cur) => (cur ? { ...cur, fontFiles: s.fontFiles } : s));
      refreshStyles();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setFontBusy(null);
    }
  }

  const isDefault = defaultId === styleId;
  const busy = saving || deleting;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={style?.name ?? styleId}
        hint={{ titleKey: "help.styles.title", bodyKey: "help.styles.body" }}
        subtitle={
          style
            ? tf("styleDetail.updated", { time: formatRelative(style.updatedAt) })
            : undefined
        }
        actions={
          /* Nút xóa đứng CUỐI, ngoài cụm nút thường, ngăn bằng vạch dọc - quy
             ước chung của 7 trang chi tiết, lý do viết đầy đủ ở
             `src/app/images/[id]/page.tsx`. */
          <>
            <span className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => router.push("/styles")}>
                <ArrowLeft size={15} strokeWidth={2} />
                {t("nav.styles")}
              </Button>
              {style && !isDefault && (
                <Button
                  variant="secondary"
                  disabled={settingDefault || busy}
                  onClick={onSetDefault}
                >
                  <Star size={15} strokeWidth={2} />
                  {settingDefault
                    ? t("styleDetail.setting-default")
                    : t("styleDetail.set-default")}
                </Button>
              )}
              <Button onClick={onSave} disabled={!style || busy}>
                <Save size={15} strokeWidth={2} />
                {saving ? t("common.saving") : t("common.save")}
              </Button>
            </span>
            <span className="flex items-center border-l border-[var(--border)] pl-2">
              <Button
                variant="destructive"
                disabled={!style || busy}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 size={15} strokeWidth={2} />
                {deleting ? t("common.deleting") : t("styleDetail.delete")}
              </Button>
            </span>
          </>
        }
      />

      {style && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
          {/* dot={false}: đây là nhãn PHÂN LOẠI, chấm tròn là quy ước của TRẠNG
              THÁI - gắn vào đây người dùng đọc thành "đang chạy / đã xong" */}
          {isDefault && (
            <Badge tone="running" label={t("styles.default")} dot={false} />
          )}
          <span className="text-meta">ID: {style.id}</span>
        </div>
      )}

      {loadError && (
        <ErrorBanner message={t("styleDetail.load-error")} detail={loadError} />
      )}
      {notFound && (
        <ErrorBanner
          message={tf("styleDetail.not-found", { id: styleId })}
          detail={t("styleDetail.not-found-detail")}
        />
      )}
      {saveError && <ErrorBanner message={t("common.save-error")} detail={saveError} />}
      {deleteError && (
        <ErrorBanner message={t("styleDetail.delete-error")} detail={deleteError} />
      )}
      {saved && <Banner tone="success" message={t("common.saved")} />}

      {!style && !loadError && !notFound && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {style && (
        <>
          <Workspace>
            {/* Trang này KHÔNG có kết quả sinh ra lúc chạy (không OutputBlock,
                không job) - cả ba cột đều là form. Nên cột 3 mang role="setup"
                chứ không phải "output": `.workspace-col-output` bị
                `grid-column: 1 / -1` trong khoảng 700-1200px, tức là cái form
                cuối trải hết bề ngang nằm dưới hai card nửa-rộng, gãy hẳn nhịp
                lưới. Tên cột lấy luôn tên nhóm nội dung (Nhận diện / Màu & hiệu
                ứng / Chữ & Logo) thay vì nhãn chung "Yêu cầu & thiết lập" - hai
                cột cùng role mà cùng một nhãn thì không phân biệt được; card
                bên trong bỏ tiêu đề để khỏi nhắc lại đúng chữ đó hai lần. */}
            {/* ============ Cột 1 - Nhận diện ============ */}
            <WorkspaceColumn
              role="source"
              title={t("styleDetail.identity")}
              ariaLabel={t("styleDetail.identity")}
            >
              <Card>
                <div className="flex flex-col gap-4">
                  <StylePreview style={style} />

                  <Field
                    label={t("stylesPage.name-label")}
                    htmlFor="style-name"
                  >
                    <input
                      id="style-name"
                      className="input"
                      value={style.name}
                      disabled={busy}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder={t("stylesPage.name-placeholder")}
                    />
                  </Field>

                  <Field label={t("common.tags")} htmlFor="style-tags">
                    <TagInput
                      id="style-tags"
                      tags={style.tags}
                      onChange={(tags) => patch({ tags })}
                    />
                  </Field>
                </div>
              </Card>
            </WorkspaceColumn>

            {/* ============ Cột 2 - Màu & hiệu ứng ============ */}
            <WorkspaceColumn
              role="setup"
              title={t("styleDetail.palette")}
              ariaLabel={t("styleDetail.palette")}
            >
              <Card>
                <div className="flex flex-col gap-4">
                  {/* auto-fit chứ không `grid-cols-2`: mỗi ColorField là swatch
                      36px + ô hex, ở bố cục 3 cột thì nửa cột chỉ còn ~155px và
                      ô hex bị bóp. Ít chỗ thì xuống một cột, rộng thì tự xếp 2-3
                      ô - lưới co theo chỗ thật của cột, không theo bề rộng cửa sổ. */}
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
                    {COLOR_FIELDS.map(({ key, label }) => (
                      <ColorField
                        key={key}
                        id={`style-color-${key}`}
                        label={t(label)}
                        value={style.colors[key] ?? ""}
                        disabled={busy}
                        onChange={(v) =>
                          patch({ colors: { ...style.colors, [key]: v } })
                        }
                      />
                    ))}
                  </div>

                  <Panel title={t("styleDetail.effects")}>
                    <CheckboxField
                      id="style-fx-gradient"
                      label="Gradient"
                      hint={t("styleDetail.gradient-hint")}
                      checked={effects.gradient}
                      disabled={busy}
                      onChange={(gradient) =>
                        patch({ effects: { ...effects, gradient } })
                      }
                    />
                    <CheckboxField
                      id="style-fx-liquid"
                      label="Liquid Glass"
                      hint={t("styleDetail.liquid-hint")}
                      checked={effects.liquidGlass}
                      disabled={busy}
                      onChange={(liquidGlass) =>
                        patch({ effects: { ...effects, liquidGlass } })
                      }
                    />
                  </Panel>
                </div>
              </Card>
            </WorkspaceColumn>

            {/* ============ Cột 3 - Chữ & Logo ============ */}
            <WorkspaceColumn
              role="setup"
              title={t("styleDetail.type-logo")}
              ariaLabel={t("styleDetail.type-logo")}
            >
              <Card>
                <div className="flex flex-col gap-4">
                  {/* Đường CHÍNH: gõ tên font rồi để hệ thống tải từ Google */}
                  {FONT_SLOTS.map(({ slot, label }) => {
                    const dl = fontDl[slot];
                    const relPath = style.fontFiles?.[slot] ?? null;
                    const fileName = relPath ? relPath.split("/").pop() : null;
                    return (
                      <Field
                        key={slot}
                        label={t(label)}
                        htmlFor={`style-font-${slot}`}
                        error={dl?.error ?? null}
                        hint={
                          fileName ? (
                            <span className="inline-flex items-center gap-1 text-[var(--success)]">
                              <Check size={13} strokeWidth={2.5} />
                              {t("styleDetail.font-ready")} {fileName}
                            </span>
                          ) : (
                            t("styleDetail.font-missing")
                          )
                        }
                      >
                        <div className="flex items-center gap-2">
                          <input
                            id={`style-font-${slot}`}
                            className="input min-w-0 flex-1"
                            list="google-fonts-vn"
                            value={style.fonts[slot]}
                            disabled={busy || !!dl?.busy}
                            onChange={(e) => {
                              patch({
                                fonts: {
                                  ...style.fonts,
                                  [slot]: e.target.value,
                                },
                              });
                              // Gõ tên mới → xóa kết quả tải cũ của slot
                              setFontDl((m) => ({ ...m, [slot]: {} }));
                            }}
                            placeholder="vd: Be Vietnam Pro"
                          />
                          <Button
                            variant="secondary"
                            small
                            className="shrink-0"
                            disabled={busy || !!dl?.busy}
                            onClick={() => onFontGoogle(slot)}
                          >
                            {dl?.busy ? (
                              <Loader2
                                size={13}
                                strokeWidth={2}
                                className="animate-spin"
                              />
                            ) : (
                              <Download size={13} strokeWidth={2} />
                            )}
                            {dl?.busy
                              ? t("styleDetail.downloading")
                              : t("styleDetail.download-font")}
                          </Button>
                        </div>
                      </Field>
                    );
                  })}
                  <datalist id="google-fonts-vn">
                    {GOOGLE_FONT_SUGGESTIONS.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>

                  {/* Danh sách gợi ý ở trên chỉ là vài font hợp tiếng Việt, còn
                      kho thật thì hàng nghìn - nói thẳng ra chỗ duyệt, vì hệ
                      thống KHÔNG kèm sẵn font nào (font có giấy phép riêng). */}
                  <Banner
                    tone="info"
                    message={
                      <>
                        {t("styleDetail.font-browse")}{" "}
                        <a
                          href="https://fonts.google.com"
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-sm font-medium text-[var(--primary)] hover:underline"
                        >
                          fonts.google.com
                          <ExternalLink size={12} strokeWidth={2} className="shrink-0" />
                        </a>{" "}
                        {t("styleDetail.font-license-note")}
                      </>
                    }
                  />

                  {/* Đường PHỤ cho cùng một trường: file font tự có trên máy.
                      Trước đây khối này nấp sau một nút "hoặc tự upload file
                      font", nên cùng một việc lại trông như hai tính năng và
                      người dùng không thấy được mình ĐANG có file nào. */}
                  <Panel title={t("styleDetail.font-files")}>
                    {FONT_SLOTS.map(({ slot }) => {
                      const relPath = style.fontFiles?.[slot] ?? null;
                      const fileName = relPath ? relPath.split("/").pop() : null;
                      const label = slot === "heading" ? "Heading" : "Body";
                      return (
                        <div key={slot} className="flex items-center gap-2">
                          <span className="w-16 shrink-0 text-sm font-medium">
                            {label}
                          </span>
                          <span
                            className={`min-w-0 flex-1 truncate text-meta ${
                              fileName ? "" : "text-[var(--text-muted)]"
                            }`}
                            title={fileName ?? undefined}
                          >
                            {fileName ?? t("styleDetail.no-font-file")}
                          </span>
                          <Button
                            variant="secondary"
                            small
                            disabled={fontBusy !== null || busy}
                            onClick={() => {
                              fontSlotRef.current = slot;
                              fontInputRef.current?.click();
                            }}
                          >
                            <Upload size={13} strokeWidth={2} />
                            {fontBusy === slot
                              ? t("styleDetail.downloading")
                              : t("styleDetail.upload-file")}
                          </Button>
                          {fileName && (
                            <IconButton
                              label={tf("styleDetail.remove-font-aria", { label })}
                              size="sm"
                              tone="danger"
                              disabled={fontBusy !== null || busy}
                              onClick={() => onFontRemove(slot)}
                            >
                              <X size={13} strokeWidth={2} />
                            </IconButton>
                          )}
                        </div>
                      );
                    })}
                    <input
                      ref={fontInputRef}
                      type="file"
                      accept=".ttf,.otf,.woff,.woff2"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onFontPicked(fontSlotRef.current, f);
                        e.target.value = "";
                      }}
                    />
                  </Panel>

                  <Panel title="Logo">
                    <div className="flex items-center gap-3">
                      {style.logoPath ? (
                        <ZoomableThumb
                          file={imageFileInfo(style.logoPath, {
                            name: tf("stylesPage.logo-alt", { name: style.name }),
                          })}
                          alt={tf("stylesPage.logo-alt", { name: style.name })}
                          onOpen={setPreview}
                          className="h-14 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
                          imgClassName="h-full w-auto p-2"
                          iconSize={16}
                        />
                      ) : (
                        <span className="flex h-14 w-14 items-center justify-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                          <ImageIcon
                            size={18}
                            strokeWidth={1.5}
                            className="text-[var(--text-muted)] opacity-40"
                          />
                        </span>
                      )}
                      <Button
                        variant="secondary"
                        small
                        disabled={uploadingLogo || busy}
                        onClick={() => logoInputRef.current?.click()}
                      >
                        <Upload size={14} strokeWidth={2} />
                        {uploadingLogo
                          ? t("common.uploading")
                          : t("styleDetail.upload-logo")}
                      </Button>
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept=".png,.jpg,.jpeg,.svg,.webp"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onLogoPicked(f);
                          e.target.value = "";
                        }}
                      />
                    </div>
                  </Panel>

                  <Field label="Tone" htmlFor="style-tone">
                    <input
                      id="style-tone"
                      className="input"
                      value={style.tone}
                      disabled={busy}
                      onChange={(e) => patch({ tone: e.target.value })}
                      placeholder={t("styleDetail.tone-placeholder")}
                    />
                  </Field>

                  <Field label="Guidelines" htmlFor="style-guidelines">
                    <textarea
                      id="style-guidelines"
                      className="input"
                      rows={5}
                      value={style.guidelines}
                      disabled={busy}
                      onChange={(e) => patch({ guidelines: e.target.value })}
                      placeholder={t("styleDetail.guidelines-placeholder")}
                    />
                  </Field>
                </div>
              </Card>
            </WorkspaceColumn>
          </Workspace>

          <p className="text-meta text-[var(--text-muted)]">
            {t("styleDetail.note")}
          </p>
        </>
      )}

      {/* Modal xác nhận xóa style - bắt gõ DELETE */}
      <ConfirmDeleteModal
        open={deleteOpen}
        title={t("styleDetail.delete")}
        description={
          <>
            {t("styleDetail.delete-desc-1")}{" "}
            <span className="font-medium">{style?.name ?? styleId}</span>? {t("styleDetail.delete-desc-2")}
          </>
        }
        busy={deleting}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />

      <MediaPreviewModal file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
