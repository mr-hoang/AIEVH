"use client";

/**
 * Trang Giọng đọc - nhân bản giọng chạy HOÀN TOÀN trên máy người dùng (VieNeu).
 *
 * Vì sao khối trạng thái engine đứng đầu trang: giọng offline phụ thuộc vào MÁY
 * (có Python chưa, có gói vieneu chưa, có PyTorch chưa). Người dùng chưa cài mà
 * nhìn thấy nút "Nhân bản giọng" bấm được thì bấm xong chỉ nhận về một lỗi -
 * nên trang phải nói ngay đang thiếu gì và chép sẵn lệnh cần chạy.
 *
 * Ba trạng thái tách bạch: nhân bản được / chỉ đọc được (thiếu PyTorch) / chưa
 * cài. Chỉ trạng thái đầu mới mở khóa form nhân bản và nút đọc thử.
 *
 * Cả trang dùng CHUNG một bộ phát: nghe mẫu gốc và đọc thử phải cắt tiếng nhau,
 * không bao giờ chồng lên nhau.
 *
 * Lỗi chỉ có HAI chỗ: lỗi của một ô nhập nằm trong `<Field error>` ngay dưới ô
 * sai, lỗi cấp thẻ/trang nằm trong `<Banner tone="danger">`. Trước đợt đại tu
 * trang này có ba kiểu chữ đỏ khác nhau cho cùng một việc.
 */

import {
  AlertTriangle,
  Check,
  Loader2,
  Mic,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLONE_REF_IDEAL_MAX_SEC,
  CLONE_REF_MAX_SEC,
  CLONE_REF_MIN_SEC,
  createClonedVoice,
  deleteClonedVoice,
  getClonedVoices,
  getTtsEngines,
  mediaUrl,
  previewClonedVoice,
  updateClonedVoice,
  type ClonedVoice,
  type TtsEngineStatus,
  type TtsGender,
} from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ConfirmDeleteModal } from "@/components/ConfirmDeleteModal";
import { CopyButton } from "@/components/CopyButton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/Panel";
import { Segmented } from "@/components/Segmented";
import { CardGridSkeleton } from "@/components/Skeleton";
import { formatDurationMs, formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";

/** Engine giọng offline - trang này chỉ nói về nó, Gemini là dịch vụ đám mây. */
const OFFLINE_ENGINE = "vieneu";

/** Lệnh cài đặt - chép nguyên văn dán vào PowerShell. */
const CMD_ENGINE = "pip install vieneu";
const CMD_TORCH = "pip install torch torchaudio";

const GENDERS: TtsGender[] = ["nam", "nu", "trung-tinh"];

const GENDER_LABEL_KEY: Record<TtsGender, string> = {
  nam: "ttv.voice.gender.male",
  nu: "ttv.voice.gender.female",
  "trung-tinh": "ttv.voice.gender.neutral",
};

/** Lưới thẻ giọng - ĐÚNG chuỗi ngưỡng của bốn trang lưới thẻ anh em (Prompts,
    Skills, Style Design, Phong cách dựng). Trang này từng xuống hàng ở những
    ngưỡng riêng, nên cùng một màn hình lại ra số cột khác các trang kia. */
const VOICE_GRID =
  "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

/** Trạng thái rút gọn của engine - quyết định toàn bộ những gì trang cho làm. */
type EngineState = "checking" | "ready" | "speech-only" | "missing";

function engineStateOf(status: TtsEngineStatus | null | undefined): EngineState {
  if (status === undefined) return "checking";
  if (!status || !status.available) return "missing";
  return status.canClone ? "ready" : "speech-only";
}

// ============ Bộ phát dùng chung ============

interface Player {
  /** Khóa của tiếng đang phát - null = im lặng. */
  playing: string | null;
  play: (key: string, src: string, opts?: { objectUrl?: boolean }) => void;
  stop: () => void;
}

/**
 * Mỗi lúc chỉ MỘT tiếng được phát trên cả trang: phát cái mới thì cái đang chạy
 * dừng ngay. Object URL (blob của bản đọc thử / clip vừa ghi) được thu hồi ngay
 * khi ngừng phát và khi rời trang - không để rò bộ nhớ.
 */
function usePlayer(): Player {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setPlaying(null);
  }, []);

  // Rời trang giữa lúc đang phát -> tắt tiếng, không để audio chạy mồ côi
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  const play = useCallback(
    (key: string, src: string, opts?: { objectUrl?: boolean }) => {
      stop();
      const audio = new Audio(src);
      audio.onended = () => stop();
      audio.onerror = () => stop();
      audioRef.current = audio;
      if (opts?.objectUrl) urlRef.current = src;
      setPlaying(key);
      audio.play().catch(() => stop());
    },
    [stop]
  );

  return { playing, play, stop };
}

