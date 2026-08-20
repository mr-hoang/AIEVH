import fs from "node:fs";
import path from "node:path";
import { paths } from "../config.js";
import { updateJob } from "../db.js";
import {
  autoAssignVoices,
  measureSpeakerF0,
  mixOriginalUnder,
  synthesizeDub,
  ttsLanguageFor,
  type DubVoiceAssignment,
} from "../dub.js";
import type { JobCtx } from "../queue.js";
import { remotionSpeedArgs } from "../renderSettings.js";
import { transcribeWith } from "../stt.js";
import { segmentsToCues } from "../subtitles.js";
import { parseTranscriptJson } from "../transcript.js";
import {
  dubCuesOf,
  dubDirOf,
  dubMixPathOf,
  dubSignature,
  dubWavPathOf,
  effectiveDubLang,
  outputPathOf,
  patchTranslateVideo,
  readTranslateVideo,
  sourceAbsOf,
  transcriptPathOf,
  translateVideoDirOf,
  wantsDub,
  wantsSubtitle,
  type SubtitleStyle,
  type TranslateVideoMeta,
  type TranslatedCue,
} from "../translateVideoMeta.js";
import { DEFAULT_TTS_VOICE, listVoices } from "../tts.js";
import { listLocalVoices } from "../ttsLocal.js";
import type { TtsEngine, TtsVoice } from "../ttsTypes.js";
import { ensureDir, nowIso, remotionCli, toRepoRel } from "../util.js";
import { parseProgressLine, shortenStep } from "./progress.js";

/**
 * Job "translate-video" - hai bước NẶNG của phiên Dịch video.
 * `job.projectId` là id phiên (translate-video/<id>), `job.sceneId` là step:
 *  - "transcribe": whisper bóc lời video nguồn -> transcript.json -> cues gốc
 *  - "render"    : stage nguồn + sinh props Remotion + render ra output.mp4
 *
 * Bước DỊCH không nằm ở đây: nó chạy đồng bộ trong route (POST /:id/translate),
 * giống /script của Text to video - vài chục giây, và người dùng phải đọc lại
 * bản dịch trước khi tốn thời gian render.
 *
 * KHÁC text-to-video: ở đây KHÔNG có promise chạy nền sau khi job kết thúc. Mọi
 * việc đều tất định và kết thúc TRONG job, nên không cần reconcile() - job xong
 * là trạng thái trên đĩa đã đúng, kể cả khi server restart ngay sau đó.
 */
export async function runTranslateVideo(ctx: JobCtx): Promise<void> {
  // Queue nhét id phiên vào projectId (giống auto-cut) - xem busyKeyOf ở queue.ts
  const id = ctx.job.projectId;
  const step = ctx.job.sceneId === "render" ? "render" : "transcribe";

  try {
    if (step === "render") await stepRender(ctx, id);
    else await stepTranscribe(ctx, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (ctx.isCanceled()) {
        // Người dùng tự bấm hủy KHÔNG phải lỗi: đưa phiên về trạng thái CHẠY LẠI
        // ĐƯỢC thay vì "failed" (không banner đỏ, không phải làm lại từ đầu).
        const cur = readTranslateVideo(id);
        patchTranslateVideo(id, { status: recoverableStatus(cur, step), error: null });
      } else {
        patchTranslateVideo(id, { status: "failed", error: message });
      }
    } catch {
      /* phiên có thể đã bị xóa giữa chừng - vẫn phải ném lỗi gốc ra queue */
    }
    throw err;
  }
}

/** Trạng thái quay về sau khi hủy - bám theo dữ liệu ĐANG CÓ trên đĩa */
function recoverableStatus(
  meta: TranslateVideoMeta,
  step: "transcribe" | "render",
): TranslateVideoMeta["status"] {
  if (step === "render") return meta.cues.length > 0 ? "translated" : "transcribed";
  return meta.transcriptFile ? "transcribed" : "draft";
}

// ================================================================== Step "transcribe"

