"use client";

/**
 * Trang Cấu hình - tăng tốc phần cứng + cài đặt render: worker Chrome
 * (HyperFrames), GPU cho capture/encode, concurrency Remotion + queue, draft fps.
 * Mỗi thay đổi PUT ngay (auto-save) - server đọc settings mỗi lần job chạy
 * và mỗi tick của queue nên hiệu lực NGAY, không cần restart.
 */

import { Check, Image as ImageIcon, RotateCcw, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getRenderSettings,
  getProductSettings,
  updateProductSettings,
  uploadProductLogo,
  type ProductSettings,
  updateRenderSettings,
  type HardwareInfo,
  type RenderRecommended,
  type RenderSettings,
  type RenderSettingsResponse,
  type UpdateChannel,
} from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field, SwitchField } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Segmented } from "@/components/Segmented";
import { Skeleton } from "@/components/Skeleton";
import { SystemCheckCard } from "@/components/SystemCheckCard";
import { useT } from "@/lib/i18n";

const PLATFORM_LABELS: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

/**
 * value dùng chung cho các nhóm nút: number hoặc null (draft fps "Giữ nguyên"),
 * hoặc chuỗi cho các lựa chọn dạng enum (kênh cập nhật).
 */
type SegValue = number | string | null;

interface SegOption<V extends SegValue = number | null> {
  value: V;
  label: string;
  /** Mốc khuyên dùng theo máy thật - hiển thị suffix ★. */
  recommended?: boolean;
}

/** Các mốc worker/concurrency chuẩn - chỉ giữ mốc ≤ số luồng CPU của máy. */
const WORKER_STEPS = [2, 4, 6, 8, 12, 16, 24];

/** Sinh option ĐỘNG theo máy: Auto + mốc chuẩn ≤ maxWorkers (+ chính maxWorkers). */
function buildWorkerOptions(rec: RenderRecommended, recommendedValue: number): SegOption[] {
  const values = WORKER_STEPS.filter((v) => v <= rec.maxWorkers);
  if (!values.includes(rec.maxWorkers)) {
    values.push(rec.maxWorkers);
    values.sort((a, b) => a - b);
  }
  return [
    { value: 0, label: "Auto" },
    ...values.map((v) => ({
      value: v,
      label: String(v),
      recommended: v === recommendedValue,
    })),
  ];
}

/** Fallback khi server cũ chưa trả recommended - giữ hành vi như trước. */
const RECOMMENDED_FALLBACK: RenderRecommended = {
  workers: 8,
  concurrency: 8,
  maxWorkers: 12,
};

const QUEUE_OPTIONS: SegOption[] = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
];

// label "config.keep" là KEY dictionary - SegGroup dịch bằng t() lúc render.
const DRAFT_FPS_OPTIONS: SegOption[] = [
  { value: null, label: "config.keep" },
  { value: 15, label: "15 fps" },
  { value: 24, label: "24 fps" },
];

/** Kênh cập nhật - "stable" là mặc định nên gắn luôn dấu ★ khuyên dùng. */
const UPDATE_CHANNEL_OPTIONS: SegOption<UpdateChannel>[] = [
  { value: "stable", label: "update.channel-stable", recommended: true },
  { value: "latest", label: "update.channel-latest" },
];

/**
 * Hai thiết lập chi phí của phiên AI dựng video - mốc phải khớp
 * AI_ATTEMPT_OPTIONS / AI_TURN_OPTIONS trong apps/server/src/renderSettings.ts
 * (server còn kẹp lại 1..12 và 20..300 nên chọn ngoài mốc cũng không hỏng).
 *
 * ★ đánh vào ĐÚNG giá trị mặc định của server: 4 lần chạy lại và trần 300 lượt.
 */
const AI_ATTEMPT_OPTIONS: SegOption[] = [1, 2, 3, 4, 6, 8, 12].map((v) => ({
  value: v,
  label: String(v),
  recommended: v === 4,
}));