// ============ Đo thời lượng clip ============

/**
 * Thời lượng THẬT của clip mẫu, đo ngay ở trình duyệt trước khi upload.
 *
 * Blob do MediaRecorder tạo thường thiếu metadata thời lượng nên `duration` ra
 * Infinity - phải tua tới một mốc rất xa để trình duyệt tính lại rồi mới đọc
 * được. File lạ codec / hỏng thì trả null: không treo form, cứ cho gửi và để
 * server đo lại bằng ffprobe.
 */
function readClipDuration(clip: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(clip);
    const audio = new Audio();
    let timer = 0;
    let done = false;
    const finish = (sec: number | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(sec !== null && Number.isFinite(sec) && sec > 0 ? sec : null);
    };
    timer = window.setTimeout(() => finish(null), 8000);
    audio.preload = "metadata";
    audio.onerror = () => finish(null);
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) {
        finish(audio.duration);
        return;
      }
      audio.ontimeupdate = () => {
        audio.ontimeupdate = null;
        finish(audio.duration);
      };
      audio.currentTime = 1e9;
    };
    audio.src = url;
  });
}

/** Đuôi file theo mimeType của MediaRecorder - server vẫn chuẩn hóa lại. */
function extForMime(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

// ============ Khối lệnh chép được ============

function CommandRow({ command }: { command: string }) {
  const { t } = useT();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 font-mono text-meta text-[var(--text)]">
        {command}
      </code>
      <CopyButton value={command} label={t("voices.copy")} size="sm" />
    </div>
  );
}

