"use client";

/**
 * Toàn bộ các TRƯỜNG NHẬP của "Kịch bản edit" (Brief), tách khỏi ProjectBriefCard
 * để dùng lại được ở nơi khác - hiện có: Videos Project (một project) và Auto cut
 * videos (một lần cấu hình cho cả phiên cắt, áp cho mọi video con).
 *
 * Component này KHÔNG biết gì về project/phiên: nó chỉ nhận `value` + báo `onChange`.
 * Chỗ nào lưu, lưu đi đâu là việc của component cha.
 */

import { AlertTriangle, FileSpreadsheet, Link2, Loader2, Plus, ScrollText, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AUTO_CUT_LEVELS,
  getPrompts,
  getSkills,
  deleteBriefReference,
  importBriefGoogleSheet,
  uploadBriefReference,
  type Brief,
  type MusicMode,
  type PromptTemplate,
  type SfxMode,
  type SkillMeta,
  type TrimAggressiveness,
} from "@/lib/api";
import { CheckboxField, Field, SwitchField } from "@/components/Field";
import { Button } from "@/components/Button";
import { Banner } from "@/components/Banner";
import { Panel } from "@/components/Panel";
import { Segmented } from "@/components/Segmented";
import { TagInput } from "@/components/TagInput";
import { TextPositionPicker, useGeminiImageModels } from "@/components/ImageProjectForm";
import { useProviders } from "@/components/ModelPicker";
import { StyleSelect } from "@/components/StyleSelect";
import { VideoStyleSelect } from "@/components/VideoStyleSelect";
import { useT } from "@/lib/i18n";

/**
 * Nút dạng LIÊN KẾT trong biểu mẫu ("Quản lý prompt", "Thêm từ khóa").
 * Một class duy nhất cho cả file - trước đây mỗi chỗ tự chế một biến thể
 * (12px đổi màu lúc hover ở chỗ này, 12px gạch chân ở chỗ kia).
 */
const LINK_BTN =
  "inline-flex w-fit items-center gap-1 text-sm font-medium text-[var(--primary)] hover:underline disabled:opacity-50";

/**
 * Vùng con bung ra khi một công tắc được BẬT.
 * Thụt lề bằng KHOẢNG TRẮNG, không thêm đường kẻ: hộp ngoài đã là <Panel> có
 * viền, thêm border-t cho mỗi vùng bung nữa là ba tầng đường kẻ lồng nhau
 * trong đúng một hộp 12px - mắt không còn đọc ra cái nào thuộc cái nào.
 */
const SUBFIELDS = "flex flex-col gap-3 pl-4";

export const DEFAULT_BRIEF: Brief = {
  sourceDescription: "",
  // Khớp defaultBrief() phía server - lệch default là lưu sớm sẽ âm thầm đổi hành vi
  autoCut: true,
  autoCutLevel: "default",
  subtitles: true,
  highlightEnabled: true,
  highlightKeywords: [],
  keyLayoutEnabled: true,
  mainKey: "",
  relatedKeys: [],
  skill: null,
  sfxMode: "recommended",
  musicMode: "auto",
  notes: "",
  autoIllustrations: false,
  illustrationModel: null,
  illustrationText: false,
  illustrationPosition: "auto",
  illustrationsPerMinute: null,
  styleId: null,
  videoStyleEnabled: false,
  videoStyleId: null,
  referenceName: "",
  referenceUrl: "",
  referenceContent: "",
};

// Giá trị là KEY dictionary - dịch bằng t() lúc render.
export const SFX_MODE_LABEL: Record<SfxMode, string> = {
  recommended: "brief.sfx.recommended",
  library: "brief.sfx.library",
  none: "brief.sfx.none",
};

export const MUSIC_MODE_LABEL: Record<MusicMode, string> = {
  auto: "brief.music.auto",
  none: "brief.music.none",
};

/**
 * Mức mạnh tay khi cắt tự động. Nhãn + gợi ý dùng lại được ở chỗ khác (card
 * "Cắt tự động" đọc báo cáo cũng cần đúng những nhãn này) nên export.
 */
export const AUTO_CUT_LEVEL_LABEL: Record<TrimAggressiveness, string> = {
  natural: "brief.autocut-level-natural",
  default: "brief.autocut-level-default",
  tight: "brief.autocut-level-tight",
};