const AI_TURN_OPTIONS: SegOption[] = [50, 100, 150, 200, 300].map((v) => ({
  value: v,
  label: String(v),
  recommended: v === 300,
}));

/**
 * Nhóm nút chọn một giá trị. Ruột là <Segmented> dùng chung - trang này trước
 * đây tự chế một biến thể riêng (viền + nền primary-soft) trong khi mọi nhóm
 * chọn-một khác của dashboard lại là một hình dạng khác.
 *
 * Giá trị thật có thể là number hoặc null, còn <Segmented> chỉ nhận chuỗi -
 * nên khóa hiển thị là String(value), chọn xong tra ngược về option gốc.
 */
function SegGroup<V extends SegValue>({
  options,
  value,
  onSelect,
  ariaLabel,
}: {
  options: SegOption<V>[];
  value: V;
  onSelect: (v: V) => void;
  ariaLabel: string;
}) {
  const { t } = useT();
  return (
    <Segmented
      label={ariaLabel}
      value={String(value)}
      onChange={(next) => {
        const found = options.find((o) => String(o.value) === next);
        if (found) onSelect(found.value);
      }}
      options={options.map((o) => ({
        value: String(o.value),
        title: o.recommended ? t("config.recommended-title") : undefined,
        label: (
          <>
            {t(o.label)}
            {o.recommended && (
              <span
                aria-label={t("config.recommended-aria")}
                className="ml-1 align-top text-xs"
              >
                ★
              </span>
            )}
          </>
        ),
      }))}
    />
  );
}

/** Một hàng thiết lập - nhịp dọc chung của cả card (khớp trang Kết nối). */
function Row({ children }: { children: React.ReactNode }) {
  return <div className="py-4 first:pt-0 last:pb-0">{children}</div>;
}