async function stepTranscribe(ctx: JobCtx, id: string): Promise<void> {
  const meta = patchTranslateVideo(id, { status: "transcribing", error: null });
  const videoAbs = sourceAbsOf(meta);
  const outJsonAbs = transcriptPathOf(id);
  ensureDir(translateVideoDirOf(id));

  /**
   * "auto" đi thẳng xuống provider: mọi provider ở `stt.ts` đều TỰ dò được ngôn
   * ngữ (faster-whisper `language=None`, Gemini tự nghe, Soniox bật
   * `enable_language_identification`). Đây là mặc định đúng của tính năng này -
   * người dùng đưa video tiếng nước ngoài thường KHÔNG biết đó là tiếng gì, ép
   * sẵn tiếng Việt là bóc sai toàn bộ mà không có lỗi nào báo ra.
   * Ngôn ngữ nhận ra được ghi lại vào meta ở dưới.
   */
  const language = meta.sourceLang === "auto" ? "auto" : meta.sourceLang;
  if (language === "auto") {
    ctx.log("[translate] sourceLang = auto - để AI bóc lời tự dò ngôn ngữ của video");
  }

  ctx.progress(2, `Bóc lời video nguồn (${meta.sttProvider})`);
  const res = await transcribeWith({
    provider: meta.sttProvider,
    videoAbs,
    outJsonAbs,
    language,
    /**
     * LUÔN xin nhãn người nói. Provider nào không làm được thì `stt.ts` chỉ ghi
     * một dòng log rồi đi tiếp, không tốn gì; còn thiếu nhãn thì bước lồng tiếng
     * sắp tới không biết câu nào của giọng nam để gán đúng giọng nam - và lúc
     * phát hiện ra thì phải bóc lời LẠI cả video, đó mới là cái đắt.
     */
    diarize: true,
    onLog: (line) => ctx.log(line),
    // BẮT BUỘC: không truyền thì hủy job xong whisper vẫn chạy tiếp và ăn GPU
    isCanceled: () => ctx.isCanceled(),
  });
  if (ctx.isCanceled()) throw new Error("Job đã bị hủy");
  ctx.log(
    `[translate] transcript: ${res.segments.length} đoạn, ${res.durationSec.toFixed(1)}s, ` +
      `ngôn ngữ ${res.language}, provider ${res.provider}` +
      (res.diarized ? `, ${res.speakers.length} người nói (${res.speakers.join(", ")})` : "") +
      (res.wordTimestamps ? "" : ", KHÔNG có mốc từng từ"),
  );

  // Vá ngay sau mỗi bước con: transcribe là phần đắt nhất, hỏng ở bước sau thì
  // vẫn còn nguyên file này để chạy lại từ giữa.
  patchTranslateVideo(id, {
    transcriptFile: toRepoRel(outJsonAbs),
    // Provider ĐÃ chạy + có phân vai không: UI hiện thẳng, không phải đoán từ
    // lựa chọn `sttProvider` (người dùng đổi lựa chọn mà chưa chạy lại là lệch).
    transcriptInfo: {
      provider: res.provider,
      language: res.language,
      diarized: res.diarized,
      speakers: res.speakers,
      wordTimestamps: res.wordTimestamps,
    },
    // Phiên để "auto" thì ghi lại ngôn ngữ ĐÃ DÙNG - lần dịch sau khỏi đoán
    ...(meta.sourceLang === "auto" ? { sourceLang: res.language } : {}),
  });

  ctx.progress(88, "Chia câu phụ đề");
  const cues = cuesFromTranscript(outJsonAbs);
  if (cues.length === 0) {
    throw new Error(
      "Transcript không chia được câu phụ đề nào - kiểm tra lại video có tiếng nói không.",
    );
  }
  ctx.log(`[translate] ${cues.length} câu phụ đề gốc, sẵn sàng để dịch`);

  patchTranslateVideo(id, { cues, status: "transcribed", error: null });
  ctx.progress(100, `Đã bóc ${cues.length} câu`);
}

/**
 * transcript.json -> danh sách cue GỐC (chưa dịch).
 *
 * Dùng `segmentsToCues` của hệ thống chứ KHÔNG viết bộ chia câu thứ hai: nó đã
 * cắt đúng ranh giới TỪ (không bao giờ cụt dấu tiếng Việt) và cân hai dòng.
 * `text` = `original` ở bước này, để UI có cái hiện ngay và để bước dịch luôn
 * biết câu gốc là gì kể cả sau khi dịch đè lên `text`.
 */