/** Gợi ý từng mức - con số lấy thẳng từ TRIM_PROFILES của server, không làm tròn cho đẹp. */
const AUTO_CUT_LEVEL_HINT: Record<TrimAggressiveness, string> = {
  natural: "brief.autocut-level-natural-hint",
  default: "brief.autocut-level-default-hint",
  tight: "brief.autocut-level-tight-hint",
};

export function BriefFields({
  value,
  onChange,
  show,
  disabled = false,
  projectId,
}: {
  value: Brief;
  /** Chỉ gửi phần vừa đổi - cha tự merge để không nuốt thay đổi song song. */
  onChange: (patch: Partial<Brief>) => void;
  /** Ẩn bớt trường không hợp ngữ cảnh - Auto cut ẩn "styleId" và "sourceDescription". */
  show?: { styleId?: boolean; sourceDescription?: boolean };
  /** Khóa toàn bộ form (vd phiên cắt đang chạy) - fieldset tự khóa mọi control con. */
  disabled?: boolean;
  /** Có projectId thì hiện khu vực phân tích Word/Excel/Google Sheets. */
  projectId?: string;
}) {
  const { t, tf } = useT();
  const showStyle = show?.styleId ?? true;
  const showSource = show?.sourceDescription ?? true;

  const [showKeywords, setShowKeywords] = useState(false);
  // Bố cục Key: false = AI tự đề xuất & sử dụng (mặc định), true = user tự chỉ định
  const [keyManual, setKeyManual] = useState(
    () => value.mainKey.trim() !== "" || value.relatedKeys.length > 0
  );
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [referenceUrl, setReferenceUrl] = useState(value.referenceUrl);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  // Ảnh minh họa AI - model Gemini lazy fetch khi user chạm select "Model vẽ"
  const { providers } = useProviders();
  const gemini = providers?.find((p) => p.id === "gemini");
  // providers chưa về → chưa kết luận được, không nháy cảnh báo
  const geminiConnected = providers ? (gemini?.connected ?? false) : true;
  const {
    models: liveIllustrationModels,
    loading: illustrationModelsLoading,
    load: loadIllustrationModels,
  } = useGeminiImageModels();
  // Chưa fetch live → tạm dùng danh sách tĩnh từ /api/providers
  const illustrationModelOptions = liveIllustrationModels ?? gemini?.models ?? [];
  // Model đã lưu không (chưa) nằm trong danh sách → vẫn hiển thị bằng id thô
  const illustrationModelMissing =
    value.illustrationModel !== null &&
    !illustrationModelOptions.some((m) => m.id === value.illustrationModel);

  useEffect(() => {
    getSkills()
      .then(setSkills)
      .catch(() => setSkills([]));
    getPrompts()
      .then(setPrompts)
      .catch(() => setPrompts([]));
  }, []);

  // Brief nạp về sau khi mount (fetch xong) mà đã có key chỉ định sẵn → mở chế độ
  // "Tự chỉ định" để user thấy được. Không set false ở chiều ngược lại: xóa hết key
  // trong lúc đang nhập không được phép hất user về chế độ AI.
  useEffect(() => {
    if (value.mainKey.trim() !== "" || value.relatedKeys.length > 0) {
      setKeyManual(true);
    }
  }, [value.mainKey, value.relatedKeys]);

  function set<K extends keyof Brief>(key: K, v: Brief[K]) {
    onChange({ [key]: v } as Partial<Brief>);
  }

  function applyReference(next: Brief) {
    onChange({
      referenceName: next.referenceName,
      referenceUrl: next.referenceUrl,
      referenceContent: next.referenceContent,
    });
    setReferenceUrl(next.referenceUrl);
  }

  async function onReferenceFile(file: File | undefined) {
    if (!projectId || !file) return;
    setReferenceBusy(true);
    setReferenceError(null);
    try {
      applyReference(await uploadBriefReference(projectId, file));
    } catch (e) {
      setReferenceError(e instanceof Error ? e.message : String(e));
    } finally {
      setReferenceBusy(false);
    }
  }

  async function onReferenceLink() {
    if (!projectId || !referenceUrl.trim()) return;
    setReferenceBusy(true);
    setReferenceError(null);
    try {
      applyReference(await importBriefGoogleSheet(projectId, referenceUrl.trim()));
    } catch (e) {
      setReferenceError(e instanceof Error ? e.message : String(e));
    } finally {
      setReferenceBusy(false);
    }
  }

  /** Đổ content của prompt mẫu vào ô "Yêu cầu edit" - confirm nếu sắp ghi đè. */
  function applyPrompt(id: string) {
    const p = prompts.find((x) => x.id === id);
    if (!p) return;
    if (value.notes.trim() && value.notes !== p.content) {
      const ok = window.confirm(
        tf("brief.apply-prompt-confirm", { name: p.name })
      );
      if (!ok) return;
    }
    set("notes", p.content);
  }

  // Đã có keyword chỉ định sẵn → luôn hiện danh sách, không cần bấm link mở
  const keywordsOpen = showKeywords || value.highlightKeywords.length > 0;

  return (
    <fieldset
      disabled={disabled}
      className={`flex flex-col gap-4 ${disabled ? "opacity-60" : ""}`}
    >
      {/* 1. Mô tả video gốc */}
      {showSource && (
        <Field
          label={t("brief.source-label")}
          htmlFor="brief-source"
          hint={t("brief.source-hint")}
        >
          <textarea
            id="brief-source"
            className="input"
            rows={3}
            value={value.sourceDescription}
            onChange={(e) => set("sourceDescription", e.target.value)}
            placeholder={t("brief.source-placeholder")}
          />
        </Field>
      )}

      {/* 2. Yêu cầu edit (prompt) - nội dung chính gửi AI */}
      <Field
        label={t("brief.notes-label")}
        htmlFor="brief-notes"
        hint={t("brief.notes-hint")}
      >
        <div className="mb-2 flex items-center gap-2">
          <select
            className="input flex-1"
            value=""
            onChange={(e) => applyPrompt(e.target.value)}
            aria-label={t("brief.use-prompt-aria")}
          >
            <option value="" disabled>
              {prompts.length > 0
                ? t("brief.use-prompt")
                : t("brief.no-prompts")}
            </option>
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Link href="/prompts" className={`${LINK_BTN} shrink-0`}>
            <ScrollText size={14} strokeWidth={2} />
            {t("brief.manage-prompts")}
          </Link>
        </div>
        <textarea
          id="brief-notes"
          className="input"
          rows={6}
          value={value.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder={t("brief.notes-placeholder")}
        />
      </Field>

      {projectId && (
        <Panel title="AI phân tích kịch bản quay dựng">
          <p className="text-sm text-[var(--text-muted)]">
            Nhập Word, Excel hoặc Google Sheets. AI sẽ đối chiếu tài liệu với mô tả video gốc và yêu cầu edit trước khi lập cảnh.
          </p>
          <div className="flex flex-wrap gap-2">
            <label className="btn btn-secondary btn-sm cursor-pointer">
              {referenceBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              Chọn tệp Word/Excel
              <input
                type="file"
                className="hidden"
                accept=".docx,.xlsx,.csv,.txt"
                disabled={referenceBusy}
                onChange={(e) => {
                  void onReferenceFile(e.target.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Link Google Sheets" htmlFor="brief-reference-url" className="min-w-[240px] flex-1">
              <input
                id="brief-reference-url"
                className="input"
                value={referenceUrl}
                onChange={(e) => setReferenceUrl(e.target.value)}
              />
            </Field>
            <Button variant="secondary" small disabled={referenceBusy || !referenceUrl.trim()} onClick={onReferenceLink}>
              <Link2 size={14} /> Phân tích link
            </Button>
          </div>
          {referenceError && <Banner tone="danger" message={referenceError} />}
          {value.referenceContent && (
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-sm font-medium">
                  <FileSpreadsheet size={15} /> {value.referenceName || "Tài liệu tham chiếu"}
                </span>
                <Button
                  variant="destructive"
                  small
                  disabled={referenceBusy}
                  onClick={async () => {
                    if (!projectId) return;
                    setReferenceBusy(true);
                    try { applyReference(await deleteBriefReference(projectId)); }
                    catch (e) { setReferenceError(e instanceof Error ? e.message : String(e)); }
                    finally { setReferenceBusy(false); }
                  }}
                >
                  <Trash2 size={13} /> Bỏ tài liệu
                </Button>
              </div>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-meta text-[var(--text-muted)]">
                {value.referenceContent}
              </p>
            </div>
          )}
          <p className="text-meta text-[var(--text-muted)]">
            Google Sheets cần bật “Bất kỳ ai có đường liên kết đều có thể xem”. Dữ liệu được lưu trong project local.
          </p>
        </Panel>
      )}

      {/* 3. Các toggle tính năng - MỘT hộp <Panel>, mỗi tính năng một hàng
          <SwitchField>. Vùng bung ra khi bật chỉ thụt lề, không kẻ thêm viền. */}
      <Panel className="gap-4">
        <SwitchField
          id="brief-autocut"
          checked={value.autoCut}
          onChange={(v) => set("autoCut", v)}
          label={t("brief.autocut-label")}
          hint={t("brief.autocut-hint")}
        />
        {/* Mức mạnh tay - chỉ hiện khi toggle BẬT (autoCut vẫn là công tắc duy nhất) */}
        {value.autoCut && (
          <div className={SUBFIELDS}>
            <Field label={t("brief.autocut-level")}>
              <div
                className="flex flex-col gap-2"
                role="radiogroup"
                aria-label={t("brief.autocut-level")}
              >
                {AUTO_CUT_LEVELS.map((level) => (
                  <label
                    key={level}
                    className="flex cursor-pointer items-start gap-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="brief-autocut-level"
                      className="mt-0.5 accent-[var(--primary)]"
                      checked={value.autoCutLevel === level}
                      onChange={() => set("autoCutLevel", level)}
                    />
                    <span>
                      {t(AUTO_CUT_LEVEL_LABEL[level])}
                      {level === "default" && (
                        <span className="ml-1 text-meta font-normal text-[var(--text-muted)]">
                          {t("brief.autocut-level-recommended")}
                        </span>
                      )}
                      <span className="block text-meta font-normal text-[var(--text-muted)]">
                        {t(AUTO_CUT_LEVEL_HINT[level])}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          </div>
        )}
        <SwitchField
          id="brief-subtitles"
          checked={value.subtitles}
          onChange={(v) => set("subtitles", v)}
          label={t("brief.subtitles-label")}
          hint={t("brief.subtitles-hint")}
        />
        <SwitchField
          id="brief-highlight"
          checked={value.highlightEnabled}
          onChange={(v) => set("highlightEnabled", v)}
          label={t("brief.highlight")}
          hint={t("brief.highlight-hint")}
        />
        {/* Nâng cao: chỉ định thêm keyword - chỉ hiện khi toggle BẬT.
            Chip + ô gõ + Enter chính là <TagInput>, không dựng lại lần hai. */}
        {value.highlightEnabled && (
          <div className={SUBFIELDS}>
            {!keywordsOpen ? (
              <button
                type="button"
                className={LINK_BTN}
                onClick={() => setShowKeywords(true)}
              >
                <Plus size={14} strokeWidth={2} />
                {t("brief.add-keywords")}
              </button>
            ) : (
              <Field label={t("brief.keywords-label")} htmlFor="brief-keyword">
                <TagInput
                  id="brief-keyword"
                  tags={value.highlightKeywords}
                  onChange={(tags) => set("highlightKeywords", tags)}
                  placeholder={t("brief.keyword-placeholder")}
                />
              </Field>
            )}
          </div>
        )}
        <SwitchField
          id="brief-key-layout"
          checked={value.keyLayoutEnabled}
          onChange={(v) => set("keyLayoutEnabled", v)}
          label={t("brief.key-layout-label")}
          hint={t("brief.key-layout-hint")}
        />
        {/* Chế độ chọn key - chỉ hiện khi toggle BẬT */}
        {value.keyLayoutEnabled && (
          <div className={SUBFIELDS}>
            <Segmented
              className="self-start"
              label={t("brief.key-mode-aria")}
              value={keyManual ? "manual" : "auto"}
              options={[
                { value: "auto", label: t("brief.key-auto") },
                { value: "manual", label: t("brief.key-manual") },
              ]}
              onChange={(next) => {
                const manual = next === "manual";
                setKeyManual(manual);
                if (!manual) {
                  // Về chế độ AI: xóa key đã chỉ định để AI toàn quyền đề xuất
                  onChange({ mainKey: "", relatedKeys: [] });
                }
              }}
            />
            {!keyManual ? (
              <p className="text-meta text-[var(--text-muted)]">
                {t("brief.key-auto-desc")}
              </p>
            ) : (
              <>
                <Field
                  label={t("brief.main-key")}
                  htmlFor="brief-main-key"
                  hint={t("brief.main-key-hint")}
                >
                  <input
                    id="brief-main-key"
                    className="input"
                    value={value.mainKey}
                    onChange={(e) => set("mainKey", e.target.value)}
                    placeholder={t("brief.main-key-placeholder")}
                  />
                </Field>
                <Field
                  label={t("brief.related-keys")}
                  htmlFor="brief-related-keys"
                  hint={t("brief.related-keys-hint")}
                >
                  <TagInput
                    id="brief-related-keys"
                    tags={value.relatedKeys}
                    onChange={(tags) => set("relatedKeys", tags)}
                    placeholder={t("brief.related-keys-placeholder")}
                  />
                </Field>
              </>
            )}
          </div>
        )}
        <SwitchField
          id="brief-illustrations"
          checked={value.autoIllustrations}
          onChange={(v) => set("autoIllustrations", v)}
          label={t("brief.illustrations-label")}
          hint={t("brief.illustrations-hint")}
        />
        {/* Chọn model vẽ - chỉ hiện khi toggle BẬT */}
        {value.autoIllustrations && (
          <div className={SUBFIELDS}>
            <Field
              label={t("brief.illustration-model")}
              htmlFor="brief-illustration-model"
              hint={
                illustrationModelsLoading ? (
                  <span className="flex items-center gap-1">
                    <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                    {t("images.loading-models")}
                  </span>
                ) : undefined
              }
            >
              <select
                id="brief-illustration-model"
                className="input"
                value={value.illustrationModel ?? ""}
                onFocus={loadIllustrationModels}
                onChange={(e) =>
                  set("illustrationModel", e.target.value || null)
                }
              >
                <option value="">{t("images.model-default")}</option>
                {illustrationModelMissing && (
                  <option value={value.illustrationModel!}>
                    {value.illustrationModel}
                  </option>
                )}
                {illustrationModelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            {/* Mật độ ảnh - số ảnh Gemini mỗi phút video; null = AI tự quyết */}
            <Field
              label={t("brief.illustration-density")}
              htmlFor="brief-illustration-density"
              hint={t("brief.illustration-density-hint")}
            >
              <div className="flex items-center gap-2">
                <input
                  id="brief-illustration-density"
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  className="input w-24"
                  // Ô trống = null = AI tự quyết; gõ số là chốt mật độ cứng
                  value={value.illustrationsPerMinute ?? ""}
                  placeholder={t("brief.illustration-density-auto-short")}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) {
                      set("illustrationsPerMinute", null);
                      return;
                    }
                    const n = Math.round(Number(raw));
                    if (Number.isFinite(n)) {
                      set("illustrationsPerMinute", Math.min(20, Math.max(1, n)));
                    }
                  }}
                />
                <span className="text-sm text-[var(--text-muted)]">
                  {t("brief.illustration-density-unit")}
                </span>
              </div>
            </Field>
            {/* Vị trí chủ thể ảnh - lưới 3x3 như bộ chọn vị trí logo, chọn bằng mắt */}
            <Field
              label={t("brief.illustration-position")}
              hint={
                value.illustrationPosition === "auto"
                  ? t("brief.illustration-position-auto-hint")
                  : t("brief.illustration-position-hint")
              }
            >
              <TextPositionPicker
                value={value.illustrationPosition}
                onChange={(pos) => set("illustrationPosition", pos)}
              />
            </Field>
            <CheckboxField
              id="brief-illustration-text"
              checked={value.illustrationText}
              onChange={(v) => set("illustrationText", v)}
              label={t("brief.illustration-text")}
              hint={t("brief.illustration-text-hint")}
            />
            {!geminiConnected && (
              <p className="flex items-start gap-2 text-sm font-medium text-[var(--danger)]">
                <AlertTriangle
                  size={14}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0"
                />
                {t("brief.gemini-warning")}
              </p>
            )}
          </div>
        )}
      </Panel>

      {/* 4. Style Design - NGAY TRÊN Skill, sản phẩm cưỡng chế theo style */}
      {showStyle && (
        <Field
          label="Style Design"
          htmlFor="brief-style"
          hint={t("brief.style-hint")}
        >
          <StyleSelect
            id="brief-style"
            value={value.styleId}
            onChange={(v) => set("styleId", v)}
          />
        </Field>
      )}

      {/* 4b. Phong cách dựng - đặt NGAY DƯỚI Style Design vì hai thứ hay bị lẫn:
          Style Design = màu/font/logo thương hiệu, cái này = chất liệu hình ảnh.
          Đứng cạnh nhau thì người dùng đọc một lượt là phân biệt được.

          Là một CÔNG TẮC như mọi tính năng khác trong form: tắt (mặc định) thì
          video dựng theo đúng cấu hình đã chọn, danh sách 20 phong cách không
          chiếm chỗ; bật mới hiện ra để chọn. */}
      <Panel className="gap-4">
        <SwitchField
          id="brief-video-style"
          checked={value.videoStyleEnabled}
          onChange={(v) => set("videoStyleEnabled", v)}
          label={t("vstyle.label")}
          hint={
            value.videoStyleEnabled ? t("vstyle.hint") : t("vstyle.off-hint")
          }
        />
        {value.videoStyleEnabled && (
          <div className={SUBFIELDS}>
            <VideoStyleSelect
              value={value.videoStyleId}
              onChange={(v) => set("videoStyleId", v)}
            />
          </div>
        )}
      </Panel>

      {/* 5. Skill */}
      <Field
        label={t("brief.skill-label")}
        htmlFor="brief-skill"
        hint={t("brief.skill-hint")}
      >
        <select
          id="brief-skill"
          className="input"
          value={value.skill ?? ""}
          onChange={(e) => set("skill", e.target.value || null)}
        >
          <option value="">{t("brief.ai-pick-skill")}</option>
          {/* Skill đã lưu nhưng không (còn) trong danh sách (đã xóa/đổi tên) →
              vẫn hiện bằng tên thô thay vì select trắng trơn giữ giá trị ẩn -
              cùng cách xử lý với styleId (StyleSelect) và illustrationModel */}
          {value.skill !== null && !skills.some((s) => s.name === value.skill) && (
            <option value={value.skill}>{value.skill}</option>
          )}
          {skills.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
              {s.description
                ? ` - ${s.description.length > 60 ? `${s.description.slice(0, 60)}…` : s.description}`
                : ""}
            </option>
          ))}
        </select>
      </Field>

      {/* 6. Sound effect */}
      <Field label="Sound effect" hint={t("brief.sfx-hint")}>
        <div
          className="flex flex-col gap-2"
          role="radiogroup"
          aria-label="Sound effect"
        >
          {(Object.keys(SFX_MODE_LABEL) as SfxMode[]).map((mode) => (
            <label
              key={mode}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="brief-sfx-mode"
                className="accent-[var(--primary)]"
                checked={value.sfxMode === mode}
                onChange={() => set("sfxMode", mode)}
              />
              {t(SFX_MODE_LABEL[mode])}
            </label>
          ))}
        </div>
      </Field>

      {/* 7. Nhạc nền - thư viện assets/music/, AI duck tự động khi có thoại */}
      <Field label={t("brief.music-label")} hint={t("brief.music-hint")}>
        <div
          className="flex flex-col gap-2"
          role="radiogroup"
          aria-label={t("brief.music-label")}
        >
          {(Object.keys(MUSIC_MODE_LABEL) as MusicMode[]).map((mode) => (
            <label
              key={mode}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="brief-music-mode"
                className="accent-[var(--primary)]"
                checked={value.musicMode === mode}
                onChange={() => set("musicMode", mode)}
              />
              {t(MUSIC_MODE_LABEL[mode])}
            </label>
          ))}
        </div>
      </Field>
    </fieldset>
  );
}