/** Card phần cứng - 3 khối CPU / RAM / GPU (tên + dòng chi tiết) + badges. */
function HardwareCard({ hw }: { hw: HardwareInfo }) {
  const { t } = useT();
  // CPU: "6 cores · 12 threads · up to 4.1 GHz" - phần nào không tra được thì bỏ
  const cpuDetail = [
    hw.cpuCores ? `${hw.cpuCores} cores` : `${hw.cpuThreads} cores`,
    hw.cpuCores ? `${hw.cpuThreads} threads` : null,
    hw.cpuMaxGhz ? `up to ${hw.cpuMaxGhz} GHz` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Tên CPU thường tự chứa "@ x.xGHz" ở cuối - cắt cho gọn (đã có "up to" ở dòng chi tiết)
  const cpuName = hw.cpuModel.replace(/\s*CPU\s*@.*$/i, "").replace(/\s*@.*$/, "").trim();

  const blocks = [
    {
      label: "CPU",
      name: cpuName || t("config.not-detected"),
      detail: cpuDetail,
    },
    {
      label: "RAM",
      name: `${hw.ramGb} GB${hw.ramType ? ` ${hw.ramType}` : ""}`,
      detail: hw.ramSpeedMhz ? `${hw.ramSpeedMhz} MHz` : "",
    },
    {
      label: "GPU",
      name: hw.gpuName || t("config.not-detected"),
      detail:
        [
          hw.gpuVramGb ? `${hw.gpuVramGb} GB` : null,
          hw.nvenc ? "NVENC" : null,
          hw.videotoolbox ? "VideoToolbox" : null,
        ]
          .filter(Boolean)
          .join(" · ") || (hw.gpuName ? t("config.no-gpu-encode") : ""),
    },
  ];
  const cpuOnly = !hw.nvenc && !hw.videotoolbox;
  return (
    <Card
      title={t("config.hardware")}
      hint={{
        titleKey: "help.config-hardware.title",
        bodyKey: "help.config-hardware.body",
      }}
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
        {blocks.map((b) => (
          <div key={b.label} className="min-w-0">
            <p className="t-eyebrow">{b.label}</p>
            <p className="mt-1 truncate text-sm font-semibold" title={b.name}>
              {b.name}
            </p>
            {b.detail && (
              <p className="text-meta text-[var(--text-muted)]">{b.detail}</p>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        <span className="text-meta text-[var(--text-muted)]">
          {t("config.os")} {PLATFORM_LABELS[hw.platform] ?? hw.platform}
        </span>
        <span className="grow" />
        {/* Nhãn PHÂN LOẠI khả năng của máy, không phải trạng thái đang chạy -
            nên không có chấm tròn. */}
        {hw.nvenc && (
          <Badge tone="success" dot={false} label={t("config.nvenc-badge")} />
        )}
        {hw.videotoolbox && (
          <Badge
            tone="success"
            dot={false}
            label="VideoToolbox + Fast Capture (macOS)"
          />
        )}
        {cpuOnly && (
          <Badge tone="muted" dot={false} label={t("config.cpu-only")} />
        )}
      </div>
      <p className="mt-3 text-meta text-[var(--text-muted)]">
        {t("config.portable-note")}
      </p>
    </Card>
  );
}

const APPLIED_NOTICE_MS = 2500;

function ProductIdentityCard() {
  const [value, setValue] = useState<ProductSettings | null>(null);
  const [draft, setDraft] = useState({ appName: "", source: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getProductSettings()
      .then((settings) => {
        setValue(settings);
        setDraft({ appName: settings.appName, source: settings.source });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const settings = await updateProductSettings(draft);
      setValue(settings);
      setDraft({ appName: settings.appName, source: settings.source });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file: File | null) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      setValue(await uploadProductLogo(file));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Thông tin và logo ứng dụng">
      {error && <ErrorBanner message="Không lưu được thông tin ứng dụng" detail={error} />}
      <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)]">
        <div className="flex min-h-28 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--bg-subtle)] p-3">
          {value?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.logoUrl} alt={value.appName} className="max-h-24 max-w-full object-contain" />
          ) : (
            <ImageIcon size={28} strokeWidth={1.5} className="text-[var(--text-muted)]" />
          )}
        </div>
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tên ứng dụng" htmlFor="product-name">
              <input
                id="product-name"
                className="input"
                value={draft.appName}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, appName: e.target.value }))}
              />
            </Field>
            <Field label="Dòng nguồn/tác giả" htmlFor="product-source">
              <input
                id="product-source"
                className="input"
                value={draft.source}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, source: e.target.value }))}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn btn-secondary cursor-pointer">
              <Upload size={14} strokeWidth={2} />
              Đổi logo
              <input
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                disabled={busy}
                onChange={(e) => void uploadLogo(e.target.files?.[0] ?? null)}
              />
            </label>
            <Button onClick={save} disabled={busy || !draft.appName.trim() || !draft.source.trim()}>
              <Check size={14} strokeWidth={2} />
              {busy ? "Đang lưu…" : "Lưu thông tin"}
            </Button>
            {saved && <span className="text-meta font-medium text-[var(--success)]">Đã lưu · tải lại trang để áp dụng header</span>}
          </div>
          <p className="text-meta text-[var(--text-muted)]">
            Thông tin và logo nằm trong dữ liệu local, không được đưa vào ZIP phát hành.
          </p>
        </div>
      </div>
    </Card>
  );
}