export function cuesFromTranscript(transcriptAbs: string): TranslatedCue[] {
  if (!fs.existsSync(transcriptAbs)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(transcriptAbs, "utf8"));
  } catch {
    return [];
  }
  const segments = parseTranscriptJson(raw);
  if (!segments || segments.length === 0) return [];

  const speakerRanges = readSpeakerRanges(raw);
  return segmentsToCues(segments).map((c) => {
    const start = Math.round(c.start * 1000) / 1000;
    const end = Math.round(c.end * 1000) / 1000;
    const cue: TranslatedCue = { start, end, text: c.text, original: c.text };
    const speaker = speakerAt(speakerRanges, start, end);
    if (speaker) cue.speaker = speaker;
    return cue;
  });
}

/** Một khoảng thời gian thuộc về một người nói - dựng từ JSON THÔ của transcript */
interface SpeakerRange {
  start: number;
  end: number;
  speaker: string;
}

/**
 * Đọc nhãn người nói từ JSON thô.
 *
 * VÌ SAO KHÔNG LẤY TỪ `parseTranscriptJson`: parser chung CỐ Ý chỉ giữ
 * start/end/text/words - nó là hợp đồng ổn định cho cả hệ thống và `speaker` chỉ
 * là field phụ thêm mà provider mới ghi ra. Muốn dùng nhãn thì đọc thẳng JSON
 * thô ở đây, chứ không nới hợp đồng của parser (nới là mọi consumer phải quan
 * tâm tới một field họ không cần).
 *
 * Transcript của faster-whisper không có `speaker` -> trả [] và mọi cue không có
 * nhãn, đúng như trước.
 */
function readSpeakerRanges(raw: unknown): SpeakerRange[] {
  const segs =
    raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).segments)
      ? ((raw as Record<string, unknown>).segments as unknown[])
      : [];
  const out: SpeakerRange[] = [];
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const speaker = typeof o.speaker === "string" ? o.speaker.trim() : "";
    const start = typeof o.start === "number" && Number.isFinite(o.start) ? o.start : null;
    const end = typeof o.end === "number" && Number.isFinite(o.end) ? o.end : null;
    if (!speaker || start === null || end === null || end <= start) continue;
    out.push({ start, end, speaker });
  }
  return out;
}

/**
 * Người nói của một cue = người CHIẾM NHIỀU THỜI GIAN NHẤT trong khoảng cue.
 *
 * Không lấy theo mốc bắt đầu: `segmentsToCues` cắt segment dài thành nhiều cue,
 * và một cue nằm vắt qua chỗ đổi người nói thì mốc bắt đầu vẫn thuộc người
 * TRƯỚC - gán theo mốc là câu của người B bị dán nhãn người A, tức là bước lồng
 * tiếng sẽ đọc câu đó bằng sai giọng.
 */
function speakerAt(ranges: SpeakerRange[], start: number, end: number): string | null {
  let best: string | null = null;
  let bestOverlap = 0;
  for (const r of ranges) {
    const overlap = Math.min(end, r.end) - Math.max(start, r.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = r.speaker;
    }
  }
  return bestOverlap > 0 ? best : null;
}

// ================================================================== Step "render"

/** Khung dùng khi ffprobe không đọc được kích thước nguồn (hiếm - nhưng phải có số) */
const FALLBACK_WIDTH = 1080;
const FALLBACK_HEIGHT = 1920;

/**
 * Bước lồng tiếng chiếm bao nhiêu phần trăm thanh tiến độ của job render.
 *
 * Nó là phần LÂU NHẤT của chế độ "dub" (mỗi câu một lượt gọi TTS, một video 5
 * phút là ~80 lượt), nên phải chiếm phần lớn thanh - để 90% cho Remotion thì
 * thanh đứng im ở 0% suốt vài phút rồi mới nhảy, người dùng tưởng treo.
 */
const DUB_PROGRESS_SHARE = 65;

