import fs from "node:fs";
import path from "node:path";
import { venvPython } from "./config.js";
import { execFileCaptureAll, ensureDir, HttpError, moveFile, toRepoRel } from "./util.js";
import { parseTranscriptJson } from "./transcript.js";

/**
 * Transcribe video sang transcript có word timestamp (faster-whisper qua Python).
 * Chuẩn output PHẢI khớp `transcript.ts`: { segments: [{ start, end, text, words: [...] }] }
 *
 * VÌ SAO đi vòng qua Python thay vì `npx hyperframes transcribe`: CLI đó cần
 * binary `whisper-cpp` bên ngoài + model `.en` (chỉ tiếng Anh) nên vô dụng với
 * tiếng Việt. Công thức faster-whisper large-v3 dưới đây đã chạy thật cho toàn
 * bộ video tiếng Việt của hệ thống (xem skill `noti-tiktok-vn`,
 * `noti-tiktok-full-text`) - không tự chế cách khác.
 */

export interface TranscribeResult {
  /** relPath repo của file transcript.json đã ghi */
  relPath: string;
  segments: number;
  durationSec: number;
  language: string;
}

/** Python thoát mã này khi `import faster_whisper` thất bại - Node dịch thành NO_WHISPER */
const EXIT_NO_MODULE = 97;

/** Đoạn transcribe nhanh nhất cũng nên có trần thời gian - 2 giờ là quá đủ cho video vài giờ */
const MAX_WHISPER_MS = 2 * 60 * 60 * 1000;
const MIN_WHISPER_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ Python

let cachedPython: string | null = null;

/**
 * Tìm interpreter Python có sẵn `faster_whisper`.
 *
 * VÌ SAO phải dò nhiều tên: Windows thường chỉ có `py` (launcher) hoặc `python`,
 * macOS/Linux thường là `python3`. Dò bằng `-c "import faster_whisper"` để chọn
 * đúng interpreter ĐÃ CÀI module - máy có 2 bản Python mà chỉ 1 bản có module là
 * chuyện thường gặp. Kết quả cache lại vì lần dò đầu tốn vài giây (nạp ctranslate2).
 *
 * Thứ tự ưu tiên: PYTHON_BIN người dùng chỉ định (cửa thoát, luôn thắng) → venv
 * trong repo (.runtime/venv, do doctor dựng) → PYTHON → các tên trên PATH.
 */
async function resolvePython(): Promise<string> {
  if (cachedPython) return cachedPython;

  const candidates = [
    process.env.PYTHON_BIN,
    venvPython(),
    process.env.PYTHON,
    "python",
    "py",
    "python3",
  ].filter((c): c is string => typeof c === "string" && c.trim().length > 0);

  /** Chạy được Python nhưng thiếu module - dùng làm phương án cuối để báo lỗi rõ ràng */
  const runnable: string[] = [];

  for (const exe of candidates) {
    try {
      const r = await execFileCaptureAll(exe, ["-c", "import faster_whisper"], {
        timeoutMs: 120_000,
      });
      if (r.code === 0 && !r.timedOut) {
        cachedPython = exe;
        return exe;
      }
      runnable.push(exe); // Python chạy được, chỉ thiếu module
    } catch {
      /* không có exe này trên PATH - thử tên kế tiếp */
    }
  }

  if (runnable.length > 0) {
    // KHÔNG cache: người dùng pip install xong là lần sau dò lại thấy ngay
    return runnable[0];
  }

  throw new HttpError(
    503,
    "NO_WHISPER",
    "Không tìm thấy Python trên máy. Cài Python 3.10+ rồi chạy `pip install faster-whisper` " +
      "(hoặc trỏ biến môi trường PYTHON_BIN vào interpreter đã cài module).",
  );
}

// ------------------------------------------------------------------ Script Python

/**
 * Nội dung script transcribe. Tham số truyền qua argv (KHÔNG nhúng đường dẫn vào
 * mã) để tên file chứa dấu nháy/ký tự lạ không phá cú pháp Python.
 */
