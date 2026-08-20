import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import {
  CLONE_REF_IDEAL_MAX_SEC,
  CLONE_REF_MAX_SEC,
  CLONE_REF_MIN_SEC,
  type ClonedVoice,
  type TtsGender,
} from "./ttsTypes.js";
import {
  HttpError,
  ensureDir,
  execFileCaptureAll,
  isKebabCase,
  nowIso,
  toKebabAscii,
  toRepoRel,
} from "./util.js";

/**
 * Kho giọng đã nhân bản.
 *
 * Bố cục: `assets/voices/library.json` (mảng ClonedVoice) + mỗi giọng một thư
 * mục `assets/voices/<id>/ref.wav`. Giống hệt lối của thư viện sound effect
 * (routes/sfx.ts) - JSON đọc phòng thủ, hỏng thì coi như rỗng chứ không làm
 * chết cả trang.
 *
 * VÌ SAO GIỮ NGUYÊN FILE MẪU chứ không chỉ giữ embedding: engine phải nạp lại
 * mẫu vào tiến trình Python mỗi lần khởi động (add_voice save=False), và người
 * dùng cần nghe lại được mình đã đưa mẫu nào vào.
 */

/** Tên file mẫu trong mỗi thư mục giọng - cố định để đường dẫn suy ra được từ id */
const REF_NAME = "ref.wav";

/** Sample rate chuẩn hóa - bằng OUT_SAMPLE_RATE của pipeline nên không phải resample lần nữa */
const REF_SAMPLE_RATE = 48_000;

const MAX_NAME_CHARS = 80;
const MAX_NOTE_CHARS = 500;

const GENDERS: TtsGender[] = ["nam", "nu", "trung-tinh"];

const libraryPath = (): string => path.join(paths.voicesDir, "library.json");

// ---------------------------------------------------------------------------
// Đọc / ghi library.json
// ---------------------------------------------------------------------------

function parseGender(v: unknown): TtsGender {
  return GENDERS.includes(v as TtsGender) ? (v as TtsGender) : "trung-tinh";
}

/** Đọc nguyên kho, KHÔNG lọc theo file có tồn tại - dùng cho sửa/xóa */
function readLibrary(): ClonedVoice[] {
  try {
    const raw = JSON.parse(fs.readFileSync(libraryPath(), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        id: typeof e.id === "string" ? e.id : "",
        name: typeof e.name === "string" ? e.name : "",
        gender: parseGender(e.gender),
        note: typeof e.note === "string" ? e.note : "",
        refFile: typeof e.refFile === "string" ? e.refFile : "",
        refDurationSec: typeof e.refDurationSec === "number" ? e.refDurationSec : 0,
        createdAt: typeof e.createdAt === "string" ? e.createdAt : nowIso(),
        updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : nowIso(),
      }))
      // id phải là kebab-case: id cũng chính là TÊN THƯ MỤC, một bản ghi bị sửa
      // tay thành "../.." mà lọt qua đây là mở đường ghi ra ngoài kho.
      .filter((e) => e.id && isKebabCase(e.id));
  } catch {
    return []; // chưa có library.json -> kho rỗng
  }
}