async function stepRender(ctx: JobCtx, id: string): Promise<void> {
  const meta = patchTranslateVideo(id, { status: "rendering", error: null });
  const dubbing = wantsDub(meta.mode);
  if (meta.cues.length === 0) {
    throw new Error(
      dubbing
        ? "Chưa có câu nào để lồng tiếng - chạy bước bóc lời và dịch trước."
        : "Chưa có câu phụ đề nào để ghép - chạy bước bóc lời và dịch trước.",
    );
  }
  const videoAbs = sourceAbsOf(meta);
  const dir = translateVideoDirOf(id);
  ensureDir(dir);

  // ---- 0. Lồng tiếng (chỉ mode "dub") ----------------------------------
  // Làm TRƯỚC khi stage/render: đây là bước tốn tiền và lâu nhất, hỏng ở đây thì
  // không cần đụng tới Remotion.
  const voiceAbs = dubbing ? await buildDubTrack(ctx, id, videoAbs) : null;

  // ---- 1. Stage video nguồn --------------------------------------------
  // Remotion chỉ đọc file qua staticFile() trong public/ - đường dẫn tuyệt đối
  // trên đĩa sẽ 404 giữa chừng render. Namespace "tvd-" tách khỏi staging của
  // video project (vid-) và image project (img-) trùng id.
  ctx.progress(dubbing ? DUB_PROGRESS_SHARE : 0, "Stage video nguồn vào Remotion staging");
  const stagingId = `tvd-${id}`;
  const stagingAbs = path.join(paths.stagingDir, stagingId);
  fs.rmSync(stagingAbs, { recursive: true, force: true });
  ensureDir(stagingAbs);

  const ext = path.extname(videoAbs).toLowerCase() || ".mp4";
  const stagedName = `source${ext}`;
  const stagedAbs = path.join(stagingAbs, stagedName);
  stageFile(videoAbs, stagedAbs);
  const stagedRel = `staging/${stagingId}/${stagedName}`;
  ctx.log(`[stage] ${meta.source.relPath} -> ${stagedRel}`);

  let voiceRel: string | null = null;
  if (voiceAbs) {
    stageFile(voiceAbs, path.join(stagingAbs, "dub.wav"));
    voiceRel = `staging/${stagingId}/dub.wav`;
    ctx.log(`[stage] ${toRepoRel(voiceAbs)} -> ${voiceRel}`);
  }

  // ---- 2. props cho Remotion -------------------------------------------
  // Đọc lại meta từ đĩa: bước lồng tiếng vừa ghi dubInfo + giọng đã gán vào đó
  const props = buildProps(readTranslateVideo(id), stagedRel, voiceRel);
  const propsAbs = path.join(dir, "props.resolved.json");
  fs.writeFileSync(propsAbs, JSON.stringify(props, null, 2) + "\n", "utf8");
  ctx.log(
    `[props] ${props.width}x${props.height} @${props.fps}fps, ` +
      (dubbing
        ? `lồng tiếng (track ${voiceRel}), tiếng gốc ${props.scenes[0].muted ? "tắt" : "giữ"}`
        : `${props.subtitles.length} câu`) +
      ` -> ${propsAbs}`,
  );

  // ---- 3. Remotion render ----------------------------------------------
  const outAbs = outputPathOf(id);
  const base = dubbing ? DUB_PROGRESS_SHARE : 0;
  const span = 100 - base;
  ctx.progress(base, dubbing ? "Remotion ghép track lồng tiếng" : "Remotion ghép phụ đề");
  const args = [
    remotionCli(),
    "render",
    "Assemble",
    `--props=${propsAbs}`,
    `--output=${outAbs}`,
    ...remotionSpeedArgs(),
  ];
  await ctx.exec(process.execPath, args, paths.remotionDir, (line) => {
    const pct = parseProgressLine(line);
    if (pct !== null) ctx.progress(base + (pct * span) / 100, shortenStep(line));
  });

  if (!fs.existsSync(outAbs)) {
    throw new Error("Remotion render xong nhưng không thấy file output.mp4");
  }

  const outputRel = toRepoRel(outAbs);
  updateJob(ctx.job.id, { outputPath: outputRel });
  patchTranslateVideo(id, { outputFile: outputRel, status: "done", error: null });
  ctx.progress(100, dubbing ? "Đã lồng tiếng" : "Đã ghép phụ đề");
}

/** Hardlink (không tốn dung lượng), lùi về copy khi khác ổ đĩa / FS không hỗ trợ */
function stageFile(srcAbs: string, dstAbs: string): void {
  try {
    fs.linkSync(srcAbs, dstAbs);
  } catch {
    fs.copyFileSync(srcAbs, dstAbs);
  }
}

// ================================================================== Lồng tiếng

/**
 * Kho giọng của một engine. Kho rỗng là lỗi CÓ THẬT chứ không phải ca hiếm:
 * engine offline chưa cài thì `listLocalVoices()` trả rỗng, và nếu cứ đi tiếp
 * thì job chết ở câu đầu tiên với một thông báo của Python không ai đọc nổi.
 */