function pythonScript(): string {
  return [
    "# -*- coding: utf-8 -*-",
    "# File tam do apps/server/src/transcribe.ts sinh ra - Node xoa sau khi chay xong.",
    "import sys, json",
    "",
    "# BAT BUOC: console Windows mac dinh cp1252, khong reconfigure la vo tieng Viet",
    'sys.stdout.reconfigure(encoding="utf-8")',
    'sys.stderr.reconfigure(encoding="utf-8")',
    "",
    "AUDIO = sys.argv[1]",
    "OUT = sys.argv[2]",
    // "auto" -> None: faster-whisper TỰ dò ngôn ngữ. Cần cho tính năng Dịch
    // video, nơi người dùng đưa video tiếng nước ngoài mà không biết là tiếng
    // gì. Ép sẵn "vi" như trước là bóc băng sai toàn bộ mà không báo lỗi.
    "LANG = None if sys.argv[3] == 'auto' else sys.argv[3]",
    "TOTAL = float(sys.argv[4])",
    "LOGFILE = sys.argv[5]",
    "",
    "def log(msg):",
    "    # Ghi ca stderr (Node gom lai khi ket thuc) va file log (Node doc dan de hien tien do)",
    "    print(msg, file=sys.stderr)",
    "    sys.stderr.flush()",
    "    try:",
    '        with open(LOGFILE, "a", encoding="utf-8") as f:',
    "            print(msg, file=f)",
    "    except Exception:",
    "        pass",
    "",
    // GHI CHÚ CHO NGƯỜI SỬA SAU (đã thử và ĐO):
    // DLL của gói pip nvidia-* nằm trong site-packages/nvidia/<lib>/bin, không
    // trên PATH. Đã thử `os.add_dll_directory` ngay tại đây - KHÔNG ĂN, vì
    // ctranslate2 là thư viện native gọi LoadLibrary tên trần, mà đường tìm kiếm
    // do add_dll_directory thêm chỉ áp cho DLL nạp qua LoadLibraryEx. Cách chạy
    // được là chèn mấy thư mục đó vào PATH của TIẾN TRÌNH CON - xem childEnv()
    // trong config.ts. Đừng thêm lại add_dll_directory ở đây nữa.
    "try:",
    "    from faster_whisper import WhisperModel",
    "except Exception as err:",
    '    log("[whisper] THIEU MODULE faster_whisper: " + str(err))',
    `    sys.exit(${EXIT_NO_MODULE})`,
    "",
    "# GPU truoc (da kiem chung: nhanh gap doi va giai phong CPU cho render), loi thi CPU",
    // ĐÃ GẶP THẬT: dựng WhisperModel(device="cuda") THÀNH CÔNG rồi mới chết ở
    // lần encode đầu tiên với "Library cublas64_12.dll is not found" - vì
    // ctranslate2 nạp cuBLAS/cuDNN lười, tới lúc chạy mới nạp. Đường lùi cũ chỉ
    // bọc lúc DỰNG model nên không bao giờ chạy, và cả job chết hẳn.
    // Vì vậy phải bọc CẢ lượt chạy đầu tiên: chỉ khi model đã đọc được thật thì
    // mới coi là GPU dùng được.
    "def build(dev):",
    '    return WhisperModel("large-v3", device=dev, compute_type=("float16" if dev == "cuda" else "int8"))',
    "",
    "def run(dev):",
    "    m = build(dev)",
    "    segs, inf = m.transcribe(AUDIO, language=LANG, word_timestamps=True)",
    "    first = next(iter(segs), None)   # ép chạy thật - lỗi CUDA lộ ra ở đây",
    "    return m, segs, inf, first",
    "",
    'device = "cuda"',
    "try:",
    '    model, segments, info, _first = run("cuda")',
    "except Exception as err:",
    '    log("[whisper] khong dung duoc CUDA (" + str(err)[:300] + ") - chuyen sang CPU")',
    '    device = "cpu"',
    '    model, segments, info, _first = run("cpu")',
    "",
    'log("[whisper] bat dau - device=" + device + " model=large-v3 lang=" + (LANG or "auto"))',
    "",
    // `segments` là generator ĐÃ tiêu mất phần tử đầu ở bước dò trên - nối lại
    // để không mất câu mở đầu của video.
    "import itertools",
    "if _first is not None:",
    "    segments = itertools.chain([_first], segments)",
    "",
    "out_segments = []",
    "last_log = -99.0",
    "for seg in segments:",
    "    words = []",
    "    for w in (seg.words or []):",
    "        words.append({",
    '            "word": w.word,',
    '            "start": round(float(w.start), 3),',
    '            "end": round(float(w.end), 3),',
    "        })",
    "    out_segments.append({",
    '        "start": round(float(seg.start), 3),',
    '        "end": round(float(seg.end), 3),',
    '        "text": (seg.text or "").strip(),',
    '        "words": words,',
    "    })",
    "    # Tien do: generator cua faster-whisper chi chay khi duyet, moi segment la mot buoc",
    "    if seg.end - last_log >= 2.0:",
    "        last_log = seg.end",
    '        log("[whisper] %.1fs/%.1fs (%d segment)" % (seg.end, TOTAL, len(out_segments)))',
    "",
    "duration = TOTAL",
    "try:",
    "    if info is not None and info.duration:",
    "        duration = float(info.duration)",
    "except Exception:",
    "    pass",
    "",
    "lang_out = LANG",
    "try:",
    "    if info is not None and info.language:",
    "        lang_out = str(info.language)",
    "except Exception:",
    "    pass",
    "",
    'data = {"segments": out_segments, "language": lang_out, "duration": round(duration, 3)}',
    'with open(OUT, "w", encoding="utf-8") as f:',
    "    json.dump(data, f, ensure_ascii=False, indent=1)",
    "",
    'log("[whisper] xong: " + str(len(out_segments)) + " segment")',
    "",
  ].join("\n");
}

