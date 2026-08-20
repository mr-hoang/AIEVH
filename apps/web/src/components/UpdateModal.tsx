"use client";

/**
 * Popup cập nhật hệ thống - xác nhận, tiến trình 4 bước, kết quả.
 *
 * VÌ SAO phải poll thay vì SSE: script update chạy DETACHED và tự kill chính
 * server này, nên không có kết nối nào sống xuyên suốt để đẩy tiến trình.
 * Trình tự thật của script (update/update.ps1):
 *   1. pull    - server VẪN SỐNG  → poll GET /api/update/log, thấy tiến trình thật
 *   2. stop    - server CHẾT từ đây
 *   3. install - npm install, không gọi được API
 *   4. restart - build + bật lại, server sống lại
 * Nên: API bắt đầu fail = ĐÃ SANG BƯỚC TẮT MÁY (bình thường, không phải lỗi),
 * chuyển sang chờ /api/health sống lại, rồi đọc log lần cuối để lấy kết quả
 * thật của cả quãng vừa tắt trước khi reload trang.
 */

import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Modal } from "@/components/Modal";
import { Panel } from "@/components/Panel";
import { StepperBar } from "@/components/PipelineTimeline";
import {
  ApiError,
  applyUpdate,
  checkUpdate,
  getUpdateLog,
  type UpdateStatus,
  type UpdateStep,
} from "@/lib/api";
import { useT } from "@/lib/i18n";

const STEPS: readonly UpdateStep[] = ["pull", "stop", "install", "restart"];
const STEP_LABEL: Record<UpdateStep, string> = {
  pull: "update.step.pull",
  stop: "update.step.stop",
  install: "update.step.install",
  restart: "update.step.restart",
};
/** Nhãn cho <StepperBar> - nó nhận KEY từ điển và tự dịch lúc render. */
const STEP_KEYS: readonly string[] = STEPS.map((s) => STEP_LABEL[s]);

const POLL_MS = 2_000; // nhịp poll log / health
const LOG_TAIL = 200; // đủ để thấy đuôi bước pull
const FINAL_TAIL = 400; // sau khi sống lại: lấy rộng hơn để có cả phần install
/** Server còn sống mà quá lâu chưa thấy tắt → script có thể chết âm thầm. */
const ALIVE_TIMEOUT_MS = 4 * 60 * 1000;
/** Server đã tắt mà quá lâu chưa sống lại → npm install/build hỏng. */
const DOWN_TIMEOUT_MS = 10 * 60 * 1000;
const RELOAD_DELAY_MS = 2_500;

type Phase = "confirm" | "running" | "done" | "failed";
type FailReason = "script" | "timeout";

/**
 * Lấy phần log THUỘC LẦN CHẠY NÀY.
 * VÌ SAO: start/update.log là file cộng dồn (Start-Transcript -Append) nên lần
 * nào cũng có sẵn output của những lần trước - không lọc thì UI hiện log cũ và
 * suy ra sai bước đang chạy. Neo bằng dòng cuối cùng của log CŨ, không so theo
 * độ dài vì API chỉ trả ĐUÔI log (tail) - log dài ra thì dòng đầu bị đẩy đi.
 */
function newLinesSince(baseline: string[] | null, lines: string[]): string[] {
  if (!baseline || baseline.length === 0) return lines;
  let anchor = "";
  for (let i = baseline.length - 1; i >= 0; i--) {
    if (baseline[i].trim() !== "") {
      anchor = baseline[i];
      break;
    }
  }
  if (!anchor) return lines;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === anchor) return lines.slice(i + 1);
  }
  // Không tìm thấy mốc cũ (log đã trôi hết khỏi tail) → coi tất cả là mới
  return lines;
}

/** Bước gần nhất suy từ mốc `[STEP] <tên>` script ghi vào log. */
function stepFromLines(lines: string[]): UpdateStep | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].split("[STEP] ")[1]?.trim();
    if (raw && (STEPS as readonly string[]).includes(raw)) {
      return raw as UpdateStep;
    }
  }
  return null;
}