async function loadVoiceCatalog(engine: TtsEngine): Promise<TtsVoice[]> {
  // `listVoices()` của Gemini KHÔNG bao giờ ném: mất mạng thì nó tự lùi về danh
  // sách tĩnh trong code. Chỉ engine offline mới thật sự có thể không có giọng nào.
  if (engine !== "vieneu") return listVoices();
  const voices: TtsVoice[] = await listLocalVoices().catch(() => []);
  if (voices.length === 0) {
    throw new Error(
      "Chưa có giọng đọc offline nào - cài engine VieNeu-TTS (trang Cấu hình) rồi chạy lại, " +
        'hoặc đổi engine lồng tiếng sang "gemini".',
    );
  }
  return voices;
}

/**
 * Dựng track lồng tiếng cho phiên và trả về ĐƯỜNG DẪN TUYỆT ĐỐI của file sẽ đưa
 * vào Remotion (bản thuần lồng tiếng, hoặc bản đã trộn tiếng gốc chạy nhỏ).
 *
 * Ba việc, theo thứ tự: gán giọng -> đọc + co cho vừa -> (tùy chọn) trộn nền.
 */
async function buildDubTrack(ctx: JobCtx, id: string, videoAbs: string): Promise<string> {
  const meta = readTranslateVideo(id);
  const dubDir = dubDirOf(id);
  ensureDir(dubDir);
  // Ngôn ngữ ĐỌC lấy theo effectiveDubLang, không phải targetLang: mode "both"
  // có thể đọc tiếng Việt trong khi phụ đề là tiếng Anh.
  const language = meta.dub.language ?? ttsLanguageFor(effectiveDubLang(meta));
  // Chữ để ĐỌC (dubText khi có) - khác chữ hiện lên màn hình
  const speechCues = dubCuesOf(meta);

  // ---- 1. Gán giọng ------------------------------------------------------
  // Chỉ tính người nói THẬT SỰ có câu trong bản dịch: transcriptInfo.speakers là
  // của cả transcript, mà người dùng có thể đã xóa hết câu của một người khi
  // sửa tay - gán giọng cho một người không nói câu nào chỉ tổ chiếm mất giọng.
  const speakers = (meta.transcriptInfo?.diarized ? meta.transcriptInfo.speakers : []).filter(
    (s) => meta.cues.some((c) => (c.speaker ?? "") === s),
  );

  let speakerF0: Record<string, number> = { ...(meta.dubInfo?.speakerF0 ?? {}) };
  if (speakers.some((s) => !(speakerF0[s] > 0))) {
    ctx.progress(1, "Đo cao độ giọng của từng người nói trong video gốc");
    const measured = await measureSpeakerF0({
      videoAbs,
      cues: meta.cues,
      workDir: path.join(dubDir, "probe"),
      onLog: (line) => ctx.log(line),
      isCanceled: () => ctx.isCanceled(),
    });
    speakerF0 = { ...speakerF0, ...measured };
    fs.rmSync(path.join(dubDir, "probe"), { recursive: true, force: true });
  }

  const voices = await loadVoiceCatalog(meta.dub.engine);
  const assignments = autoAssignVoices(speakers, {
    engine: meta.dub.engine,
    voices,
    speakerF0,
    // Lựa chọn của người dùng thắng gán tự động - xem ghi chú ở DubSettings
    locked: meta.dub.voices,
    defaultVoice: DEFAULT_TTS_VOICE,
  });
  for (const a of assignments) {
    const who = a.speaker ? `người nói "${a.speaker}"` : "cả video";
    const f0 = speakerF0[a.speaker];
    ctx.log(`[dub] ${who} -> giọng ${a.voice}${f0 ? ` (gốc ${f0} Hz)` : ""}`);
  }
  // Ghi ngược vào meta để UI hiện đúng giọng đang dùng và sửa đè được lần sau
  const chosen: Record<string, string> = {};
  for (const a of assignments) chosen[a.speaker] = a.voice;
  patchTranslateVideo(id, { dub: { ...meta.dub, voices: chosen } });

  // ---- 2. Đọc từng câu + co cho vừa --------------------------------------
  const signature = dubSignature({
    // PHẢI là chữ đọc: ký theo chữ phụ đề thì đổi riêng ngôn ngữ lồng tiếng sẽ
    // ra cùng vân tay và hệ thống dùng lại track cũ - người dùng đổi ngôn ngữ
    // mà video vẫn nói tiếng cũ, không một dòng lỗi nào.
    cues: speechCues,
    assignments,
    engine: meta.dub.engine,
    model: meta.dub.model,
    language,
  });
  const dubWavAbs = dubWavPathOf(id);
  const durationSec = meta.source.durationSec ?? lastCueEnd(meta.cues);

  if (meta.dubInfo?.signature === signature && fs.existsSync(dubWavAbs)) {
    ctx.log(
      `[dub] bản dịch/giọng/engine không đổi so với lần trước - dùng lại track đã có ` +
        `(${meta.dubInfo.cues} câu), không đọc lại`,
    );
  } else {
    // Dọn cue cũ: số câu lần này có thể ít hơn, để lại cue-081.wav của lần
    // trước thì lần sau soi lỗi bằng mắt sẽ nhìn nhầm file mồ côi
    for (const name of fs.readdirSync(dubDir)) {
      if (/^cue-\d+\.wav$/.test(name)) fs.rmSync(path.join(dubDir, name), { force: true });
    }
    ctx.log(
      `[dub] đọc ${meta.cues.length} câu bằng engine ${meta.dub.engine} (${language}) - ` +
        `mỗi câu một lượt gọi để đo và co riêng từng câu`,
    );
    const res = await synthesizeDub({
      cues: speechCues,
      assignments,
      engine: meta.dub.engine,
      model: meta.dub.model,
      language,
      durationSec,
      dubDir,
      outWavAbs: dubWavAbs,
      onProgress: (done, total) =>
        ctx.progress(
          2 + ((DUB_PROGRESS_SHARE - 6) * done) / total,
          `Lồng tiếng câu ${done}/${total}`,
        ),
      onLog: (line) => ctx.log(line),
      isCanceled: () => ctx.isCanceled(),
    });
    patchTranslateVideo(id, {
      dubInfo: {
        file: toRepoRel(res.wavAbs),
        durationSec: res.durationSec,
        cues: res.cues.length,
        stretched: res.stretched,
        overflowed: res.overflowed,
        clipped: res.clipped,
        minTempo: res.minTempo,
        maxTempo: res.maxTempo,
        assignments: res.assignments as DubVoiceAssignment[],
        speakerF0,
        signature,
        createdAt: nowIso(),
      },
    });
  }

  // ---- 3. Tiếng gốc chạy nhỏ bên dưới (tùy chọn) -------------------------
  if (!meta.dub.keepOriginal) return dubWavAbs;
  const mixAbs = dubMixPathOf(id);
  ctx.progress(DUB_PROGRESS_SHARE - 3, "Trộn tiếng gốc chạy nhỏ dưới giọng lồng");
  await mixOriginalUnder({
    dubWavAbs,
    videoAbs,
    originalVolume: meta.dub.originalVolume,
    durationSec,
    workDir: dubDir,
    outWavAbs: mixAbs,
    isCanceled: () => ctx.isCanceled(),
  });
  ctx.log(`[dub] giữ tiếng gốc ở mức ${meta.dub.originalVolume} dưới giọng lồng`);
  return mixAbs;
}