// ------------------------------------------------------------------ Tiện ích

/**
 * Đọc dần file log của Python và đẩy dòng mới qua onLog.
 *
 * VÌ SAO không đọc thẳng stderr của child: `execFileCaptureAll` chỉ trả stderr
 * MỘT LẦN khi process kết thúc, mà transcribe video dài chạy hàng chục phút -
 * job sẽ trông như treo. Python mở/đóng file log theo từng dòng nên file luôn
 * kết thúc ở ranh giới dòng, đọc dở không bao giờ cắt đôi ký tự UTF-8.
 * Trả về hàm dừng (gọi xong sẽ đọc nốt phần đuôi).
 */
function tailLogFile(logFile: string, onLog?: (line: string) => void): () => void {
  if (!onLog) return () => {};
  let offset = 0;
  const pump = (): void => {
    try {
      if (!fs.existsSync(logFile)) return;
      const size = fs.statSync(logFile).size;
      if (size <= offset) return;
      const fd = fs.openSync(logFile, "r");
      try {
        const len = size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        offset = size;
        for (const line of buf.toString("utf8").split(/\r?\n/)) {
          if (line.trim()) onLog(line.trim());
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* Python đang ghi dở - vòng sau đọc lại */
    }
  };
  const timer = setInterval(pump, 2000);
  return () => {
    clearInterval(timer);
    pump();
  };
}

/** Vài dòng cuối của stderr - đủ để hiểu lỗi mà không nhấn chìm log job */
function tail(text: string, lines = 12): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join("\n");
}

function rmQuiet(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* file đang bị giữ - bỏ qua, đây chỉ là file tạm */
  }
}

// ------------------------------------------------------------------ Audio dùng chung

/**
 * Đo thời lượng media bằng ffprobe. Ném HttpError NO_FFMPEG khi máy chưa có
 * ffprobe - đây là lỗi cấu hình máy chứ không phải lỗi dữ liệu, người dùng cần
 * đọc được đúng câu đó thay vì "spawn ENOENT".
 *
 * Trả 0 khi ffprobe chạy được nhưng không đọc ra số (container lạ) - phía gọi tự
 * quyết định chạy tiếp hay dừng.
 */
