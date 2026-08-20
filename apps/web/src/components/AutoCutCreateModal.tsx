"use client";

/**
 * Modal "Cắt video mới" - gom cả 4 bước (nguồn / cách cắt / đầu ra / tùy chọn)
 * vào MỘT form: người dùng nhìn thấy toàn bộ lựa chọn cùng lúc, không phải bấm
 * qua nhiều bước wizard cho một thao tác chỉ mất 30 giây.
 *
 * Bấm nút cuối = POST tạo phiên rồi POST /plan luôn - phiên "draft" không có
 * giá trị gì với người dùng, họ tạo là để hệ thống đọc video ngay.
 */

import { ChevronDown, ChevronRight, Loader2, Scissors, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTO_CUT_DEFAULT_PARAMS,
  createAutoCut,
  getAutoCutSources,
  planAutoCut,
  uploadAsset,
  type AutoCutAspect,
  type AutoCutBackground,
  type AutoCutLayout,
  type AutoCutMode,
  type AutoCutParams,
  type Brief,
  type FileInfo,
} from "@/lib/api";
import { useUploadEvents } from "@/lib/useEvents";
import { Button } from "@/components/Button";
import { CheckboxField, Field } from "@/components/Field";
import { ErrorBanner } from "@/components/ErrorBanner";
import { InfoHint } from "@/components/InfoHint";
import { Modal } from "@/components/Modal";
import { OptionCard, OptionCardGroup } from "@/components/OptionCard";
import { Panel } from "@/components/Panel";
import { ProgressBar } from "@/components/ProgressBar";
import { StyleSelect } from "@/components/StyleSelect";
import {
  BriefFields,
  DEFAULT_BRIEF,
  MUSIC_MODE_LABEL,
  SFX_MODE_LABEL,
} from "@/components/BriefFields";
import {
  BACKGROUND_DESC,
  BACKGROUND_LABEL,
  LAYOUT_DESC,
  LAYOUT_LABEL,
  MODE_DESC,
  MODE_LABEL,
  aspectSize,
  clock,
} from "@/components/AutoCutCommon";
import { formatBytes } from "@/lib/format";
import { useT } from "@/lib/i18n";

const MODES: AutoCutMode[] = ["time", "ai", "prompt"];
const ASPECTS: AutoCutAspect[] = ["keep", "9:16", "16:9", "1:1", "4:5"];
const LAYOUTS: AutoCutLayout[] = ["auto", "crop", "fit"];
const BACKGROUNDS: AutoCutBackground[] = ["gemini", "blur", "style"];

/**
 * Brief gửi lên khi tạo phiên. Bỏ `styleId` vì style của phiên đã lấy từ
 * output.styleId (ô Style Design phía trên) - gửi thêm chỉ gây hiểu nhầm là có
 * hai chỗ chọn style.
 */
function briefPayload(brief: Brief): Partial<Brief> {
  const payload: Partial<Brief> = { ...brief };
  delete payload.styleId;
  return payload;
}

/**
 * Ô nhập số nhỏ - dùng cho phút/giây/số đoạn.
 * Chỉ còn là <Field> + <input type="number">: nhãn, cỡ chữ và chỗ đặt gợi ý do
 * primitive quyết định, ở đây chỉ chọn bề rộng.
 */