export default function ConfigPage() {
  const { t, tf } = useT();
  const [data, setData] = useState<RenderSettingsResponse | null>(null);
  const dataRef = useRef<RenderSettingsResponse | null>(null);
  dataRef.current = data;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const appliedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    getRenderSettings()
      .then((res) => {
        if (!alive) return;
        setData(res);
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      if (appliedTimer.current) clearTimeout(appliedTimer.current);
    };
  }, []);

  const flashApplied = useCallback(() => {
    setApplied(true);
    if (appliedTimer.current) clearTimeout(appliedTimer.current);
    appliedTimer.current = setTimeout(
      () => setApplied(false),
      APPLIED_NOTICE_MS
    );
  }, []);

  /**
   * Cập nhật lạc quan + PUT ngay; lỗi thì rollback về settings trước đó.
   * Fetch nằm NGOÀI state updater - updater phải thuần (StrictMode chạy 2 lần
   * → fetch trong updater là double-fire PUT).
   */
  const apply = useCallback(
    (patch: Partial<RenderSettings>) => {
      const d = dataRef.current;
      if (!d) return;
      const prev = d.settings;
      setSaveError(null);
      setData({ ...d, settings: { ...prev, ...patch } });
      updateRenderSettings(patch)
        .then((res) => {
          setData((cur) => (cur ? { ...cur, settings: res.settings } : cur));
          flashApplied();
        })
        .catch((e) => {
          setData((cur) => (cur ? { ...cur, settings: prev } : cur));
          setSaveError(e instanceof Error ? e.message : String(e));
        });
    },
    [flashApplied]
  );

  const settings = data?.settings ?? null;
  const hw = data?.hardware ?? null;
  /** Khuyến nghị theo máy thật - fallback giữ mốc cũ nếu server chưa trả. */
  const rec = data?.recommended ?? RECOMMENDED_FALLBACK;
  const workerOptions = buildWorkerOptions(rec, rec.workers);
  const remotionOptions = buildWorkerOptions(rec, rec.concurrency);
  const workerHint = hw
    ? tf("config.worker-hint", {
        threads: hw.cpuThreads,
        ram: hw.ramGb,
        n: rec.workers,
      })
    : tf("config.recommend-n", { n: rec.workers });
  /** Máy không có encoder GPU nào → 2 toggle encode GPU bị khóa. */
  const gpuEncodeUnavailable = hw ? !hw.nvenc && !hw.videotoolbox : false;
  const gpuEncodeNote = t("config.gpu-note");

  /** Gợi ý của toggle encode GPU: câu mô tả + (khi bị khóa) lý do khóa. */
  const encodeHint = (text: string, danger = false) => (
    <>
      <span className={danger ? "text-[var(--danger)]" : ""}>{text}</span>
      {gpuEncodeUnavailable && (
        <span className="mt-1 block font-medium">{gpuEncodeNote}</span>
      )}
    </>
  );

  return (
    <div className="flex w-full flex-col gap-4">
      <PageHeader
        title={t("nav.config")}
        hint={{ titleKey: "help.config.title", bodyKey: "help.config.body" }}
        subtitle={t("config.subtitle")}
      />

      {loadError && (
        <ErrorBanner
          message={t("config.load-error")}
          detail={loadError}
        />
      )}
      {saveError && (
        <ErrorBanner message={t("config.save-error")} detail={saveError} />
      )}

      <ProductIdentityCard />

      {/* Đặt TRÊN CÙNG: thiếu ffmpeg/Chrome thì mọi cài đặt phía dưới đều vô nghĩa */}
      <SystemCheckCard />

      {hw && <HardwareCard hw={hw} />}

      {settings && data && (
        <Card
          title={t("config.render-settings")}
          hint={{
            titleKey: "help.config-render.title",
            bodyKey: "help.config-render.body",
          }}
          actions={
            <div className="flex items-center gap-3">
              {applied && (
                <span className="inline-flex items-center gap-2 text-meta font-medium text-[var(--success)]">
                  <Check size={13} strokeWidth={2} className="shrink-0" />
                  {t("config.applied")}
                </span>
              )}
              <Button
                variant="secondary"
                small
                onClick={() => apply({ ...data.defaults })}
              >
                <RotateCcw size={13} strokeWidth={2} />
                {t("config.restore-defaults")}
              </Button>
            </div>
          }
        >
          {/* CẢ CARD CHIA HAI CỘT, kể cả hàng chọn số luồng trên cùng.
              1. Hai nhóm "worker Chrome" và "Remotion concurrency" nói về cùng
                 một thứ - chạy bao nhiêu việc song song - nên đứng CẠNH NHAU
                 thành một hàng để so sánh, thay vì mỗi cái một hàng trải hết
                 bề ngang rồi đẩy mọi thứ khác tụt xuống.
                 Chúng có 8-9 mốc nút; ở nửa card thì `.seg` tự xuống hàng
                 (flex-wrap trong globals.css) thành hai hàng nút gọn, không
                 tràn ra ngoài card.
              2. Phần còn lại chia theo CHIỀU CAO chứ không theo số hàng. Bản
                 trước đếm "4 hàng mỗi bên" rồi vẫn so le gần 170px, vì một hàng
                 công tắc chỉ cao 2 dòng còn một hàng Field + Segmented cao 3-4
                 dòng. Giờ chia theo hình dạng hàng: TRÁI là toàn bộ công tắc
                 bật/tắt, PHẢI là toàn bộ ô chọn giá trị.
              Cắt cột bằng container query chứ không phải media query: bề rộng
              thật của card phụ thuộc rail trái đang gấp hay mở, không phụ
              thuộc bề rộng cửa sổ. */}
          <div className="@container">
            <div className="divide-y divide-[var(--border)]">
              <div className="grid gap-x-6 pb-4 @3xl:grid-cols-2">
                <Field label={t("config.workers")} hint={workerHint}>
                  <SegGroup
                    ariaLabel={t("config.workers-aria")}
                    options={workerOptions}
                    value={settings.workers}
                    onSelect={(v) => apply({ workers: v ?? 0 })}
                  />
                </Field>

                {/* Lúc xếp chồng (card hẹp) thì tự mọc nét kẻ ngăn với ô trên;
                    lúc đủ hai cột thì bỏ đi, vì đã có khoảng cách cột tách rồi. */}
                <div className="mt-4 border-t border-[var(--border)] pt-4 @3xl:mt-0 @3xl:border-t-0 @3xl:pt-0">
                  <Field
                    label="Remotion concurrency"
                    hint={tf("config.remotion-hint", { n: rec.concurrency })}
                  >
                    <SegGroup
                      ariaLabel="Remotion concurrency"
                      options={remotionOptions}
                      value={settings.remotionConcurrency}
                      onSelect={(v) => apply({ remotionConcurrency: v ?? 0 })}
                    />
                  </Field>
                </div>
              </div>

              {/* Nét kẻ nằm TRONG từng cột (mỗi cột một `divide-y` riêng), không
                  kẻ một đường dài vắt ngang qua cả hai - hai cột là hai mạch
                  đọc riêng. Xếp chồng lúc hẹp thì cột dưới tự mọc nét kẻ trên. */}
              <div className="grid gap-x-6 pt-4 @3xl:grid-cols-2">
                <div className="divide-y divide-[var(--border)] pb-4 @3xl:pb-0">
                  <Row>
                    <SwitchField
                      id="acc-browser-gpu"
                      label={t("config.browser-gpu")}
                      hint={t("config.browser-gpu-hint")}
                      checked={settings.browserGpu}
                      onChange={(v) => apply({ browserGpu: v })}
                    />
                  </Row>

                  <Row>
                    <SwitchField
                      id="acc-gpu-draft"
                      label={t("config.gpu-draft")}
                      hint={encodeHint(t("config.gpu-draft-hint"))}
                      checked={settings.gpuEncodeDraft}
                      disabled={gpuEncodeUnavailable}
                      onChange={(v) => apply({ gpuEncodeDraft: v })}
                    />
                  </Row>

                  <Row>
                    <SwitchField
                      id="acc-gpu-final"
                      label={t("config.gpu-final")}
                      hint={encodeHint(t("config.gpu-final-hint"), true)}
                      checked={settings.gpuEncodeFinal}
                      disabled={gpuEncodeUnavailable}
                      onChange={(v) => apply({ gpuEncodeFinal: v })}
                    />
                  </Row>

                  <Row>
                    <SwitchField
                      id="acc-fast-capture"
                      label="Fast capture (macOS)"
                      hint={t("config.fast-capture-hint")}
                      checked={settings.fastCapture}
                      onChange={(v) => apply({ fastCapture: v })}
                    />
                  </Row>

                  {/* Cổng QC - server mặc định BẬT; server cũ chưa có field này
                      thì vẫn coi như bật để UI không hiện sai trạng thái an toàn */}
                  <Row>
                    <SwitchField
                      id="acc-qc-gate"
                      label={t("qc.gate-label")}
                      hint={t("qc.gate-hint")}
                      checked={settings.qcGate !== false}
                      onChange={(v) => apply({ qcGate: v })}
                    />
                  </Row>
                </div>

                <div className="divide-y divide-[var(--border)] border-t border-[var(--border)] pt-4 @3xl:border-t-0 @3xl:pt-0">
                  <Row>
                    <Field
                      label={t("config.queue-concurrency")}
                      hint={t("config.queue-hint")}
                    >
                      <SegGroup
                        ariaLabel={t("config.queue-aria")}
                        options={QUEUE_OPTIONS}
                        value={settings.queueConcurrency}
                        onSelect={(v) => apply({ queueConcurrency: v ?? 1 })}
                      />
                    </Field>
                  </Row>

                  <Row>
                    <Field label="Draft fps" hint={t("config.draft-fps-hint")}>
                      <SegGroup
                        ariaLabel={t("config.draft-fps-aria")}
                        options={DRAFT_FPS_OPTIONS}
                        value={settings.draftFps}
                        onSelect={(v) => apply({ draftFps: v })}
                      />
                    </Field>
                  </Row>

                  {/* Kênh cập nhật - server mặc định "stable"; server cũ chưa
                      trả field này thì vẫn hiện "stable" cho khớp hành vi thật */}
                  <Row>
                    <Field
                      label={t("config.update-channel")}
                      hint={t("config.update-channel-hint")}
                    >
                      <SegGroup
                        ariaLabel={t("config.update-channel-aria")}
                        options={UPDATE_CHANNEL_OPTIONS}
                        value={settings.updateChannel ?? "stable"}
                        onSelect={(v) => apply({ updateChannel: v })}
                      />
                    </Field>
                  </Row>

                  {/* Hai ô dưới đây là hai cái van CHI PHÍ của phiên AI dựng
                      video, không phải thiết lập tốc độ render. Đặt sau cùng
                      trong cột chọn-giá-trị vì chúng đắt tiền nhất khi đặt sai:
                      chạy lại nhiều lần và trần lượt cao là hai thứ đã làm bốn
                      phiên nuốt 34% tổng chi phí của cả dự án.
                      Server cũ chưa có field này → rơi về đúng mặc định của
                      server (4 / 300) để UI không hiện một mức không có thật. */}
                  <Row>
                    <Field
                      label={t("config.ai-max-attempts")}
                      hint={t("config.ai-max-attempts-hint")}
                      hintKeys={{
                        titleKey: "help.config-ai-attempts.title",
                        bodyKey: "help.config-ai-attempts.body",
                      }}
                    >
                      <SegGroup
                        ariaLabel={t("config.ai-max-attempts-aria")}
                        options={AI_ATTEMPT_OPTIONS}
                        value={settings.aiMaxAttempts ?? 4}
                        onSelect={(v) => apply({ aiMaxAttempts: v ?? 4 })}
                      />
                    </Field>
                  </Row>

                  <Row>
                    <Field
                      label={t("config.ai-max-turns")}
                      hint={t("config.ai-max-turns-hint")}
                      hintKeys={{
                        titleKey: "help.config-ai-turns.title",
                        bodyKey: "help.config-ai-turns.body",
                      }}
                    >
                      <SegGroup
                        ariaLabel={t("config.ai-max-turns-aria")}
                        options={AI_TURN_OPTIONS}
                        value={settings.aiMaxTurns ?? 300}
                        onSelect={(v) => apply({ aiMaxTurns: v ?? 300 })}
                      />
                    </Field>
                  </Row>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {!data && !loadError && (
        // Skeleton trong lúc chờ GET /api/render-settings
        <>
          <Skeleton className="w-full" height={140} />
          <Skeleton className="w-full" height={360} />
        </>
      )}
    </div>
  );
}
