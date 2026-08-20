import fs from "node:fs";
import path from "node:path";
import {
  analyzeSilence,
  applyTrim,
  remapWordTimestamps,
  toKeepRanges,
  verifyTrim,
  TRIM_PROFILES,
  type SilenceRange,
  type TrimAggressiveness,
  type TrimAnalysis,
  type TrimVerification,
  type WordSpan,
} from "../autoTrim.js";
import { repoRoot } from "../config.js";
import { updateJob } from "../db.js";
import { findDeadWeight, type DeadWeightReport } from "../deadWeight.js";
import { briefOf, projectAssetsDirOf, projectDirOf, readMeta } from "../meta.js";
import type { JobCtx } from "../queue.js";
import { HttpError, ensureDir, fileKind, ffprobeDurationMs, nowIso, toRepoRel } from "../util.js";

/**
 * Job "auto-trim" - cắt khoảng lặng + mỡ thừa ĐÃ DUYỆT của một video project.
 *
 * Chia vai rõ ràng với hai module đo đạc (KHÔNG sửa chúng, chỉ gọi):
 *  - `autoTrim.ts`  : đo bằng máy - chọn ngưỡng dB theo từng file, dựng danh sách
 *                     khoảng cắt, cắt một lượt ffmpeg, dời mốc transcript, nghiệm thu.
 *  - `deadWeight.ts`: đọc transcript sinh ỨNG VIÊN mỡ thừa (từ đệm, vấp, nói lại)
 *                     một cách tất định. Việc DUYỆT từng ứng viên là của người/AI -
 *                     job này chỉ nhận danh sách đã duyệt qua `cutCandidates`.
 *
 * File này cũng là nơi đặt các hàm dùng chung với `routes/autoTrim.ts` (dò video
 * nguồn, đọc transcript, chạy phân tích). Đặt ở ĐÂY chứ không phải ở route vì
 * route import `queue.js` (runtime) còn queue lại import file job này - để hàm
 * chung bên route sẽ tạo vòng import thật; job chỉ import KIỂU JobCtx nên không.
 */

// ---------------------------------------------------------------------------
// Hằng số
// ---------------------------------------------------------------------------

/**
 * Transcript của file NGUỒN, theo đúng thứ tự ưu tiên.
 *
 * CỐ Ý KHÔNG dùng `readProjectTranscript` của transcript.ts: hàm đó ưu tiên
 * `transcript.final.json` / `transcript.cut.json` - những bản đã DỜI MỐC sang hệ
 * thời gian của file ĐÃ CẮT. Lấy nhầm bản đó làm hàng rào cho file gốc thì mọi
 * mốc chữ đều lệch, và hàng rào quay ra bảo vệ nhầm chỗ.
 */
const SOURCE_TRANSCRIPT_RELS = ["assets/transcript.raw.json", "assets/transcript.json"];

/** Tên file báo cáo trong assets/ - AI và web UI đều đọc thẳng file này */
const REPORT_REL = "assets/auto-trim-report.json";

/** Transcript đã dời mốc sang hệ thời gian của file đã cắt */
const CUT_TRANSCRIPT_REL = "assets/transcript.cut.json";

// ---------------------------------------------------------------------------
// Yêu cầu cắt - cầu nối giữa route và job
// ---------------------------------------------------------------------------

export interface TrimRequest {
  /** Job nào được phép dùng yêu cầu này - chống dùng nhầm yêu cầu cũ còn sót */
  jobId: string;
  /** Đường dẫn video nguồn tính từ thư mục project (đã qua hàng rào traversal) */
  sourceRel: string;
  level: TrimAggressiveness;
  /** Ứng viên mỡ thừa đã được người/AI DUYỆT - job không tự duyệt hộ */
  cutCandidates: Array<{ start: number; end: number }>;
  createdAt: string;
}

/** File yêu cầu nằm cạnh meta.json/qc.json, không nhét vào assets/ cho khỏi lẫn với asset thật */
function requestPathOf(projectId: string): string {
  return path.join(projectDirOf(projectId), "auto-trim-request.json");
}