function NumField({
  id,
  label,
  value,
  min,
  disabled,
  onChange,
  width = "w-28",
}: {
  id: string;
  label: string;
  value: string;
  min: number;
  disabled?: boolean;
  onChange: (v: string) => void;
  width?: string;
}) {
  return (
    <Field label={label} htmlFor={id} className={width}>
      <input
        id={id}
        className="input"
        type="number"
        min={min}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function AutoCutCreateModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Gọi khi phiên đã tạo xong - trang cha điều hướng sang chi tiết. */
  onCreated: (sessionId: string) => void;
}) {
  const { t, tf } = useT();

  // ---- Nguồn ----
  const [sources, setSources] = useState<FileInfo[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [sourceRel, setSourceRel] = useState("");
  const [name, setName] = useState("");

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ---- Cách cắt ----
  const [mode, setMode] = useState<AutoCutMode>("time");
  const [minutes, setMinutes] = useState(String(AUTO_CUT_DEFAULT_PARAMS.minutes));
  const [overlapSec, setOverlapSec] = useState(
    String(AUTO_CUT_DEFAULT_PARAMS.overlapSec)
  );
  const [count, setCount] = useState(String(AUTO_CUT_DEFAULT_PARAMS.count));
  const [minSec, setMinSec] = useState(String(AUTO_CUT_DEFAULT_PARAMS.minSec));
  const [maxSec, setMaxSec] = useState(String(AUTO_CUT_DEFAULT_PARAMS.maxSec));
  const [request, setRequest] = useState("");

  // ---- Đầu ra ----
  const [aspect, setAspect] = useState<AutoCutAspect>("9:16");
  const [layout, setLayout] = useState<AutoCutLayout>("auto");
  const [background, setBackground] = useState<AutoCutBackground>("gemini");
  const [styleId, setStyleId] = useState<string | null>(null);

  // ---- Tùy chọn ----
  const [transcribe, setTranscribe] = useState(true);
  const [autoEdit, setAutoEdit] = useState(false);
  // Kịch bản edit áp cho MỌI video cắt ra - modal đã dài nên mặc định thu gọn
  const [brief, setBrief] = useState<Brief>(DEFAULT_BRIEF);
  const [briefOpen, setBriefOpen] = useState(false);

  // ---- Gửi ----
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Phiên đã tạo nhưng bước /plan lỗi (vd 409 BUSY) - cho người dùng mở phiên
  // chứ không tạo thêm phiên trùng.
  const [createdId, setCreatedId] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    try {
      setSources(await getAutoCutSources());
      setSourcesError(null);
    } catch (e) {
      setSourcesError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Mỗi lần mở modal: nạp lại danh sách nguồn (user vừa copy file vào imports/)
  useEffect(() => {
    if (open) loadSources();
  }, [open, loadSources]);

  // Tiến trình server nhận file - upload vào imports/ không kèm projectId
  useUploadEvents((e) => {
    if (!uploading || e.projectId) return;
    if (e.done) {
      setUploadPct(null);
      return;
    }
    const total = e.total ?? 0;
    setUploadPct(
      total > 0 ? Math.round(((e.received ?? 0) / total) * 100) : null
    );
  });

  async function onPickFile(list: FileList | null) {
    const file = list?.[0];
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    setUploadPct(0);
    try {
      const info = await uploadAsset(file, "imports");
      await loadSources();
      // Tự chọn file vừa tải - người dùng không phải đi tìm lại trong danh sách
      setSourceRel(info.relPath);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      setUploadPct(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // mode ai/prompt phải đọc được lời thoại mới chọn được đoạn → ép bật transcribe
  const transcribeLocked = mode === "ai" || mode === "prompt";
  useEffect(() => {
    if (transcribeLocked) setTranscribe(true);
  }, [transcribeLocked]);

  const requestMissing = mode === "prompt" && request.trim().length === 0;
  const canCreate = sourceRel !== "" && !requestMissing && !uploading;

  function buildParams(): AutoCutParams {
    if (mode === "time") {
      return {
        minutes: Number(minutes) || AUTO_CUT_DEFAULT_PARAMS.minutes,
        overlapSec: Number(overlapSec) || 0,
      };
    }
    const common = {
      count: Number(count) || AUTO_CUT_DEFAULT_PARAMS.count,
      minSec: Number(minSec) || AUTO_CUT_DEFAULT_PARAMS.minSec,
      maxSec: Number(maxSec) || AUTO_CUT_DEFAULT_PARAMS.maxSec,
    };
    return mode === "prompt"
      ? { ...common, request: request.trim() }
      : common;
  }

  async function onCreate() {
    if (!canCreate || creating) return;
    setCreating(true);
    setCreateError(null);
    let sessionId = createdId;
    try {
      if (!sessionId) {
        const session = await createAutoCut({
          ...(name.trim() ? { name: name.trim() } : {}),
          sourceRel,
          mode,
          params: buildParams(),
          output: { aspect, layout, background, styleId },
          transcribe,
          autoEdit,
          brief: briefPayload(brief),
        });
        sessionId = session.id;
        setCreatedId(sessionId);
      }
      // Tạo xong là phân tích luôn - đó mới là thứ người dùng chờ
      await planAutoCut(sessionId);
      onCreated(sessionId);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const selectedSource = sources?.find((f) => f.relPath === sourceRel) ?? null;
  // aspect "keep" giữ nguyên khung nguồn nên không có bước đổi khung
  const reframing = aspect !== "keep";
  // crop cắt cúp bám nhân vật, không có vùng trống nào để lấp nền
  const needBackground = reframing && layout !== "crop";

  // Một dòng cho biết kịch bản edit đang đặt gì - đủ để không cần mở khối ra xem
  const yesNo = (v: boolean) => (v ? t("common.yes") : t("common.no"));
  const briefSummary = [
    `${t("brief.subtitles")}: ${yesNo(brief.subtitles)}`,
    `${t("brief.key-layout")}: ${yesNo(brief.keyLayoutEnabled)}`,
    `Sound effect: ${t(SFX_MODE_LABEL[brief.sfxMode])}`,
    `${t("brief.music-label")}: ${t(MUSIC_MODE_LABEL[brief.musicMode])}`,
  ].join(" · ");

  // Dấu X và nút Hủy đi CHUNG một đường - đang tạo phiên thì cả hai cùng bị chặn
  function close() {
    if (!creating) onClose();
  }

  return (
    // KHÔNG `wide`: đây là biểu mẫu MỘT CỘT (nguồn → cách cắt → đầu ra → tùy
    // chọn), đọc từ trên xuống. Kéo rộng ra 960px chỉ làm mỗi dòng dài thượt.
    <Modal
      title={t("autocut.create-title")}
      open={open}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" disabled={creating} onClick={close}>
            {t("common.cancel")}
          </Button>
          {createdId && createError ? (
            <Button onClick={() => onCreated(createdId)}>
              {t("autocut.open-session")}
            </Button>
          ) : null}
          <Button disabled={!canCreate || creating} onClick={onCreate}>
            {creating ? (
              <Loader2 size={15} strokeWidth={2} className="animate-spin" />
            ) : (
              <Scissors size={15} strokeWidth={2} />
            )}
            {creating ? t("autocut.creating") : t("autocut.create")}
          </Button>
        </>
      }
    >
      {createError && (
        <ErrorBanner
          message={
            createdId ? t("autocut.plan-error-created") : t("autocut.create-error")
          }
          detail={createError}
        />
      )}

      {/* ---- 1. Nguồn ---- */}
      <Panel title={t("autocut.source")}>
        {sourcesError && (
          <ErrorBanner message={t("autocut.sources-error")} detail={sourcesError} />
        )}
        <div className="flex flex-wrap items-end gap-2">
          <select
            className="input min-w-[240px] flex-1"
            aria-label={t("autocut.source")}
            value={sourceRel}
            disabled={creating}
            onChange={(e) => setSourceRel(e.target.value)}
          >
            <option value="">
              {sources && sources.length === 0
                ? t("autocut.source-none")
                : t("autocut.source-pick")}
            </option>
            {(sources ?? []).map((f) => (
              <option key={f.relPath} value={f.relPath}>
                {f.name} - {formatBytes(f.size)}
              </option>
            ))}
          </select>
          <input
            ref={fileInput}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => onPickFile(e.target.files)}
          />
          <Button
            variant="secondary"
            disabled={uploading || creating}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? (
              <Loader2 size={15} strokeWidth={2} className="animate-spin" />
            ) : (
              <Upload size={15} strokeWidth={2} />
            )}
            {uploading ? t("autocut.uploading") : t("autocut.upload")}
          </Button>
        </div>
        {uploading &&
          (uploadPct === null ? (
            <div className="progress-indeterminate" />
          ) : (
            <ProgressBar progress={uploadPct} />
          ))}
        {uploadError && (
          <ErrorBanner message={t("autocut.upload-error")} detail={uploadError} />
        )}
        {/* Đường dẫn + dung lượng = phụ chú đi kèm lựa chọn ở trên */}
        {selectedSource && (
          <p className="text-meta text-[var(--text-muted)]">
            {selectedSource.relPath} · {formatBytes(selectedSource.size)}
          </p>
        )}
      </Panel>

      <Field label={t("autocut.name")} htmlFor="autocut-name">
        <input
          id="autocut-name"
          className="input"
          value={name}
          disabled={creating}
          placeholder={t("autocut.name-placeholder")}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      {/* ---- 2. Cách cắt ---- */}
      <Panel
        title={t("autocut.how")}
        actions={
          <InfoHint
            titleKey="help.autocut-mode.title"
            bodyKey="help.autocut-mode.body"
          />
        }
      >
        <OptionCardGroup label={t("autocut.how")}>
          {MODES.map((m) => (
            <OptionCard
              key={m}
              selected={mode === m}
              disabled={creating}
              title={t(MODE_LABEL[m])}
              description={t(MODE_DESC[m])}
              onSelect={() => setMode(m)}
            />
          ))}
        </OptionCardGroup>

        {mode === "time" ? (
          <div className="flex flex-wrap items-start gap-2">
            <NumField
              id="autocut-minutes"
              label={t("autocut.minutes")}
              value={minutes}
              min={1}
              disabled={creating}
              onChange={setMinutes}
            />
            <NumField
              id="autocut-overlap"
              label={t("autocut.overlap")}
              value={overlapSec}
              min={0}
              disabled={creating}
              onChange={setOverlapSec}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {mode === "prompt" && (
              <Field
                label={t("autocut.request")}
                htmlFor="autocut-request"
                error={requestMissing ? t("autocut.request-required") : null}
              >
                <textarea
                  id="autocut-request"
                  className="input"
                  rows={2}
                  value={request}
                  disabled={creating}
                  placeholder={t("autocut.request-placeholder")}
                  onChange={(e) => setRequest(e.target.value)}
                />
              </Field>
            )}
            <div className="flex flex-wrap items-start gap-2">
              <NumField
                id="autocut-count"
                label={t("autocut.count")}
                value={count}
                min={1}
                disabled={creating}
                onChange={setCount}
                width="w-24"
              />
              <NumField
                id="autocut-min-sec"
                label={t("autocut.min-sec")}
                value={minSec}
                min={5}
                disabled={creating}
                onChange={setMinSec}
              />
              <NumField
                id="autocut-max-sec"
                label={t("autocut.max-sec")}
                value={maxSec}
                min={6}
                disabled={creating}
                onChange={setMaxSec}
              />
            </div>
          </div>
        )}
      </Panel>

      {/* ---- 3. Đầu ra ---- */}
      <Panel
        title={t("autocut.aspect")}
        actions={
          <InfoHint
            titleKey="help.autocut-aspect.title"
            bodyKey="help.autocut-aspect.body"
          />
        }
      >
        {/* Tỉ lệ khung hình cũng là <OptionCard> - trước đây nó là bản viết lại
            LẦN THỨ HAI của thẻ lựa chọn ngay trong chính file đã tự định nghĩa
            một thẻ lựa chọn khác. Kích thước pixel đóng vai mô tả. */}
        <OptionCardGroup
          label={t("autocut.aspect")}
          className="grid-cols-[repeat(auto-fit,minmax(120px,1fr))]"
        >
          {ASPECTS.map((a) => {
            const size = aspectSize(a);
            return (
              <OptionCard
                key={a}
                selected={aspect === a}
                disabled={creating}
                title={a === "keep" ? t("autocut.aspect.keep") : a}
                description={
                  size
                    ? `${size.width}x${size.height}`
                    : t("autocut.aspect.keep-size")
                }
                onSelect={() => setAspect(a)}
              />
            );
          })}
        </OptionCardGroup>
        {!reframing && (
          <p className="text-sm text-[var(--text-muted)]">
            {t("autocut.keep-note")}
          </p>
        )}
      </Panel>

      {reframing && (
        <>
          <Panel
            title={t("autocut.layout")}
            actions={
              <InfoHint
                titleKey="help.autocut-layout.title"
                bodyKey="help.autocut-layout.body"
              />
            }
          >
            <OptionCardGroup label={t("autocut.layout")}>
              {LAYOUTS.map((l) => (
                <OptionCard
                  key={l}
                  selected={layout === l}
                  disabled={creating}
                  title={t(LAYOUT_LABEL[l])}
                  description={t(LAYOUT_DESC[l])}
                  onSelect={() => setLayout(l)}
                />
              ))}
            </OptionCardGroup>
          </Panel>

          {needBackground && (
            <Panel
              title={t("autocut.background")}
              actions={
                <InfoHint
                  titleKey="help.autocut-background.title"
                  bodyKey="help.autocut-background.body"
                />
              }
            >
              <OptionCardGroup label={t("autocut.background")}>
                {BACKGROUNDS.map((b) => (
                  <OptionCard
                    key={b}
                    selected={background === b}
                    disabled={creating}
                    title={t(BACKGROUND_LABEL[b])}
                    description={t(BACKGROUND_DESC[b])}
                    onSelect={() => setBackground(b)}
                  />
                ))}
              </OptionCardGroup>
              {/* htmlFor + id BẮT BUỘC đi cùng nhau: <Field> chỉ render <label>
                  khi có htmlFor (không thì ra <span>), mà bản cũ dựa vào việc
                  bọc control trong <label> để có nhãn ngầm. Bỏ cả hai là còn
                  đúng một combobox không tên cho trình đọc màn hình. */}
              <Field label={t("autocut.style")} htmlFor="autocut-style">
                <StyleSelect
                  id="autocut-style"
                  value={styleId}
                  disabled={creating}
                  onChange={setStyleId}
                />
              </Field>
            </Panel>
          )}
        </>
      )}

      {/* ---- 4. Tùy chọn ---- */}
      <Panel title={t("autocut.options")}>
        {/* <CheckboxField> lo cả nhãn, gợi ý và nút (i) - nút (i) là ANH EM của
            nhãn chứ không nằm trong <label>, nếu không bấm (i) sẽ tick nhầm ô */}
        <CheckboxField
          id="autocut-transcribe"
          label={t("autocut.transcribe")}
          hint={
            transcribeLocked
              ? t("autocut.transcribe-locked")
              : t("autocut.transcribe-hint")
          }
          hintKeys={{
            titleKey: "help.autocut-transcribe.title",
            bodyKey: "help.autocut-transcribe.body",
          }}
          checked={transcribe}
          disabled={transcribeLocked || creating}
          onChange={setTranscribe}
        />
        <CheckboxField
          id="autocut-auto-edit"
          label={t("autocut.auto-edit")}
          hint={t("autocut.auto-edit-hint")}
          hintKeys={{
            titleKey: "help.autocut-autoedit.title",
            bodyKey: "help.autocut-autoedit.body",
          }}
          checked={autoEdit}
          disabled={creating}
          onChange={setAutoEdit}
        />
      </Panel>

      {/* Kịch bản edit dùng chung cho cả phiên - cấu hình một lần, mọi video
          cắt ra edit được ngay, khỏi vào từng project chỉnh lại */}
      {/* CỐ Ý không phải <Panel>: bên trong là <BriefFields>, mà component đó
          đã tự dựng một <Panel> cho cụm công tắc. Lồng Panel trong Panel là ba
          tầng viền trong modal - đúng thứ Panel.tsx cấm. Ở đây chỉ cần một
          đường viền để gom phần gấp/mở, KHÔNG tô nền --bg-subtle, nhờ vậy hộp
          bên trong vẫn nổi lên rõ ràng. */}
      <div className="flex min-w-0 flex-col rounded-[var(--radius)] border border-[var(--border)]">
        <button
          type="button"
          aria-expanded={briefOpen}
          onClick={() => setBriefOpen((v) => !v)}
          className="flex w-full items-start gap-2 rounded-[var(--radius)] p-3 text-left transition-colors duration-150 hover:bg-[var(--border)]"
        >
          {briefOpen ? (
            <ChevronDown
              size={15}
              strokeWidth={2}
              className="mt-1 shrink-0 text-[var(--text-muted)]"
            />
          ) : (
            <ChevronRight
              size={15}
              strokeWidth={2}
              className="mt-1 shrink-0 text-[var(--text-muted)]"
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              {t("autocut.brief-title")}
            </span>
            <span className="block truncate text-meta text-[var(--text-muted)]">
              {briefOpen ? t("autocut.brief-hint") : briefSummary}
            </span>
          </span>
        </button>
        {briefOpen && (
          <div className="border-t border-[var(--border)] p-3">
            <BriefFields
              value={brief}
              onChange={(p) => setBrief((b) => ({ ...b, ...p }))}
              // Style Design đã có ô riêng phía trên; mô tả từng đoạn do server tự viết
              show={{ styleId: false, sourceDescription: false }}
              disabled={creating}
            />
          </div>
        )}
      </div>

      {selectedSource?.relPath && mode === "time" && (
        <p className="text-meta text-[var(--text-muted)]">
          {tf("autocut.time-hint", { minutes: clock(Number(minutes) * 60 || 0) })}
        </p>
      )}
    </Modal>
  );
}