/** Một câu phụ đề trong props Remotion - mốc là FRAME TUYỆT ĐỐI trên timeline */
interface SubtitleProp {
  from: number;
  durationInFrames: number;
  text: string;
}

interface TranslateProps {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  status: string;
  scenes: Array<Record<string, unknown> & { muted: boolean }>;
  audio: { voice: string | null; sfx: never[]; music: null };
  captions: never[];
  overlays: never[];
  watermark: null;
  output: null;
  subtitles: SubtitleProp[];
  subtitleStyle: SubtitleStyle;
}

/**
 * props.resolved.json cho composition "Assemble": đúng một scene là video nguồn,
 * không sfx, không logo.
 *
 * Hai chế độ khác nhau đúng ở khâu TIẾNG và khâu CHỮ, ngược nhau hoàn toàn:
 *  - "subtitle": giữ tiếng gốc (muted=false), không voice, đốt chữ dịch lên hình.
 *  - "dub"     : TẮT tiếng gốc của clip (muted=true) và cho track lồng tiếng vào
 *    `audio.voice` - track đó đã dài đúng bằng video và, nếu người dùng muốn giữ
 *    không khí gốc, đã trộn sẵn tiếng gốc chạy nhỏ bên trong (xem
 *    mixOriginalUnder). KHÔNG để clip tự phát tiếng gốc rồi chồng thêm giọng
 *    lồng lên: hai lớp tiếng cùng nói một nội dung là thứ khó nghe nhất.
 *    Cũng KHÔNG đốt phụ đề: đã nghe được bằng tiếng của mình thì chữ chỉ che hình.
 *
 * manifestSchema bên Remotion là looseObject nên field lạ đi qua được: nếu bản
 * Remotion trên máy chưa có SubtitleTrack thì video vẫn render ra, chỉ là không
 * có chữ - không bao giờ chết giữa chừng vì props.
 */