/** Một bước cài đặt - bước đã xong thì đánh dấu tick thay cho số thứ tự. */
function InstallStep({
  index,
  text,
  command,
  done = false,
}: {
  index: number;
  text: string;
  command?: string;
  done?: boolean;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          done
            ? "bg-[var(--success-bg)] text-[var(--success)]"
            : "bg-[var(--primary-soft)] text-[var(--primary)]"
        }`}
      >
        {done ? <Check size={12} strokeWidth={2.5} /> : index}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{text}</span>
        {command && <CommandRow command={command} />}
      </span>
    </li>
  );
}

// ============ Khối trạng thái engine ============

function EngineCard({
  status,
  state,
  checking,
  onRecheck,
}: {
  status: TtsEngineStatus | null;
  state: EngineState;
  checking: boolean;
  onRecheck: () => void;
}) {
  const { t } = useT();

  // Lý do server trả về là MÃ (NO_TORCH…) - dịch được thì dịch, không thì rơi
  // về câu chung, tuyệt đối không in mã trần ra màn hình
  const whyKey = status?.reason
    ? `ttv.voice.engine.why.${status.reason}`
    : null;
  const why = whyKey
    ? t(whyKey) === whyKey
      ? t("ttv.voice.engine.why.unknown")
      : t(whyKey)
    : null;

  const stateText =
    state === "ready"
      ? t("voices.engine-ok")
      : state === "speech-only"
        ? t("voices.engine-speech-only")
        : t("voices.engine-missing");

  return (
    <Card
      title={t("voices.engine-title")}
      actions={
        <Button
          variant="secondary"
          small
          disabled={checking}
          onClick={onRecheck}
        >
          {checking ? (
            <Loader2 size={13} strokeWidth={2} className="animate-spin" />
          ) : (
            <RotateCcw size={13} strokeWidth={2} />
          )}
          {checking ? t("voices.rechecking") : t("voices.recheck")}
        </Button>
      }
    >
      {state === "checking" ? (
        <span className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 size={14} strokeWidth={2} className="animate-spin" />
          {t("ttv.voice.engine.checking")}
        </span>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {state === "missing" ? (
              <Badge tone="danger" label={t("ttv.voice.engine.unavailable")} />
            ) : (
              <Badge tone="success" label={t("ttv.voice.engine.ready")} />
            )}
            {state === "ready" && (
              <Badge tone="success" label={t("ttv.voice.engine.clone-ready")} />
            )}
          </div>

          <p className="text-sm">{stateText}</p>

          {state !== "ready" && why && (
            <p className="flex items-start gap-2 text-meta text-[var(--text-muted)]">
              <AlertTriangle
                size={13}
                strokeWidth={2}
                className="mt-0.5 shrink-0 text-[var(--danger)]"
              />
              {why}
            </p>
          )}

          {/* Thiếu gì thì ngay cạnh nó phải có đường sửa - lệnh chép một phát */}
          {state !== "ready" && (
            <Panel title={t("voices.install-title")}>
              <ol className="flex flex-col gap-2">
                <InstallStep
                  index={1}
                  done={state === "speech-only"}
                  text={t("voices.install-step1")}
                />
                <InstallStep
                  index={2}
                  done={state === "speech-only"}
                  text={t("voices.install-step2")}
                  command={CMD_ENGINE}
                />
                <InstallStep
                  index={3}
                  text={t("voices.install-step3")}
                  command={CMD_TORCH}
                />
                <InstallStep index={4} text={t("voices.install-step4")} />
              </ol>
            </Panel>
          )}

          {/* Vết kỹ thuật (đường dẫn Python, traceback) - gấp lại, không dội
              vào mặt người dùng nhưng vẫn lấy ra được khi cần báo lỗi */}
          {status?.detail && (
            <details className="min-w-0">
              <summary className="cursor-pointer text-meta font-medium text-[var(--text-muted)]">
                {t("voices.detail")}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-[var(--radius)] bg-[var(--bg-subtle)] p-2 font-mono text-meta whitespace-pre-wrap">
                {status.detail}
              </pre>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

// ============ Form nhân bản ============

/** Lỗi biểu mẫu gắn với ĐÚNG ô nhập gây ra nó - hiện qua `<Field error>`. */
type FormError = { field: "name" | "file"; message: string };

function CloneVoiceModal({
  open,
  player,
  onClose,
  onCreated,
}: {
  open: boolean;
  player: Player;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t, tf } = useT();

  const [name, setName] = useState("");
  const [gender, setGender] = useState<TtsGender>("nam");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  /** Thời lượng ĐO ĐƯỢC của clip - null = chưa đo được, bỏ qua kiểm tra. */
  const [duration, setDuration] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  // Ghi âm trực tiếp
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micBlocked, setMicBlocked] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Đóng modal / rời trang giữa chừng: nhả micro, không để đèn mic sáng mãi
  const releaseMic = useCallback(() => {
    stopTimer();
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      rec.ondataavailable = null;
      rec.onstop = null;
      rec.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setRecording(false);
  }, [stopTimer]);

  useEffect(() => {
    if (open) return;
    releaseMic();
  }, [open, releaseMic]);

  useEffect(() => releaseMic, [releaseMic]);

  // Mở lại modal = form trắng, không nhớ lần nhân bản trước
  useEffect(() => {
    if (!open) return;
    setName("");
    setGender("nam");
    setNote("");
    setFile(null);
    setDuration(null);
    setElapsed(0);
    setFormError(null);
    setApiError(null);
    // micBlocked phải reset cùng chỗ này: thiếu nó thì một lần từ chối quyền
    // micro là từ đó trở đi mọi file tải lên đều bị báo đỏ oan, kể cả sau khi
    // đóng modal mở lại - mà tải file lên thì chẳng liên quan gì tới micro.
    setMicBlocked(false);
  }, [open]);

  async function acceptClip(clip: File, fallbackSec?: number) {
    player.stop();
    setFile(clip);
    setDuration(null);
    setFormError(null);
    setMeasuring(true);
    const sec = await readClipDuration(clip);
    setDuration(sec ?? (fallbackSec && fallbackSec > 0 ? fallbackSec : null));
    setMeasuring(false);
  }

  function stopRecording() {
    stopTimer();
    setRecording(false);
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  async function startRecording() {
    setFormError(null);
    player.stop();
    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setMicBlocked(true);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Người dùng từ chối quyền hoặc máy không có micro - vẫn còn đường chọn file
      setMicBlocked(true);
      return;
    }
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      const sec = (Date.now() - startedAtRef.current) / 1000;
      void acceptClip(
        new File([blob], `voice-ref.${extForMime(type)}`, { type }),
        sec
      );
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setMicBlocked(false);
    setElapsed(0);
    setRecording(true);
    recorder.start();
    timerRef.current = window.setInterval(() => {
      const sec = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(sec);
      // Tự dừng ở trần 30 giây: dài hơn KHÔNG tốt hơn, model chỉ lấy phần đầu
      if (sec >= CLONE_REF_MAX_SEC) stopRecording();
    }, 200);
  }

  const tooShort = duration !== null && duration < CLONE_REF_MIN_SEC;
  const tooLong = duration !== null && duration > CLONE_REF_IDEAL_MAX_SEC;
  const clipKey = "clone-clip";
  const clipPlaying = player.playing === clipKey;

  function toggleClip() {
    if (!file) return;
    if (clipPlaying) {
      player.stop();
      return;
    }
    player.play(clipKey, URL.createObjectURL(file), { objectUrl: true });
  }

  async function onSubmit() {
    if (submitting) return;
    if (!name.trim()) {
      setFormError({ field: "name", message: t("voices.form.need-name") });
      return;
    }
    if (!file) {
      setFormError({ field: "file", message: t("voices.form.need-file") });
      return;
    }
    if (tooShort) return;
    setFormError(null);
    setApiError(null);
    setSubmitting(true);
    try {
      await createClonedVoice({
        name: name.trim(),
        gender,
        ...(note.trim() ? { note: note.trim() } : {}),
        file,
      });
      player.stop();
      onCreated();
      onClose();
    } catch (e) {
      setApiError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Lỗi của ô "File mẫu" - gộp cả ba nguồn về một chỗ theo thứ tự ưu tiên:
   * chưa chọn file → clip ngắn quá → máy không cho dùng micro.
   */
  const fileError =
    formError?.field === "file"
      ? formError.message
      : tooShort
        ? tf("voices.form.file-too-short", {
            sec: Math.floor(duration ?? 0),
            min: CLONE_REF_MIN_SEC,
          })
        : micBlocked
          ? t("voices.form.no-mic")
          : null;

  return (
    <Modal
      title={t("voices.form.title")}
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={submitting}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={onSubmit}
            disabled={submitting || recording || measuring || tooShort}
          >
            {submitting ? (
              <Loader2 size={15} strokeWidth={2} className="animate-spin" />
            ) : (
              <Mic size={15} strokeWidth={2} />
            )}
            {submitting ? t("voices.form.submitting") : t("voices.form.submit")}
          </Button>
        </>
      }
    >
      {apiError && (
        <ErrorBanner message={t("voices.form.failed")} detail={apiError} />
      )}

      <Field
        label={t("voices.form.name")}
        htmlFor="voice-name"
        hint={t("voices.form.name-hint")}
        error={formError?.field === "name" ? formError.message : null}
        required
      >
        <input
          id="voice-name"
          className="input"
          autoFocus
          value={name}
          disabled={submitting}
          placeholder={t("voices.form.name-placeholder")}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <Field label={t("voices.form.gender")}>
        <Segmented
          label={t("voices.form.gender")}
          value={gender}
          disabled={submitting}
          onChange={setGender}
          options={GENDERS.map((g) => ({
            value: g,
            label: t(GENDER_LABEL_KEY[g]),
          }))}
        />
      </Field>

      <Field label={t("voices.form.note")} htmlFor="voice-note">
        <input
          id="voice-note"
          className="input"
          value={note}
          disabled={submitting}
          placeholder={t("voices.form.note-placeholder")}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>

      {/* Mẫu tham chiếu: file có sẵn HOẶC ghi âm ngay - hai đường vào cùng một chỗ */}
      <Field
        label={t("voices.form.file")}
        error={fileError}
        required
        hint={
          <>
            {tf("voices.form.file-hint", {
              min: CLONE_REF_MIN_SEC,
              ideal: CLONE_REF_IDEAL_MAX_SEC,
            })}
            {!recording && !file && (
              <span className="mt-1 block">{t("voices.form.record-hint")}</span>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/*"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) void acceptClip(picked);
                // Cho chọn lại đúng file vừa bỏ - input file không tự bắn change
                e.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              small
              disabled={submitting || recording}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={13} strokeWidth={2} />
              {file ? t("voices.form.file-change") : t("voices.form.file-pick")}
            </Button>
            {recording ? (
              <Button variant="destructive" small onClick={stopRecording}>
                <Square size={13} strokeWidth={2} />
                {t("voices.form.record-stop")}
              </Button>
            ) : (
              <Button
                variant="secondary"
                small
                disabled={submitting}
                onClick={startRecording}
              >
                <Mic size={13} strokeWidth={2} />
                {t("voices.form.record")}
              </Button>
            )}
            {recording && (
              <span className="inline-flex items-center gap-2 text-sm font-medium text-[var(--primary)] tabular-nums">
                <span className="badge-dot badge-dot-pulse" />
                {tf("voices.form.recording", { sec: Math.floor(elapsed) })}
              </span>
            )}
          </div>

          {/* Nghe lại clip TRƯỚC khi gửi - mẫu sai thì nhân bản ra giọng sai */}
          {file && !recording && (
            <Panel>
              <div className="flex flex-wrap items-center gap-2">
                <IconButton
                  label={
                    clipPlaying
                      ? t("voices.card.stop")
                      : t("voices.card.ref-play")
                  }
                  onClick={toggleClip}
                >
                  {clipPlaying ? (
                    <Square size={13} strokeWidth={2} />
                  ) : (
                    <Play size={13} strokeWidth={2} />
                  )}
                </IconButton>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {file.name}
                </span>
                <span className="shrink-0 text-meta text-[var(--text-muted)] tabular-nums">
                  {measuring
                    ? t("common.loading")
                    : duration !== null
                      ? formatDurationMs(duration * 1000)
                      : "-"}
                </span>
              </div>
            </Panel>
          )}

          {/* Dài quá chỉ là CẢNH BÁO: server tự cắt, chặn lại chỉ tổ phiền */}
          {tooLong && (
            <p className="flex items-start gap-2 text-meta text-[var(--text-muted)]">
              <AlertTriangle
                size={13}
                strokeWidth={2}
                className="mt-0.5 shrink-0"
              />
              {tf("voices.form.file-too-long", {
                sec: Math.round(duration ?? 0),
                ideal: CLONE_REF_IDEAL_MAX_SEC,
              })}
            </p>
          )}
        </div>
      </Field>
    </Modal>
  );
}

// ============ Thẻ một giọng ============

function VoiceCard({
  voice,
  player,
  canTest,
  blockedHint,
  onChanged,
  onDeleted,
}: {
  voice: ClonedVoice;
  player: Player;
  canTest: boolean;
  /** Vì sao nút đọc thử đang khóa - undefined khi engine chạy được. */
  blockedHint?: string;
  onChanged: (v: ClonedVoice) => void;
  onDeleted: (id: string) => void;
}) {
  const { t, tf, lang } = useT();

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(voice.name);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Lỗi đọc thử - hiện kèm câu giải thích riêng của việc đọc thử. */
  const [testError, setTestError] = useState<string | null>(null);
  /** Lỗi đổi tên / xóa - nguyên văn lời nhắn của server. */
  const [actionError, setActionError] = useState<string | null>(null);

  const refKey = `ref:${voice.id}`;
  const testKey = `test:${voice.id}`;
  const refPlaying = player.playing === refKey;
  const testPlaying = player.playing === testKey;

  function toggleRef() {
    if (refPlaying) {
      player.stop();
      return;
    }
    player.play(refKey, mediaUrl(voice.refFile));
  }

  async function toggleTest() {
    if (testPlaying) {
      player.stop();
      return;
    }
    if (testing) return;
    player.stop();
    setTesting(true);
    setTestError(null);
    try {
      const blob = await previewClonedVoice({ id: voice.id, uiLang: lang });
      player.play(testKey, URL.createObjectURL(blob), { objectUrl: true });
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }

  async function saveName() {
    const next = draftName.trim();
    if (!next || next === voice.name) {
      setRenaming(false);
      setDraftName(voice.name);
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      onChanged(await updateClonedVoice(voice.id, { name: next }));
      setRenaming(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteClonedVoice(voice.id);
      if (refPlaying || testPlaying) player.stop();
      // Thẻ biến mất ngay sau onDeleted - dọn cờ TRƯỚC khi báo cho cha
      setDeleteOpen(false);
      setDeleting(false);
      onDeleted(voice.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setDeleteOpen(false);
      setDeleting(false);
    }
  }

  // Ghi chú + ngày tạo gộp MỘT dòng phụ chú: trước đây là hai dòng riêng, cộng
  // với tên, chip, hai nút, hai dòng lỗi và chân thẻ là tám dòng trong một thẻ.
  const meta = [
    voice.note,
    tf("voices.card.created", { when: formatRelative(voice.createdAt) }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card
      className="flex h-full flex-col"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate" title={voice.name}>
            {voice.name}
          </span>
          <span className="chip shrink-0">
            {t(GENDER_LABEL_KEY[voice.gender])}
          </span>
        </span>
      }
      actions={
        <span className="flex shrink-0 items-center gap-1">
          <IconButton
            label={t("voices.card.rename")}
            onClick={() => {
              setDraftName(voice.name);
              setRenaming(true);
            }}
          >
            <Pencil size={14} strokeWidth={2} />
          </IconButton>
          <IconButton
            label={t("voices.card.delete")}
            tone="danger"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={14} strokeWidth={2} />
          </IconButton>
        </span>
      }
    >
      <div className="flex flex-1 flex-col gap-3">
        {renaming && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input min-w-0 flex-1"
              autoFocus
              value={draftName}
              disabled={saving}
              aria-label={t("voices.card.rename")}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setDraftName(voice.name);
                }
              }}
            />
            <Button small disabled={saving} onClick={saveName}>
              {saving ? t("common.saving") : t("voices.card.save")}
            </Button>
            <Button
              variant="secondary"
              small
              disabled={saving}
              onClick={() => {
                setRenaming(false);
                setDraftName(voice.name);
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        )}

        <p className="text-meta break-words text-[var(--text-muted)]">{meta}</p>

        {/* MỘT chỗ báo lỗi cho cả thẻ - đọc thử và đổi tên/xóa không còn hai
            kiểu chữ đỏ khác nhau nữa */}
        {/* Hai nguồn lỗi ĐỘC LẬP nhau (đổi tên/xóa vs đọc thử) nên mỗi cái
            một banner. Ghép chung một banner thì lúc cả hai cùng xảy ra, lỗi đọc
            thử bị nuốt mất và không quay lại cho tới lần bấm đọc thử sau. */}
        {actionError && <Banner tone="danger" message={actionError} />}
        {testError && (
          <Banner
            tone="danger"
            message={t("voices.card.test-failed")}
            detail={testError}
          />
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2">
          {/* Mẫu gốc - phát thẳng file đã lưu, không tốn một lần tổng hợp nào */}
          <IconButton
            label={
              refPlaying ? t("voices.card.stop") : t("voices.card.ref-play")
            }
            onClick={toggleRef}
          >
            {refPlaying ? (
              <Square size={13} strokeWidth={2} />
            ) : (
              <Play size={13} strokeWidth={2} />
            )}
          </IconButton>
          <span className="shrink-0 text-meta text-[var(--text-muted)] tabular-nums">
            {t("voices.card.ref")} ·{" "}
            {formatDurationMs(voice.refDurationSec * 1000)}
          </span>
          <span className="grow" />
          <Button
            variant="secondary"
            small
            disabled={!canTest || testing}
            title={canTest ? undefined : blockedHint}
            aria-label={tf("voices.card.test-aria", { name: voice.name })}
            onClick={toggleTest}
          >
            {testing ? (
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            ) : testPlaying ? (
              <Square size={13} strokeWidth={2} />
            ) : (
              <Volume2 size={13} strokeWidth={2} />
            )}
            {testPlaying ? t("voices.card.stop") : t("voices.card.test")}
          </Button>
        </div>
      </div>

      <ConfirmDeleteModal
        open={deleteOpen}
        title={tf("voices.card.delete-title", { name: voice.name })}
        description={<p>{t("voices.card.delete-body")}</p>}
        busy={deleting}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
      />
    </Card>
  );
}

// ============ Trang ============

export default function VoicesPage() {
  const { t, tf } = useT();
  const player = usePlayer();

  // undefined = chưa hỏi server lần nào (khác với "hỏi rồi mà không có engine")
  const [status, setStatus] = useState<TtsEngineStatus | null | undefined>(
    undefined
  );
  const [checking, setChecking] = useState(false);
  const [voices, setVoices] = useState<ClonedVoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const loadEngines = useCallback(async () => {
    setChecking(true);
    try {
      const list = await getTtsEngines();
      setStatus(list.find((e) => e.engine === OFFLINE_ENGINE) ?? null);
      setError(null);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  const loadVoices = useCallback(async () => {
    try {
      setVoices(await getClonedVoices());
    } catch (e) {
      setVoices([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadEngines();
    void loadVoices();
  }, [loadEngines, loadVoices]);

  const state = engineStateOf(status);
  const canClone = state === "ready";

  // Nút bị khóa phải nói được LÝ DO ngay tại chỗ - đừng bắt người dùng tự đoán
  // vì sao bấm không được rồi mới nhìn lên khối engine
  const blockedHint =
    state === "speech-only"
      ? t("voices.engine-speech-only")
      : state === "missing"
        ? t("voices.engine-missing")
        : undefined;

  const newButton = (
    <Button
      disabled={!canClone}
      title={blockedHint}
      onClick={() => setFormOpen(true)}
    >
      <Plus size={16} strokeWidth={2} />
      {t("voices.new")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("voices.title")}
        hint={{ titleKey: "help.voices.title", bodyKey: "help.voices.body" }}
        subtitle={t("voices.subtitle")}
        actions={newButton}
      />

      {/* Tiêu đề banner là CÂU NÓI CHO NGƯỜI DÙNG, nguyên văn exception xuống
          `detail` (gấp lại) - giống 9 trang danh sách còn lại. */}
      {error && <ErrorBanner message={t("voices.load-error")} detail={error} />}

      {/* 1. Engine trước tiên: chưa cài thì mọi thứ dưới đây đều vô nghĩa */}
      <EngineCard
        status={status ?? null}
        state={state}
        checking={checking}
        onRecheck={() => void loadEngines()}
      />

      {/* 2. Kho giọng đã nhân bản. Thẻ giọng TỰ NÓ là một <Card> nên đứng thẳng
          trong lưới - bọc thêm một Card bao ngoài là card lồng card. */}
      {voices === null ? (
        <div className={VOICE_GRID}>
          <CardGridSkeleton count={3} />
        </div>
      ) : voices.length === 0 ? (
        <Card>
          <EmptyState
            icon={Mic}
            title={t("voices.empty-title")}
            description={t("voices.empty-body")}
            action={newButton}
          />
        </Card>
      ) : (
        <>
          <h2 className="t-eyebrow">{tf("voices.count", { n: voices.length })}</h2>
          <div className={VOICE_GRID}>
            {voices.map((v) => (
              <VoiceCard
                key={v.id}
                voice={v}
                player={player}
                canTest={canClone}
                blockedHint={blockedHint}
                onChanged={(next) =>
                  setVoices((list) =>
                    (list ?? []).map((x) => (x.id === next.id ? next : x))
                  )
                }
                onDeleted={(id) =>
                  setVoices((list) => (list ?? []).filter((x) => x.id !== id))
                }
              />
            ))}
          </div>
          {/* Nói trước cái chậm của lần đọc đầu - không thì người dùng tưởng treo */}
          <p className="flex items-start gap-2 text-meta text-[var(--text-muted)]">
            <Volume2 size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
            {t("voices.first-run-slow")}
          </p>
        </>
      )}

      <CloneVoiceModal
        open={formOpen}
        player={player}
        onClose={() => setFormOpen(false)}
        onCreated={() => void loadVoices()}
      />
    </div>
  );
}