function writeLibrary(entries: ClonedVoice[]): void {
  ensureDir(paths.voicesDir);
  fs.writeFileSync(libraryPath(), JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/** Đường dẫn tuyệt đối tới file mẫu của một giọng */
export function clonedRefAbs(v: ClonedVoice): string {
  return path.join(paths.voicesDir, v.id, REF_NAME);
}

/**
 * Kho giọng cho UI và cho engine.
 *
 * Chỉ trả giọng CÒN file mẫu: mất mẫu thì không đăng ký lại được vào tiến trình
 * Python, nên hiện nó lên chỉ để người dùng bấm vào rồi gặp lỗi. Bản ghi vẫn
 * nằm trong library.json để còn xóa được.
 */
export function listClonedVoices(): ClonedVoice[] {
  return readLibrary().filter((v) => fs.existsSync(clonedRefAbs(v)));
}

export function getClonedVoice(id: string): ClonedVoice | null {
  return listClonedVoices().find((v) => v.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe
// ---------------------------------------------------------------------------

function noFfmpeg(err: unknown): HttpError {
  return new HttpError(
    503,
    "NO_FFMPEG",
    `Không chạy được ffmpeg - cài FFmpeg và thêm vào PATH. Chi tiết: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

/** Đo thời lượng bằng ffprobe - KHÔNG bao giờ suy ra từ kích thước file */
async function probeSeconds(absFile: string): Promise<number> {
  let r: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    r = await execFileCaptureAll(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absFile],
      { timeoutMs: 20_000 },
    );
  } catch (err) {
    throw noFfmpeg(err);
  }
  const sec = parseFloat(r.stdout.trim());
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new HttpError(
      400,
      "CLONE_REF_UNREADABLE",
      `Không đọc được thời lượng của file mẫu (${path.basename(absFile)}). ` +
        "File có thể hỏng hoặc không phải audio - thử xuất lại dạng WAV/MP3 rồi tải lên.",
    );
  }
  return sec;
}

async function runFfmpeg(args: string[]): Promise<void> {
  let r: Awaited<ReturnType<typeof execFileCaptureAll>>;
  try {
    r = await execFileCaptureAll("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], {
      timeoutMs: 180_000,
    });
  } catch (err) {
    throw noFfmpeg(err);
  }
  if (r.timedOut) throw new Error("ffmpeg chạy quá lâu khi chuẩn hóa file mẫu - đã hủy");
  if (r.code !== 0) {
    const detail = r.stderr.split(/\r?\n/).filter(Boolean).slice(-10).join("\n");
    throw new HttpError(
      400,
      "CLONE_REF_UNREADABLE",
      `ffmpeg không đọc được file mẫu (mã ${r.code}). Thử xuất lại dạng WAV/MP3 rồi tải lên.\n${detail}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tạo / sửa / xóa
// ---------------------------------------------------------------------------

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) {
    throw new HttpError(400, "VOICE_NAME_REQUIRED", "Đặt tên cho giọng trước khi lưu");
  }
  if (name.length > MAX_NAME_CHARS) {
    throw new HttpError(
      400,
      "VOICE_NAME_TOO_LONG",
      `Tên giọng tối đa ${MAX_NAME_CHARS} ký tự (đang ${name.length})`,
    );
  }
  return name;
}

function cleanNote(raw: unknown): string {
  const note = typeof raw === "string" ? raw.trim() : "";
  if (note.length > MAX_NOTE_CHARS) {
    throw new HttpError(
      400,
      "VOICE_NOTE_TOO_LONG",
      `Ghi chú tối đa ${MAX_NOTE_CHARS} ký tự (đang ${note.length})`,
    );
  }
  return note;
}

function cleanGender(raw: unknown): TtsGender {
  if (raw === undefined || raw === null || raw === "") return "trung-tinh";
  if (!GENDERS.includes(raw as TtsGender)) {
    throw new HttpError(400, "INVALID_GENDER", `gender phải là một trong: ${GENDERS.join(", ")}`);
  }
  return raw as TtsGender;
}

/**
 * Sinh id từ tên người dùng đặt.
 *
 * TÊN NGƯỜI DÙNG KHÔNG BAO GIỜ ĐƯỢC THÀNH ĐƯỜNG DẪN: id là tên thư mục, nên
 * phải qua toKebabAscii (bỏ dấu, chỉ còn a-z0-9-) và phải qua được isKebabCase.
 * Tên toàn ký tự lạ ("???") cho ra chuỗi rỗng - lúc đó dùng "giong" làm nền.
 */
function makeId(name: string, taken: Set<string>): string {
  const base = toKebabAscii(name) || "giong";
  if (!isKebabCase(base)) {
    throw new HttpError(400, "INVALID_VOICE_NAME", `Tên giọng không dùng được làm id: "${name}"`);
  }
  let id = base;
  for (let n = 2; taken.has(id) || fs.existsSync(path.join(paths.voicesDir, id)); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

/**
 * Nhân bản một giọng từ file người dùng tải lên.
 *
 * Mọi định dạng đầu vào đều đi qua ffmpeg về WAV 48kHz mono 16-bit: engine đọc
 * mẫu bằng soundfile (xem bản vá torchaudio trong vieneu_worker.py), và 48kHz
 * mono cũng đúng bằng định dạng đầu ra của pipeline.
 *
 * Mẫu dài quá thì CẮT chứ không từ chối: model chỉ dùng phần đầu, người dùng
 * kéo nhầm cả file podcast vào mà bị chặn thẳng thì rất khó chịu.
 */
export async function createClonedVoice(input: {
  name: unknown;
  gender: unknown;
  note: unknown;
  srcAbs: string;
}): Promise<ClonedVoice> {
  const name = cleanName(input.name);
  const gender = cleanGender(input.gender);
  let note = cleanNote(input.note);

  if (!fs.existsSync(input.srcAbs)) {
    throw new HttpError(400, "FILE_REQUIRED", "Không thấy file mẫu vừa tải lên");
  }

  const srcSec = await probeSeconds(input.srcAbs);
  if (srcSec < CLONE_REF_MIN_SEC) {
    throw new HttpError(
      400,
      "CLONE_REF_TOO_SHORT",
      `Mẫu chỉ dài ${srcSec.toFixed(1)}s - cần tối thiểu ${CLONE_REF_MIN_SEC}s. ` +
        `Tốt nhất là ${CLONE_REF_MIN_SEC}-${CLONE_REF_IDEAL_MAX_SEC}s giọng nói sạch, không nhạc nền.`,
    );
  }
  const trimmed = srcSec > CLONE_REF_MAX_SEC;

  const entries = readLibrary();
  const id = makeId(
    name,
    new Set(entries.map((e) => e.id)),
  );
  const dir = path.join(paths.voicesDir, id);
  const refAbs = path.join(dir, REF_NAME);
  ensureDir(dir);

  try {
    await runFfmpeg([
      "-i",
      input.srcAbs,
      // -t là tùy chọn ĐẦU RA nên phải đứng sau -i: cắt phần dư của mẫu quá dài
      ...(trimmed ? ["-t", String(CLONE_REF_IDEAL_MAX_SEC)] : []),
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(REF_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      refAbs,
    ]);
    if (!fs.existsSync(refAbs)) {
      throw new Error("ffmpeg chạy xong nhưng không ghi ra file mẫu");
    }
    // Đo lại trên chính file ĐÃ chuẩn hóa: đó mới là thứ engine sẽ đọc
    const refDurationSec = Math.round((await probeSeconds(refAbs)) * 100) / 100;

    if (trimmed) {
      // ClonedVoice không có chỗ nào khác để nói điều này, mà người dùng cần
      // biết vì sao mẫu 5 phút của họ chỉ còn vài giây.
      const line = `Mẫu gốc dài ${srcSec.toFixed(1)}s, đã cắt còn ${refDurationSec.toFixed(1)}s (model chỉ dùng phần đầu).`;
      note = note ? `${note}\n${line}` : line;
    }

    const now = nowIso();
    const entry: ClonedVoice = {
      id,
      name,
      gender,
      note,
      refFile: toRepoRel(refAbs),
      refDurationSec,
      createdAt: now,
      updatedAt: now,
    };
    entries.push(entry);
    writeLibrary(entries);
    return entry;
  } catch (err) {
    // Hỏng giữa chừng thì đừng để lại thư mục rác chiếm mất id
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* thư mục đang bị giữ - bỏ qua */
    }
    throw err;
  }
}

/**
 * Sửa phần mô tả của giọng. KHÔNG đổi id: id đã nằm trong meta.json của các
 * phiên cũ, đổi đi là những phiên đó đọc ra giọng khác (hoặc lỗi).
 */
export function patchClonedVoice(
  id: string,
  patch: { name?: unknown; gender?: unknown; note?: unknown },
): ClonedVoice {
  const entries = readLibrary();
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    throw new HttpError(404, "VOICE_NOT_FOUND", `Không tìm thấy giọng nhân bản "${id}"`);
  }
  if ("name" in patch) entry.name = cleanName(patch.name);
  if ("gender" in patch) entry.gender = cleanGender(patch.gender);
  if ("note" in patch) entry.note = cleanNote(patch.note);
  entry.updatedAt = nowIso();
  writeLibrary(entries);
  return entry;
}

export function removeClonedVoice(id: string): void {
  const entries = readLibrary();
  const dir = path.join(paths.voicesDir, id);
  const found = entries.some((e) => e.id === id);
  // Xóa được cả khi bản ghi mất mà thư mục còn (hoặc ngược lại) - nếu không thì
  // rác nằm lại vĩnh viễn vì không có đường nào khác để dọn.
  if (!found && !fs.existsSync(dir)) {
    throw new HttpError(404, "VOICE_NOT_FOUND", `Không tìm thấy giọng nhân bản "${id}"`);
  }
  if (!isKebabCase(id)) {
    throw new HttpError(400, "INVALID_VOICE_ID", `id giọng không hợp lệ: "${id}"`);
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    throw new HttpError(
      500,
      "VOICE_DELETE_FAILED",
      `Không xóa được thư mục giọng: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  writeLibrary(entries.filter((e) => e.id !== id));
}