function buildProps(
  meta: TranslateVideoMeta,
  stagedRel: string,
  voiceRel: string | null,
): TranslateProps {
  const fps = pickFps(meta.source.fps);
  const { width, height } = pickSize(meta.source);
  const durationSec = meta.source.durationSec ?? lastCueEnd(meta.cues);
  const durationInFrames = Math.max(1, Math.round(durationSec * fps));
  const dubbing = wantsDub(meta.mode) && voiceRel !== null;

  return {
    id: meta.id,
    name: meta.name,
    width,
    height,
    fps,
    status: "rendering",
    scenes: [
      {
        id: "source",
        srcVideo: stagedRel,
        from: 0,
        durationInFrames,
        // Ghép phụ đề mà tắt tiếng là ra video câm; lồng tiếng mà giữ tiếng gốc
        // là hai người nói chồng lên nhau
        muted: dubbing,
        srcImage: null,
      },
    ],
    audio: { voice: dubbing ? voiceRel : null, sfx: [], music: null },
    captions: [],
    overlays: [],
    watermark: null,
    output: null,
    // Chữ theo CHẾ ĐỘ, không theo "có lồng tiếng hay không": mode "both" vừa
    // thay tiếng vừa đốt chữ, nên điều kiện phải hỏi wantsSubtitle.
    subtitles: wantsSubtitle(meta.mode)
      ? toSubtitleProps(meta.cues, fps, durationInFrames)
      : [],
    // Gửi nguyên bộ: SubtitleTrack tự nhân theo đơn vị tỉ lệ `u` của nó (dọc
    // chuẩn hóa theo cao 1920, ngang theo cao 1080)
    subtitleStyle: meta.subtitleStyle,
  };
}

/**
 * Giây -> FRAME TUYỆT ĐỐI, đúng cách sfx `atFrame` làm: round(sec * fps). Một
 * hệ quy chiếu duy nhất cho cả timeline thì soi bằng mắt mới ra được lỗi lệch.
 * Cue vượt quá cuối video bị kẹp lại - Remotion không vẽ ngoài composition.
 */
function toSubtitleProps(
  cues: TranslatedCue[],
  fps: number,
  totalFrames: number,
): SubtitleProp[] {
  const out: SubtitleProp[] = [];
  for (const cue of cues) {
    const from = Math.max(0, Math.round(cue.start * fps));
    if (from >= totalFrames) continue;
    const end = Math.min(totalFrames, Math.round(cue.end * fps));
    const durationInFrames = Math.max(1, end - from);
    out.push({ from, durationInFrames, text: cue.text });
  }
  return out;
}

/**
 * fps làm tròn về số nguyên: nguồn 29,97 giữ nguyên sẽ làm mọi phép đổi
 * giây -> frame ra số lẻ và lệch dần về cuối video. Thời lượng KHÔNG đổi vì
 * Remotion cắt footage theo GIÂY (from/to), fps chỉ là nhịp lấy mẫu.
 */
function pickFps(raw: number | null): number {
  const fps = raw && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 30;
  return Math.min(120, Math.max(1, fps));
}

/** Kích thước đầu ra = kích thước nguồn, ép về số chẵn (H.264 yêu cầu) */
function pickSize(source: { width: number | null; height: number | null }): {
  width: number;
  height: number;
} {
  const even = (v: number | null, fallback: number): number => {
    const n = v && Number.isFinite(v) && v > 0 ? v : fallback;
    return Math.max(2, Math.round(n / 2) * 2);
  };
  return {
    width: even(source.width, FALLBACK_WIDTH),
    height: even(source.height, FALLBACK_HEIGHT),
  };
}

/** Video chưa đo được thời lượng - lấy mốc cue cuối làm giới hạn dưới */
function lastCueEnd(cues: TranslatedCue[]): number {
  let max = 0;
  for (const c of cues) max = Math.max(max, c.end);
  return max;
}