export async function probeDurationSec(mediaAbs: string): Promise<number> {
  let probe: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    probe = await execFileCaptureAll(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mediaAbs],
      { timeoutMs: 20_000 },
    );
  } catch (err) {
    throw new HttpError(
      503,
      "NO_FFMPEG",
      `Không chạy được ffprobe - cài FFmpeg và thêm vào PATH. Chi tiết: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const sec = parseFloat(probe.stdout.trim());
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

/**
 * Tách audio của video ra WAV mono 16kHz.
 *
 * DÙNG CHUNG cho MỌI provider bóc lời (xem `stt.ts`), không chỉ faster-whisper:
 *  - whisper muốn đúng 16kHz mono;
 *  - Gemini và Soniox đều nhận WAV, và 16kHz mono là định dạng NHỎ NHẤT vẫn giữ
 *    trọn dải tần tiếng nói (32 kB/giây) - đây là con số quyết định việc chia
 *    khúc audio gửi lên Gemini, xem `GEMINI_CHUNK_SEC` ở stt.ts.
 * Có đúng một chỗ tách audio thì mọi provider nghe CÙNG một thứ, so sánh kết quả
 * mới có nghĩa.
 *
 * `-vn` bỏ luồng hình: video 64 MB ra file wav vài MB, và ffmpeg không phải giải
 * mã hình để làm việc này.
 */
export async function extractAudioWav(input: {
  videoAbs: string;
  outWavAbs: string;
  /** Thời lượng video (giây) - chỉ dùng để tính timeout, 0 = dùng sàn 10 phút */
  durationSec?: number;
  isCanceled?: () => boolean;
}): Promise<void> {
  const { videoAbs, outWavAbs } = input;
  const durationSec = input.durationSec ?? 0;
  ensureDir(path.dirname(outWavAbs));

  // Tách audio nhanh hơn thời gian thật rất nhiều; cho hẳn 1x thời lượng, sàn 10
  // phút, trần 1 giờ - quá mức đó là ffmpeg đang treo chứ không phải chậm.
  const timeoutMs = Math.min(Math.max(MIN_WHISPER_MS, durationSec * 1000), 60 * 60 * 1000);
  let wav: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    wav = await execFileCaptureAll(
      "ffmpeg",
      ["-y", "-i", videoAbs, "-vn", "-ac", "1", "-ar", "16000", outWavAbs],
      { timeoutMs, isCanceled: input.isCanceled },
    );
  } catch (err) {
    throw new HttpError(
      503,
      "NO_FFMPEG",
      `Không chạy được ffmpeg - cài FFmpeg và thêm vào PATH. Chi tiết: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (wav.timedOut) {
    throw new Error(`Tách audio quá ${Math.round(timeoutMs / 60_000)} phút chưa xong - đã hủy`);
  }
  if (wav.canceled) throw new Error("Job đã bị hủy");
  if (wav.code !== 0 || !fs.existsSync(outWavAbs)) {
    throw new Error(`Tách audio thất bại (ffmpeg thoát mã ${wav.code}):\n${tail(wav.stderr)}`);
  }
}

// ------------------------------------------------------------------ Hàm chính

export async function transcribeVideo(input: {
  videoAbs: string;
  outJsonAbs: string;
  /**
   * Mã ngôn ngữ whisper - mặc định "vi". Truyền "auto" để whisper TỰ dò
   * (dùng cho Dịch video: người dùng đưa video tiếng nước ngoài mà không biết
   * là tiếng gì). Ngôn ngữ thật whisper nhận ra được trả về trong `language`.
   */
  language?: string;
  onLog?: (line: string) => void;
  /**
   * Job bị hủy chưa. Truyền từ JobCtx.isCanceled - không truyền thì hủy job xong
   * tiến trình whisper vẫn chạy tiếp và tiếp tục ăn GPU (đã gặp thật).
   */
  isCanceled?: () => boolean;
}): Promise<TranscribeResult> {
  const { videoAbs, outJsonAbs, onLog, isCanceled } = input;
  const language = (input.language ?? "vi").trim() || "vi";
  const log = (line: string): void => onLog?.(line);

  if (!fs.existsSync(videoAbs)) {
    throw new HttpError(404, "VIDEO_NOT_FOUND", `Không tìm thấy video nguồn: ${videoAbs}`);
  }
  ensureDir(path.dirname(outJsonAbs));

  // File tạm đặt cạnh file đích (cùng ổ đĩa nên rename được, và job dọn dễ)
  const stem = path.join(
    path.dirname(outJsonAbs),
    `${path.basename(outJsonAbs, path.extname(outJsonAbs))}.whisper-${process.pid}-${Date.now()}`,
  );
  const wavAbs = `${stem}.wav`;
  const pyAbs = `${stem}.py`;
  const logAbs = `${stem}.log`;
  const tmpJsonAbs = `${stem}.json`;

  try {
    // 1. Đo thời lượng trước - dùng để tính timeout và để Python in tiến độ theo %
    const durationSec = await probeDurationSec(videoAbs);
    if (durationSec <= 0) {
      log("[transcribe] ffprobe không đọc được thời lượng - vẫn chạy tiếp, tiến độ sẽ không có mốc tổng");
    }

    // 2. Tách audio mono 16kHz - đúng định dạng whisper muốn, file nhỏ hơn video hàng chục lần
    log(`[transcribe] tách audio 16kHz mono (video dài ${durationSec.toFixed(1)}s)`);
    await extractAudioWav({ videoAbs, outWavAbs: wavAbs, durationSec, isCanceled });

    // 3. Chạy faster-whisper qua script Python tạm
    fs.writeFileSync(pyAbs, pythonScript(), "utf8");
    const python = await resolvePython();

    // Video dài chạy rất lâu: cho hẳn gấp đôi thời lượng, sàn 10 phút, trần 2 giờ
    const whisperTimeout = Math.min(
      Math.max(MIN_WHISPER_MS, durationSec * 2000),
      MAX_WHISPER_MS,
    );
    log(
      `[transcribe] chạy faster-whisper large-v3 (${python}, lang=${language}, ` +
        `trần ${Math.round(whisperTimeout / 60_000)} phút)`,
    );

    const stopTail = tailLogFile(logAbs, onLog);
    let run: Awaited<ReturnType<typeof execFileCaptureAll>>;
    try {
      run = await execFileCaptureAll(
        python,
        [pyAbs, wavAbs, tmpJsonAbs, language, String(durationSec), logAbs],
        { timeoutMs: whisperTimeout, isCanceled },
      );
    } finally {
      stopTail();
    }

    // Hủy trước mọi phép đoán lỗi khác: tiến trình bị giết nên exit code là rác
    if (run.canceled) throw new Error("Job đã bị hủy");
    if (run.code === EXIT_NO_MODULE) {
      throw new HttpError(
        503,
        "NO_WHISPER",
        "Máy chưa cài faster-whisper. Chạy `pip install faster-whisper` (Python 3.10+) rồi thử lại. " +
          "Nếu máy có nhiều bản Python, trỏ biến môi trường PYTHON_BIN vào bản đã cài module.",
      );
    }
    if (/No module named|ModuleNotFoundError/i.test(run.stderr)) {
      throw new HttpError(
        503,
        "NO_WHISPER",
        `Python thiếu module cho faster-whisper. Chạy \`pip install faster-whisper\` rồi thử lại.\n${tail(run.stderr, 5)}`,
      );
    }
    if (run.timedOut) {
      throw new Error(
        `Transcribe quá ${Math.round(whisperTimeout / 60_000)} phút chưa xong - đã hủy. ` +
          "Video quá dài hoặc đang chạy trên CPU; cân nhắc cắt bớt video nguồn.",
      );
    }
    if (run.code !== 0) {
      throw new Error(`faster-whisper thất bại (thoát mã ${run.code}):\n${tail(run.stderr)}`);
    }

    // 4. Validate bằng chính parser mà cả hệ thống dùng để đọc transcript
    if (!fs.existsSync(tmpJsonAbs)) {
      throw new Error(`faster-whisper chạy xong nhưng không ghi ra file JSON:\n${tail(run.stderr)}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(tmpJsonAbs, "utf8"));
    } catch (err) {
      throw new Error(
        `File transcript vừa tạo không phải JSON hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const segments = parseTranscriptJson(raw);
    if (!segments || segments.length === 0) {
      throw new Error(
        "Transcript rỗng hoặc sai định dạng (không có segment nào đọc được) - " +
          "kiểm tra lại video có tiếng nói không.",
      );
    }

    const meta = (raw ?? {}) as Record<string, unknown>;
    const langOut = typeof meta.language === "string" && meta.language ? meta.language : language;
    // Thời lượng lấy theo video (chuẩn hơn), thiếu thì lùi về mốc kết thúc segment cuối
    const lastEnd = segments[segments.length - 1].end;
    const durationOut = durationSec > 0 ? durationSec : lastEnd;

    // Chỉ ghi đè file đích khi đã chắc chắn hợp lệ - tránh để lại transcript hỏng
    moveFile(tmpJsonAbs, outJsonAbs);

    const withWords = segments.filter((s) => s.words.length > 0).length;
    log(
      `[transcribe] xong: ${segments.length} segment (${withWords} segment có word timestamp), ` +
        `ngôn ngữ ${langOut}`,
    );

    return {
      relPath: toRepoRel(outJsonAbs),
      segments: segments.length,
      durationSec: Math.round(durationOut * 100) / 100,
      language: langOut,
    };
  } finally {
    // Dọn mọi file tạm kể cả khi lỗi - wav của video dài có thể nặng hàng trăm MB
    rmQuiet(wavAbs);
    rmQuiet(pyAbs);
    rmQuiet(logAbs);
    rmQuiet(tmpJsonAbs);
  }
}