/** mm:ss cho đồng hồ đếm thời gian đã trôi. */
function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function UpdateModal({
  open,
  status,
  checking = false,
  onClose,
  onRecheck,
}: {
  open: boolean;
  /** Trạng thái check mới nhất do UpdateBadge sở hữu (null = chưa check được). */
  status: UpdateStatus | null;
  /** Badge đang gọi check - khóa nút "Kiểm tra lại". */
  checking?: boolean;
  onClose: () => void;
  /** Bắt badge check lại (force) - dùng ở nút "Kiểm tra lại". */
  onRecheck: () => void;
}) {
  const { t, tf } = useT();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [starting, setStarting] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [serverDown, setServerDown] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failReason, setFailReason] = useState<FailReason>("timeout");
  const [newHash, setNewHash] = useState<string | null>(null);
  /** Phiên bản (tag release) sau khi cập nhật - null khi kho chưa có tag. */
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const baselineRef = useRef<string[] | null>(null);
  const startRef = useRef(0);
  const mountedRef = useRef(true);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Mở lại popup sau khi đã đóng → về trạng thái xác nhận sạch sẽ.
  // (Không reset khi đang chạy: lúc đó popup không cho đóng.)
  useEffect(() => {
    if (!open) return;
    setPhase((p) => (p === "running" ? p : "confirm"));
    setApplyError(null);
    setShowLog(false);
  }, [open]);

  // Log tự cuộn xuống dòng mới nhất - người dùng thấy hệ thống đang làm gì
  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  // Đồng hồ đếm thời gian đã trôi (quan trọng ở giai đoạn server tắt: không có
  // log nào chạy, đồng hồ là bằng chứng duy nhất cho thấy UI vẫn đang theo dõi)
  useEffect(() => {
    if (phase !== "running") return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1_000);
    return () => clearInterval(timer);
  }, [phase]);

  /** Server đã sống lại: đọc log lần cuối + lấy hash mới rồi báo thành công. */
  const finish = useCallback(async () => {
    setServerDown(false);
    setStepIdx(STEPS.length - 1);
    try {
      const log = await getUpdateLog(FINAL_TAIL);
      if (!mountedRef.current) return;
      setLines(newLinesSince(baselineRef.current, log.lines));
    } catch {
      // Không đọc được log cuối - vẫn coi là xong vì server đã sống lại
    }
    if (!mountedRef.current) return;
    setPhase("done");
    try {
      const s = await checkUpdate();
      if (mountedRef.current) {
        setNewHash(s.current || null);
        setNewVersion(s.currentVersion);
      }
    } catch {
      // Không lấy được hash/phiên bản mới - không ảnh hưởng kết quả
    }
  }, []);

  // Vòng poll chính: log khi server còn sống → health khi server đã tắt
  useEffect(() => {
    if (phase !== "running") return;
    let alive = true;
    let sawDown = false;
    let downAt = 0;
    let curStep = 0;
    const startedAt = Date.now();

    const tick = async () => {
      if (!alive) return;

      if (!sawDown) {
        try {
          const log = await getUpdateLog(LOG_TAIL);
          if (!alive) return;
          const fresh = newLinesSince(baselineRef.current, log.lines);
          setLines(fresh);
          // Ưu tiên bước suy từ dòng MỚI; chỉ tin `step` của server khi không
          // chụp được log cũ (không có mốc để lọc log của lần chạy trước).
          const detected =
            stepFromLines(fresh) ??
            (baselineRef.current === null ? log.step : null);
          const idx = detected ? STEPS.indexOf(detected) : -1;
          if (idx > curStep) {
            curStep = idx;
            setStepIdx(idx);
          }
          // Script tự ghi "[LOI]" rồi thoát - bắt ngay, khỏi bắt người dùng chờ
          if (fresh.some((l) => l.includes("[LOI]"))) {
            alive = false;
            setFailReason("script");
            setPhase("failed");
            return;
          }
          if (Date.now() - startedAt > ALIVE_TIMEOUT_MS) {
            alive = false;
            setFailReason("timeout");
            setPhase("failed");
          }
        } catch {
          if (!alive) return;
          // API chết = script đã kill server. ĐÂY LÀ BƯỚC BÌNH THƯỜNG.
          sawDown = true;
          downAt = Date.now();
          setServerDown(true);
          if (curStep < 1) {
            curStep = 1;
            setStepIdx(1);
          }
        }
        return;
      }

      // Giai đoạn server tắt: chờ sống lại. /api/health là endpoint public nên
      // fetch thẳng, không cần token - lỗi mạng = vẫn đang tắt.
      let up = false;
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        up = res.ok;
      } catch {
        up = false;
      }
      if (!alive) return;
      if (up) {
        alive = false;
        await finish();
        return;
      }
      if (Date.now() - downAt > DOWN_TIMEOUT_MS) {
        alive = false;
        setFailReason("timeout");
        setPhase("failed");
      }
    };

    const timer = setInterval(tick, POLL_MS);
    void tick();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, finish]);

  // Xong thì tự tải lại - code mới chỉ vào trang sau khi reload
  useEffect(() => {
    if (phase !== "done") return;
    const timer = setTimeout(() => location.reload(), RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  async function onApply() {
    setApplyError(null);
    setStarting(true);
    // Chụp log CŨ trước khi chạy để lọc ra đúng phần của lần này
    try {
      const before = await getUpdateLog(2000);
      baselineRef.current = before.exists ? before.lines : [];
    } catch {
      baselineRef.current = null;
    }
    try {
      await applyUpdate();
    } catch (err) {
      setStarting(false);
      if (err instanceof ApiError && err.code === "JOB_RUNNING") {
        setApplyError(t("update.job-running"));
      } else {
        setApplyError(
          err instanceof ApiError ? err.message : t("update.send-failed")
        );
      }
      return;
    }
    startRef.current = Date.now();
    setStarting(false);
    setLines([]);
    setStepIdx(0);
    setServerDown(false);
    setElapsed(0);
    setNewHash(null);
    setNewVersion(null);
    setPhase("running");
  }

  // Đang chạy: chặn đóng bằng nền/Escape/nút X (bấm nhầm giữa chừng rất tệ).
  // `dismissible={false}` ẩn luôn nút X - để nút hiện mà bấm không tác dụng
  // thì người dùng tưởng giao diện treo.
  const running = phase === "running";

  const title =
    phase === "running"
      ? t("update.running-title")
      : phase === "done"
        ? t("update.success-title")
        : phase === "failed"
          ? t("update.failed-title")
          : t("update.title");

  return (
    // `wide`: đây là modal duy nhất trong app thật sự cần bề ngang - stepper 4
    // bước, hộp log cuộn và danh sách commit đều là nội dung nằm ngang.
    <Modal
      wide
      open={open}
      title={title}
      onClose={onClose}
      dismissible={!running}
      footer={renderFooter()}
    >
      {phase === "confirm" && renderConfirm()}
      {running && renderRunning()}
      {phase === "done" && renderDone()}
      {phase === "failed" && renderFailed()}
    </Modal>
  );

  /**
   * Footer theo đúng luật chung: chỉ <Button> cỡ mặc định 36px, thứ tự
   * [phụ] … [chính]. Trước đợt đại tu chỗ này có 8 nút `btn btn-* btn-sm` chép
   * tay - vừa lệch cỡ với 5 modal còn lại, vừa là bản sao của <Button>.
   */
  function renderFooter() {
    if (running) return undefined; // không có lối thoát giữa chừng
    if (phase === "done") {
      return (
        <Button onClick={() => location.reload()}>
          {t("update.reload-now")}
        </Button>
      );
    }
    if (phase === "failed") {
      return (
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            onClick={() => {
              setPhase("confirm");
              onRecheck();
            }}
          >
            {t("update.check-now")}
          </Button>
        </>
      );
    }
    // Không có bản mới: popup chỉ còn việc cho kiểm tra lại
    if (!status || status.upToDate) {
      return (
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={onRecheck} disabled={checking}>
            {checking && (
              <Loader2 size={15} strokeWidth={2} className="animate-spin" />
            )}
            {t("update.check-now")}
          </Button>
        </>
      );
    }
    return (
      <>
        <Button variant="secondary" onClick={onClose}>
          {t("update.later")}
        </Button>
        <Button onClick={onApply} disabled={starting}>
          {starting && (
            <Loader2 size={15} strokeWidth={2} className="animate-spin" />
          )}
          {starting ? t("update.starting") : t("update.apply-now")}
        </Button>
      </>
    );
  }

  /**
   * Ghi chú về kênh cập nhật - chỉ hiện khi có chuyện cần nói:
   * kênh "latest" (bản chưa ổn định) hoặc kênh "stable" mà kho chưa có release
   * nào nên đành so với main. Kênh "stable" bình thường thì không nói gì.
   */
  function renderChannelNote() {
    const note =
      status?.channel === "latest"
        ? t("update.channel-latest-note")
        : status?.fellBackToMain
          ? t("update.no-releases-note")
          : null;
    if (!note) return null;
    return <Banner tone="muted" message={note} />;
  }

  function renderConfirm() {
    const commits = status?.commits ?? [];
    const latestHash = commits[0]?.hash ?? null;
    const rest = status ? Math.max(0, status.behind - commits.length) : 0;
    /**
     * Nói bằng PHIÊN BẢN khi có tag release; cài từ bản clone chưa có tag nào
     * thì rơi về short hash - tuyệt đối không để lọt chữ "null" ra giao diện.
     */
    const fromLabel = status?.currentVersion ?? status?.current ?? "";
    const toLabel =
      status?.latestVersion ??
      latestHash ??
      tf("update.behind", { n: status?.behind ?? 0 });

    // Không có bản mới (hoặc check hỏng): chỉ báo trạng thái, không có gì để chạy
    if (!status || status.upToDate) {
      return (
        <>
          {/* Lỗi ở ĐẦU thân modal - không nhét xuống dưới phần trạng thái */}
          {status?.error && (
            <ErrorBanner
              message={t("update.check-failed")}
              detail={status.error}
            />
          )}
          <Panel>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-[var(--text-muted)]">
                {t("update.current-label")}
              </span>
              <span className="font-mono">{fromLabel || "?"}</span>
              {status && !status.error && (
                <span className="inline-flex items-center gap-1 text-[var(--success)]">
                  <Check size={15} strokeWidth={3} />
                  {t("update.up-to-date")}
                </span>
              )}
            </div>
          </Panel>
          {renderChannelNote()}
        </>
      );
    }

    return (
      <>
        {applyError && <ErrorBanner message={applyError} />}

        {/* Hàng phiên bản: bản đang chạy -> bản sắp lên (v1.0.0 → v1.0.1) */}
        <Panel>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-[var(--text-muted)]">
              {t("update.current-label")}
            </span>
            <span className="font-mono">{fromLabel || "?"}</span>
            <ArrowRight
              size={15}
              strokeWidth={2}
              className="shrink-0 text-[var(--text-muted)]"
            />
            <span className="text-[var(--text-muted)]">
              {t("update.latest-label")}
            </span>
            <span className="font-mono font-semibold text-[var(--primary)]">
              {toLabel}
            </span>
            {(status?.latestVersion || latestHash) && (
              <span className="text-[var(--text-muted)]">
                ({tf("update.behind", { n: status?.behind ?? 0 })})
              </span>
            )}
          </div>
        </Panel>

        {renderChannelNote()}

        {/* Có gì mới - ghi chú phát hành là NỘI DUNG người dùng thật sự đọc
            trước khi quyết định cập nhật, nên ở bậc 14px chứ không phải 12px */}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">{t("update.whats-new")}</p>
          {commits.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              {status?.latestMessage || t("update.no-commits")}
            </p>
          ) : (
            <ul className="max-h-48 overflow-y-auto rounded-[var(--radius)] border border-[var(--border)]">
              {commits.map((c) => (
                <li
                  key={c.hash}
                  className="flex items-start gap-2 border-b border-[var(--border)] p-2 text-sm last:border-b-0"
                >
                  <span className="shrink-0 font-mono text-meta text-[var(--text-muted)]">
                    {c.hash}
                  </span>
                  <span className="min-w-0 break-words">{c.message}</span>
                </li>
              ))}
              {rest > 0 && (
                <li className="p-2 text-meta text-[var(--text-muted)]">
                  {tf("update.commits-more", { n: rest })}
                </li>
              )}
            </ul>
          )}
        </div>

        <p className="text-sm text-[var(--text-muted)]">
          {t("update.warn-restart")}
        </p>
      </>
    );
  }

  function renderRunning() {
    return (
      <>
        <StepperBar
          steps={STEP_KEYS}
          stage={stepIdx + 1}
          active
          done={false}
          // Vòng xoay chứ không phải chấm nhấp nháy: lúc cập nhật, server bị
          // tắt hẳn vài phút và log không ra dòng nào - vòng xoay là tín hiệu
          // "vẫn đang chạy, chưa treo" mạnh nhất còn lại trên màn hình.
          marker="spinner"
          // Modal hẹp: để nhãn bước xuống dòng thay vì bị cắt cụt.
          wrapLabels
          ariaLabel={t("update.running-title")}
        />
        <div
          className="progress-indeterminate"
          aria-label={t("update.running-title")}
        />
        {/* Số bước và đồng hồ là PHỤ CHÚ đi kèm thanh tiến trình → text-meta */}
        <div className="flex items-center justify-between gap-3 text-meta text-[var(--text-muted)]">
          <span className="truncate">
            {tf("update.step-of", { n: stepIdx + 1 })} ·{" "}
            {t(STEP_LABEL[STEPS[stepIdx]])}
          </span>
          <span className="shrink-0 font-mono">
            {tf("update.elapsed", { time: formatElapsed(elapsed) })}
          </span>
        </div>

        {/* Server tắt là ĐÚNG QUY TRÌNH - nói rõ để người dùng không hoảng */}
        {serverDown && (
          <div aria-live="polite">
            <Banner tone="muted" message={t("update.server-down")} />
          </div>
        )}

        <LogBox
          boxRef={logBoxRef}
          lines={lines}
          empty={t("update.waiting-log")}
        />
      </>
    );
  }

  function renderDone() {
    return (
      <>
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--success-bg)]">
            <Check size={20} strokeWidth={3} className="text-[var(--success)]" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t("update.success-title")}</p>
            <p className="text-sm text-[var(--text-muted)]">
              {/* Có tag release thì khoe phiên bản, không thì đành nói hash */}
              {newVersion
                ? `${tf("update.updated-to", { version: newVersion })} · ${t("update.reloading")}`
                : newHash
                  ? `${tf("update.new-version", { hash: newHash })} · ${t("update.reloading")}`
                  : t("update.reloading")}
            </p>
          </div>
        </div>
        <StepperBar
          steps={STEP_KEYS}
          stage={STEPS.length}
          active={false}
          done
          ariaLabel={t("update.success-title")}
        />
        {lines.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowLog((v) => !v)}
              aria-expanded={showLog}
              className="inline-flex items-center gap-1 self-start text-meta font-medium text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
            >
              {showLog ? (
                <ChevronDown size={13} strokeWidth={2} />
              ) : (
                <ChevronRight size={13} strokeWidth={2} />
              )}
              {showLog ? t("update.hide-log") : t("update.view-log")}
            </button>
            {showLog && <LogBox lines={lines} empty={t("update.log-title")} />}
          </>
        )}
      </>
    );
  }

  function renderFailed() {
    const message =
      failReason === "script"
        ? t("update.failed-script")
        : t("update.failed-timeout");
    // Bước pull chạy TRƯỚC khi tắt máy, nên hỏng ở đây = bản cũ còn nguyên
    const safe = !serverDown && stepIdx === 0;
    return (
      <>
        <ErrorBanner
          message={message}
          detail={lines.length > 0 ? lines.join("\n") : undefined}
        />
        {safe && (
          <p className="text-sm text-[var(--text-muted)]">
            {t("update.failed-safe")}
          </p>
        )}
        <p className="text-sm text-[var(--text-muted)]">
          {t("update.log-hint")}
        </p>
        <LogBox lines={lines} empty={t("update.waiting-log")} />
      </>
    );
  }
}

/**
 * Khối log mono, chiều cao cố định, cuộn dọc.
 *
 * Là <Panel> chứ không phải hộp chép tay, và chữ ở bậc `text-meta` chứ không
 * phải 11px tự chế - log vẫn là thứ người dùng phải ĐỌC ĐƯỢC khi có lỗi.
 * Padding nằm ở div bên trong (Panel bị `p-0`) để vùng cuộn ôm trọn hộp: đặt
 * padding ở khung ngoài thì dòng cuối cùng bị đệm che mất một nửa khi cuộn hết.
 */
function LogBox({
  lines,
  empty,
  boxRef,
}: {
  lines: string[];
  empty: string;
  boxRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <Panel className="p-0">
      <div ref={boxRef} className="h-40 overflow-y-auto p-3">
        {lines.length === 0 ? (
          <p className="font-mono text-meta text-[var(--text-muted)]">{empty}</p>
        ) : (
          <pre className="font-mono text-meta leading-relaxed whitespace-pre-wrap text-[var(--text-muted)]">
            {lines.join("\n")}
          </pre>
        )}
      </div>
    </Panel>
  );
}