export function writeTrimRequest(projectId: string, req: TrimRequest): void {
  fs.writeFileSync(requestPathOf(projectId), JSON.stringify(req, null, 2) + "\n", "utf8");
}

/**
 * Đọc yêu cầu RỒI XÓA. Xóa ngay vì file này chỉ có giá trị cho đúng một job:
 * để lại thì một job auto-trim tạo tay qua POST /api/jobs sau đó sẽ âm thầm cắt
 * theo danh sách ứng viên của lần trước - kiểu lỗi không ai lần ra được.
 */
function takeTrimRequest(projectId: string, jobId: string): TrimRequest | null {
  const file = requestPathOf(projectId);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // chưa có yêu cầu (job tạo tay) hoặc file hỏng - dùng mặc định
  }
  fs.rmSync(file, { force: true });
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<TrimRequest>;
  if (r.jobId !== jobId) return null; // yêu cầu của job khác - không đụng vào
  return {
    jobId,
    sourceRel: typeof r.sourceRel === "string" ? r.sourceRel : "",
    level: (r.level ?? "default") as TrimAggressiveness,
    cutCandidates: Array.isArray(r.cutCandidates) ? r.cutCandidates : [],
    createdAt: typeof r.createdAt === "string" ? r.createdAt : nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Video nguồn
// ---------------------------------------------------------------------------

/**
 * Đường dẫn client đưa vào -> tuyệt đối, BẮT BUỘC nằm trong thư mục project.
 *
 * `path.resolve` tự nuốt "../" nên phải kiểm tra lại tiền tố SAU khi resolve
 * (giống resolveInRepo của routes/qc.ts, chỉ đổi gốc từ repo sang project).
 * Chấp nhận cả hai lối viết mà agent hay dùng: tính từ thư mục project
 * ("assets/face.mp4") và tính từ repo root ("video-projects/<id>/assets/face.mp4").
 */
function resolveInProject(projectId: string, rel: string): string {
  const root = path.resolve(projectDirOf(projectId));
  const inside = (abs: string): boolean => abs === root || abs.startsWith(root + path.sep);

  const fromProject = path.resolve(root, rel);
  if (inside(fromProject) && fs.existsSync(fromProject)) return fromProject;

  const fromRepo = path.resolve(repoRoot, rel);
  if (inside(fromRepo) && fs.existsSync(fromRepo)) return fromRepo;

  if (!inside(fromProject) && !inside(fromRepo)) {
    throw new HttpError(
      400,
      "PATH_OUTSIDE_PROJECT",
      `Đường dẫn "${rel}" nằm ngoài thư mục project "${projectId}"`,
    );
  }
  throw new HttpError(404, "TRIM_SOURCE_NOT_FOUND", `Không thấy video nguồn "${rel}"`);
}

/**
 * Video nguồn mặc định của project.
 *
 * Thứ tự: `assets/face.*` (tên quy ước của bản talking-head trong pipeline) rồi
 * tới file video LỚN NHẤT nằm ngay trong `assets/`. Bỏ qua mọi file `*.cut.*` -
 * đó chính là SẢN PHẨM của bước này; cắt tiếp trên nó là encode lần hai, mất
 * chất mà không thu thêm được gì (bản đã cắt gần như không còn khoảng lặng).
 */
function pickDefaultSource(projectId: string): string | null {
  const assetsDir = projectAssetsDirOf(projectId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(assetsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const videos: Array<{ abs: string; name: string; size: number }> = [];
  for (const e of entries) {
    if (!e.isFile() || fileKind(e.name) !== "video") continue;
    if (/\.cut\./i.test(e.name)) continue;
    const abs = path.join(assetsDir, e.name);
    try {
      videos.push({ abs, name: e.name, size: fs.statSync(abs).size });
    } catch {
      /* file biến mất giữa chừng - bỏ qua */
    }
  }
  if (videos.length === 0) return null;
  const face = videos.find((v) => /^face\./i.test(v.name));
  if (face) return face.abs;
  return videos.sort((a, b) => b.size - a.size)[0].abs;
}

/** Video nguồn để cắt - ném HttpError 400/404 đúng hợp đồng của route */
export function resolveTrimSource(projectId: string, source?: string | null): string {
  const rel = typeof source === "string" ? source.trim() : "";
  if (rel) return resolveInProject(projectId, rel);
  const picked = pickDefaultSource(projectId);
  if (!picked) {
    throw new HttpError(
      404,
      "TRIM_SOURCE_NOT_FOUND",
      `Project "${projectId}" không có video nguồn trong assets/ (bỏ qua các bản *.cut.*). ` +
        "Truyền `source` để chỉ đúng file cần cắt.",
    );
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface SourceTranscript {
  /** Đường dẫn tương đối repo - để báo cáo/log nói rõ đã dùng bản nào */
  relPath: string;
  absPath: string;
  /** JSON nguyên vẹn (mọi field lạ giữ nguyên để remapWordTimestamps sao lại) */
  json: unknown;
  /** Chữ đã dàn phẳng - hàng rào truyền cho analyzeSilence/verifyTrim */
  words: WordSpan[];
}

/**
 * Dàn phẳng transcript thành danh sách chữ có mốc.
 *
 * Segment KHÔNG kèm word timestamp thì lấy nguyên khoảng của segment làm một
 * "chữ" dài. Nghiêng về phía dè dặt có chủ ý: vùng được coi là có tiếng nói rộng
 * ra, hàng rào cắt ít đi. Thà bỏ sót một khoảng lặng còn hơn nuốt một chữ.
 */
function flattenWords(json: unknown): WordSpan[] {
  const out: WordSpan[] = [];
  const segments =
    Array.isArray(json)
      ? json
      : json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).segments)
        ? ((json as Record<string, unknown>).segments as unknown[])
        : [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  for (const rawSeg of segments) {
    if (!rawSeg || typeof rawSeg !== "object") continue;
    const seg = rawSeg as Record<string, unknown>;
    const words = Array.isArray(seg.words) ? seg.words : [];
    let added = 0;
    for (const rawWord of words) {
      if (!rawWord || typeof rawWord !== "object") continue;
      const w = rawWord as Record<string, unknown>;
      const start = num(w.start);
      const end = num(w.end);
      if (start === null || end === null || end <= start) continue;
      out.push({ start, end });
      added++;
    }
    if (added > 0) continue;
    const ss = num(seg.start);
    const se = num(seg.end);
    if (ss !== null && se !== null && se > ss) out.push({ start: ss, end: se });
  }
  return out;
}

/** Transcript của file NGUỒN - null khi project chưa có bản nào đọc được */
export function readSourceTranscript(projectId: string): SourceTranscript | null {
  const dir = projectDirOf(projectId);
  for (const rel of SOURCE_TRANSCRIPT_RELS) {
    const abs = path.join(dir, ...rel.split("/"));
    if (!fs.existsSync(abs)) continue;
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
      continue; // file hỏng - thử ứng viên kế tiếp
    }
    const words = flattenWords(json);
    if (words.length === 0) continue; // không có mốc nào thì làm hàng rào cũng vô nghĩa
    return { relPath: toRepoRel(abs), absPath: abs, json, words };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phân tích (dùng chung cho route /analyze và bước đầu của job /apply)
// ---------------------------------------------------------------------------

export interface TrimAnalyzeResult {
  /** Video đã đo, đường dẫn tương đối repo */
  source: string;
  /** Transcript đã dùng làm hàng rào - null = không có, kết quả kém tin cậy hơn hẳn */
  transcript: string | null;
  /** Có hàng rào transcript không - QUYẾT ĐỊNH mức tin cậy của cả hai báo cáo dưới */
  guarded: boolean;
  silence: TrimAnalysis;
  deadWeight: DeadWeightReport;
  note: string;
}

/**
 * Đo khoảng lặng + dò mỡ thừa. KHÔNG encode gì, không đụng vào file nào của
 * project (chỉ bóc một WAV tạm trong thư mục tạm rồi tự dọn) - nhờ vậy gọi lại
 * bao nhiêu lần cũng được, kể cả giữa phiên edit.
 */
export async function analyzeProjectTrim(input: {
  projectId: string;
  sourceAbs: string;
  level: TrimAggressiveness;
  isCanceled?: () => boolean;
}): Promise<TrimAnalyzeResult> {
  const t = readSourceTranscript(input.projectId);
  const silence = await analyzeSilence(input.sourceAbs, input.level, {
    isCanceled: input.isCanceled,
    // Hàng rào chữ là TOÀN BỘ lý do route này tồn tại: mức âm thanh một mình
    // không phân biệt được "đang nghỉ" với "đang nói nhỏ" (đo trên bản gốc:
    // 30,4s trong 48,6s mà ffmpeg gọi là lặng thật ra nằm bên trong chữ).
    ...(t ? { words: t.words } : {}),
  });
  const deadWeight = findDeadWeight(t?.json ?? null);
  return {
    source: toRepoRel(input.sourceAbs),
    transcript: t?.relPath ?? null,
    guarded: !!t,
    silence,
    deadWeight,
    note: t
      ? `Có hàng rào transcript (${t.relPath}, ${t.words.length} mốc chữ) - chỉ khoảng TRỐNG GIỮA CHỮ mới được cắt.`
      : "KHÔNG có transcript (đã tìm " +
        SOURCE_TRANSCRIPT_RELS.join(", ") +
        ") - đo bằng mức âm thanh một mình, con số này không đáng tin theo cả hai chiều và " +
        "danh sách mỡ thừa rỗng. Bóc băng trước rồi phân tích lại.",
  };
}

// ---------------------------------------------------------------------------
// Gộp khoảng cắt
// ---------------------------------------------------------------------------

/** Gộp khoảng chồng/liền nhau rồi sắp xếp - ffmpeg trim không chịu được khoảng chồng */
export function mergeCutRanges(ranges: Array<{ start: number; end: number }>): SilenceRange[] {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: Math.max(0, r.start), end: r.end, duration: 0 }))
    .sort((a, b) => a.start - b.start);
  const out: SilenceRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    out.push({ ...r });
  }
  for (const r of out) r.duration = round3(r.end - r.start);
  return out;
}

/**
 * Lưới an toàn cuối cùng: bỏ mọi khoảng cắt chứa TRUNG ĐIỂM của một chữ.
 *
 * `autoTrim.ts` có đúng lưới này (`guardMidpoints`) nhưng KHÔNG export nó, mà
 * file đó thì không được sửa - nên dựng lại y hệt ở đây. Bắt buộc phải có: ứng
 * viên trong `cutCandidates` đến thẳng từ bước duyệt của người/AI, chưa hề đi
 * qua hàng rào chữ của analyzeSilence; duyệt nhầm một ứng viên đè lên chữ thật
 * mà không có lưới này thì lời nói bị nuốt.
 *
 * Lấy TRUNG ĐIỂM chứ không lấy hai mép: mép chữ do bộ bóc băng đoán, sai vài
 * chục ms là bình thường - loại theo mép sẽ gạt oan gần hết ứng viên hợp lệ.
 */
export function guardWordMidpoints(
  cuts: SilenceRange[],
  words: WordSpan[],
): { kept: SilenceRange[]; dropped: SilenceRange[] } {
  if (words.length === 0) return { kept: cuts, dropped: [] };
  const mids = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .map((w) => (w.start + w.end) / 2)
    .sort((a, b) => a - b);
  const kept: SilenceRange[] = [];
  const dropped: SilenceRange[] = [];
  for (const c of cuts) {
    if (mids.some((m) => m >= c.start && m <= c.end)) dropped.push(c);
    else kept.push(c);
  }
  return { kept, dropped };
}

/**
 * Phần bù của danh sách cắt = các đoạn GIỮ LẠI. Dùng thẳng bản của autoTrim.ts,
 * không chép lại: hai bản khác nhau một chút ở MIN_PIECE_SEC là ra hai kết quả
 * cắt khác nhau mà không ai thấy.
 */
export { toKeepRanges };

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function totalSec(ranges: Array<{ start: number; end: number }>): number {
  return ranges.reduce((s, r) => s + (r.end - r.start), 0);
}

// ---------------------------------------------------------------------------
// Báo cáo
// ---------------------------------------------------------------------------

export interface AutoTrimReport {
  createdAt: string;
  jobId: string;
  level: TrimAggressiveness;
  profile: TrimAnalysis["profile"];
  /** Đường dẫn tương đối repo */
  source: string;
  /** null = không cắt được gì nên KHÔNG sinh file mới, các bước sau dùng lại source */
  output: string | null;
  transcript: { source: string | null; cut: string | null; guarded: boolean };
  duration: { beforeSec: number; afterSec: number | null; removedSec: number };
  /**
   * Bóc tách số giây đã bỏ. `silenceSec` = phần do máy đo, `approvedSec` = phần
   * CỘNG THÊM nhờ ứng viên đã duyệt (đã trừ chỗ chồng lấn với khoảng lặng, nên
   * hai số cộng lại đúng bằng tổng, không đếm hai lần).
   */
  removed: { silenceSec: number; approvedSec: number; ranges: number };
  threshold: { db: number; noiseFloorDb: number; note: string };
  candidates: {
    approved: number;
    /** Ứng viên bị lưới trung điểm chặn - duyệt nhầm chỗ có tiếng nói */
    rejected: Array<{ start: number; end: number }>;
  };
  verification: TrimVerification & { measuredOn: string; guarded: boolean };
  verdict: "pass" | "fail";
  note: string;
}

function reportPathOf(projectId: string): string {
  return path.join(projectDirOf(projectId), ...REPORT_REL.split("/"));
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export async function runAutoTrim(ctx: JobCtx): Promise<void> {
  const projectId = ctx.job.projectId;
  const projectDir = projectDirOf(projectId);
  const req = takeTrimRequest(projectId, ctx.job.id);
  const brief = briefOf(readMeta(projectId));

  // Thứ tự ưu tiên mức mạnh tay: yêu cầu của lần gọi -> sceneId của job (route
  // ghi mức vào đó để nhìn hàng đợi là biết) -> brief của project.
  const level: TrimAggressiveness =
    req?.level ??
    (ctx.job.sceneId && ctx.job.sceneId in TRIM_PROFILES
      ? (ctx.job.sceneId as TrimAggressiveness)
      : brief.autoCutLevel);
  const sourceAbs = resolveTrimSource(projectId, req?.sourceRel ?? null);
  const approved = mergeCutRanges(req?.cutCandidates ?? []);

  ctx.log(`[trim] Nguồn: ${toRepoRel(sourceAbs)}`);
  ctx.log(
    `[trim] Mức "${level}" - khoảng lặng >= ${TRIM_PROFILES[level].minSilenceSec}s, ` +
      `chừa ${TRIM_PROFILES[level].padSec}s mỗi mép, trần còn lại ${TRIM_PROFILES[level].maxResidualSec}s.`,
  );
  ctx.log(
    approved.length > 0
      ? `[trim] Nhận ${approved.length} khoảng mỡ thừa ĐÃ DUYỆT (${totalSec(approved).toFixed(2)}s).`
      : "[trim] Không có ứng viên mỡ thừa nào được duyệt - chỉ cắt khoảng lặng đo được.",
  );

  // ---- 1. Đo -------------------------------------------------------------
  ctx.progress(5, "Đo khoảng lặng");
  const analysis = await analyzeProjectTrim({
    projectId,
    sourceAbs,
    level,
    isCanceled: () => ctx.isCanceled(),
  });
  const words = readSourceTranscript(projectId)?.words ?? [];
  ctx.log(`[trim] ${analysis.note}`);
  ctx.log(
    `[trim] Ngưỡng ${analysis.silence.thresholdDb}dB, nền nhiễu ${analysis.silence.noiseFloorDb}dB. ` +
      `${analysis.silence.thresholdNote ?? ""}`,
  );
  ctx.log(
    `[trim] Máy đo được ${analysis.silence.silences.length} khoảng lặng đáng cắt ` +
      `(${analysis.silence.removedSec.toFixed(2)}s / ${analysis.silence.durationSec.toFixed(2)}s).`,
  );
  if (ctx.isCanceled()) return;

  // ---- 2. Gộp khoảng lặng + ứng viên đã duyệt -----------------------------
  ctx.progress(40, "Gộp khoảng cắt");
  const silenceCuts = mergeCutRanges(analysis.silence.silences);
  const guardedApproved = guardWordMidpoints(approved, words);
  if (guardedApproved.dropped.length > 0) {
    ctx.log(
      `[trim] LOẠI ${guardedApproved.dropped.length} ứng viên đã duyệt vì đè lên TRUNG ĐIỂM của chữ ` +
        `(cắt vào là nuốt lời nói): ` +
        guardedApproved.dropped
          .map((r) => `${r.start.toFixed(2)}-${r.end.toFixed(2)}s`)
          .join(", "),
    );
  }
  const allCuts = mergeCutRanges([...silenceCuts, ...guardedApproved.kept]);
  const silenceSec = round3(totalSec(silenceCuts));
  const approvedSec = round3(Math.max(0, totalSec(allCuts) - silenceSec));
  const beforeSec = analysis.silence.durationSec;
  const keepRanges = toKeepRanges(allCuts, beforeSec);
  ctx.log(
    `[trim] Tổng ${allCuts.length} khoảng sẽ cắt = ${totalSec(allCuts).toFixed(2)}s ` +
      `(khoảng lặng ${silenceSec.toFixed(2)}s + mỡ thừa đã duyệt ${approvedSec.toFixed(2)}s), ` +
      `giữ lại ${keepRanges.length} đoạn.`,
  );

  // ---- 3. Cắt -------------------------------------------------------------
  ctx.progress(50, "Cắt video");
  const stem = path.basename(sourceAbs, path.extname(sourceAbs));
  const outAbs = path.join(projectAssetsDirOf(projectId), `${stem}.cut.mp4`);
  if (path.resolve(outAbs) === path.resolve(sourceAbs)) {
    throw new Error(
      `File đích trùng file nguồn (${toRepoRel(outAbs)}) - từ chối cắt đè lên chính bản gốc.`,
    );
  }
  ensureDir(path.dirname(outAbs));
  // Xóa bản cũ TRƯỚC khi cắt: applyTrim không tạo file khi không có gì để cắt,
  // còn sót bản cũ thì bước sau tưởng nhầm là vừa cắt xong.
  if (fs.existsSync(outAbs)) {
    fs.rmSync(outAbs, { force: true });
    ctx.log(`[trim] Đã xóa bản cắt cũ ${toRepoRel(outAbs)} trước khi cắt lại.`);
  }
  await applyTrim(sourceAbs, keepRanges, outAbs, {
    isCanceled: () => ctx.isCanceled(),
    onLog: (line) => ctx.log(line),
  });
  if (ctx.isCanceled()) return;
  const cut = fs.existsSync(outAbs);
  if (!cut) {
    ctx.log(
      "[trim] Không có gì đáng cắt - GIỮ NGUYÊN file gốc, không sinh bản .cut.mp4 " +
        "(encode lại một bản y hệt chỉ làm giảm chất).",
    );
  }

  // ---- 4. Dời mốc transcript ---------------------------------------------
  ctx.progress(80, "Dời mốc transcript");
  const src = readSourceTranscript(projectId);
  let cutTranscriptRel: string | null = null;
  let cutWords: WordSpan[] = words;
  if (src && cut) {
    const remapped = remapWordTimestamps(src.json, keepRanges);
    const cutAbs = path.join(projectDir, ...CUT_TRANSCRIPT_REL.split("/"));
    ensureDir(path.dirname(cutAbs));
    fs.writeFileSync(cutAbs, JSON.stringify(remapped, null, 2) + "\n", "utf8");
    cutTranscriptRel = toRepoRel(cutAbs);
    cutWords = flattenWords(remapped);
    ctx.log(
      `[trim] Đã dời mốc transcript sang hệ thời gian bản cắt: ${cutTranscriptRel} ` +
        `(${words.length} -> ${cutWords.length} mốc chữ).`,
    );
  } else if (src && !cut) {
    // Không cắt gì thì transcript gốc VẪN ĐÚNG - ghi thêm một bản .cut.json y
    // hệt chỉ tạo ra một nguồn sự thật thứ hai để lệch nhau về sau.
    ctx.log("[trim] Không cắt gì nên transcript gốc vẫn đúng - không ghi transcript.cut.json.");
  } else {
    ctx.log("[trim] Không có transcript để dời mốc.");
  }

  // ---- 5. Nghiệm thu ------------------------------------------------------
  ctx.progress(88, "Nghiệm thu bản đã cắt");
  const measuredAbs = cut ? outAbs : sourceAbs;
  const verification = await verifyTrim(measuredAbs, level, {
    isCanceled: () => ctx.isCanceled(),
    // PHẢI là chữ của CHÍNH file vừa đo (đã dời mốc). Truyền bản gốc vào đây là
    // chấm bằng một cái thước khác cái thước đã dùng để cắt.
    ...(cutWords.length > 0 ? { words: cutWords } : {}),
  });
  if (ctx.isCanceled()) return;

  const afterMs = await ffprobeDurationMs(measuredAbs);
  const afterSec = afterMs === null ? null : round3(afterMs / 1000);

  // ---- 6. Báo cáo ---------------------------------------------------------
  const verdict: "pass" | "fail" = verification.pass ? "pass" : "fail";
  const report: AutoTrimReport = {
    createdAt: nowIso(),
    jobId: ctx.job.id,
    level,
    profile: analysis.silence.profile,
    source: toRepoRel(sourceAbs),
    output: cut ? toRepoRel(outAbs) : null,
    transcript: {
      source: analysis.transcript,
      cut: cutTranscriptRel,
      guarded: analysis.guarded,
    },
    duration: {
      beforeSec,
      afterSec,
      removedSec: afterSec === null ? round3(totalSec(allCuts)) : round3(beforeSec - afterSec),
    },
    removed: { silenceSec, approvedSec, ranges: allCuts.length },
    threshold: {
      db: analysis.silence.thresholdDb,
      noiseFloorDb: analysis.silence.noiseFloorDb,
      note: analysis.silence.thresholdNote ?? "",
    },
    candidates: {
      approved: guardedApproved.kept.length,
      rejected: guardedApproved.dropped.map((r) => ({ start: r.start, end: r.end })),
    },
    verification: {
      ...verification,
      measuredOn: toRepoRel(measuredAbs),
      guarded: cutWords.length > 0,
    },
    verdict,
    note: cut
      ? `Đã cắt ${round3(totalSec(allCuts))}s trong ${allCuts.length} khoảng.`
      : "Không cắt được gì - dùng tiếp file gốc.",
  };
  ensureDir(path.dirname(reportPathOf(projectId)));
  fs.writeFileSync(reportPathOf(projectId), JSON.stringify(report, null, 2) + "\n", "utf8");
  ctx.log(`[trim] Báo cáo: ${toRepoRel(reportPathOf(projectId))}`);

  if (cut) updateJob(ctx.job.id, { outputPath: toRepoRel(outAbs) });

  // Nghiệm thu TRƯỢT thì job vẫn kết thúc bình thường (file cắt ra vẫn dùng
  // được, báo cáo vẫn phải có), nhưng log phải nói thẳng - im lặng cho qua ở
  // đây là đúng cách để một video lê thê lọt tới bước cuối.
  if (verdict === "fail") {
    ctx.log(
      `[trim] ⚠ CHƯA ĐẠT mức "${level}": ${verification.reason ?? "(không có lý do)"}`,
    );
    ctx.log(
      `[trim] ⚠ Còn ${verification.totalSilenceSec.toFixed(2)}s lặng ` +
        `(${(verification.ratio * 100).toFixed(1)}% thời lượng), chỗ dài nhất ${verification.longest.toFixed(2)}s. ` +
        "Kết quả KHÔNG đạt profile - duyệt thêm ứng viên mỡ thừa rồi chạy lại, hoặc chấp nhận có ý thức.",
    );
    ctx.progress(100, `Đã cắt nhưng CHƯA ĐẠT mức "${level}"`);
  } else {
    ctx.log(
      `[trim] Đạt mức "${level}": còn ${verification.totalSilenceSec.toFixed(2)}s lặng ` +
        `(${(verification.ratio * 100).toFixed(1)}%), chỗ dài nhất ${verification.longest.toFixed(2)}s.`,
    );
    ctx.progress(100, "Cắt xong, nghiệm thu đạt");
  }
}
