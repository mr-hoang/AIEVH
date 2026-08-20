import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import { repoRoot } from "../config.js";
import * as db from "../db.js";
import { readRenderSettings, type UpdateChannel } from "../renderSettings.js";
import { nowIso } from "../util.js";

const execFileAsync = promisify(execFile);

/** Một commit sắp được kéo về - hiện trong popup "Có gì mới". */
export interface UpdateCommit {
  hash: string;
  message: string;
}

/**
 * Trạng thái cập nhật.
 *
 * Mốc so sánh phụ thuộc KÊNH (settings.updateChannel):
 * - "stable" (mặc định): so với tag release mới nhất (`v*`). Người dùng chỉ nhận
 *   bản đã được chủ dự án đóng dấu là chạy được.
 * - "latest": so với `origin/main` như hành vi cũ - mọi commit push lên đều hiện
 *   thành "có bản mới", kể cả commit dở dang.
 */
export interface UpdateStatus {
  /** Short hash của HEAD hiện tại ("" nếu git lỗi). */
  current: string;
  /** Phiên bản đang chạy: tag `v*` gần nhất tính ngược từ HEAD (null nếu chưa có tag nào). */
  currentVersion: string | null;
  /**
   * Phiên bản kênh hiện tại đang chào mời. Kênh "latest" trả null vì thứ chào
   * mời là một commit chứ không phải một bản phát hành - UI sẽ hiện theo commit.
   */
  latestVersion: string | null;
  /** Kênh đã dùng cho lần check này. */
  channel: UpdateChannel;
  /** Số commit HEAD đang thua mốc so sánh. */
  behind: number;
  upToDate: boolean;
  /** Message commit mới nhất ở mốc so sánh (null khi đã mới nhất). */
  latestMessage: string | null;
  /** Danh sách commit sắp về, mới nhất trước (tối đa 10) - rỗng khi đã mới nhất. */
  commits: UpdateCommit[];
  checkedAt: string;
  /** false khi `git fetch origin` thất bại (offline…) - behind tính theo refs cũ. */
  fetchOk: boolean;
  /** true khi kênh "stable" nhưng repo CHƯA có tag nào -> đã lùi về so với main. */
  fellBackToMain?: boolean;
  /** Lỗi ngắn khi check thất bại (offline, không có git…) - không bao giờ 500. */
  error?: string;
}

/** Các bước script update phát ra qua mốc `[STEP] <tên>` trong start/update.log */
export const UPDATE_STEPS = ["pull", "stop", "install", "restart"] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    timeout: 20_000,
    windowsHide: true,
  });
  return stdout.trim();
}

function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split("\n")[0].slice(0, 200);
}

/**
 * Chỉ tag dạng `v*` mới được coi là bản phát hành. Repo có thể mang tag khác
 * (mốc thử nghiệm, tag của thư viện nhúng…) - lấy bừa mọi tag là hiểu nhầm ngay.
 */
const RELEASE_TAG_GLOB = "v*";

/** Tag release mới nhất đã biết sau khi fetch - null nếu repo chưa phát hành bản nào */
async function latestReleaseTag(): Promise<string | null> {
  // -v:refname sắp theo SỐ phiên bản, không phải theo chữ cái: thiếu nó thì
  // v1.0.9 lại đứng trên v1.0.10.
  const raw = await git(["tag", "-l", RELEASE_TAG_GLOB, "--sort=-v:refname"]);
  return raw.split("\n")[0]?.trim() || null;
}

/** Phiên bản HEAD đang đứng: tag `v*` gần nhất đi ngược từ HEAD */
async function currentReleaseTag(): Promise<string | null> {
  try {
    return (
      (await git(["describe", "--tags", "--abbrev=0", "--match", RELEASE_TAG_GLOB])) || null
    );
  } catch {
    // Chưa tag nào là tổ tiên của HEAD (clone giữa chừng, hoặc repo chưa release)
    return null;
  }
}

/**
 * Mốc mà bản cài này sẽ đuổi theo. Dùng chung cho cả /check lẫn /apply để hai
 * bên không bao giờ nói một đằng làm một nẻo.
 */
async function resolveTarget(channel: UpdateChannel): Promise<{
  ref: string;
  version: string | null;
  fellBackToMain: boolean;
}> {
  if (channel !== "stable") return { ref: "origin/main", version: null, fellBackToMain: false };
  const tag = await latestReleaseTag();
  // Chưa có release nào mà chặn cập nhật thì người dùng kẹt vĩnh viễn - lùi về main
  if (!tag) return { ref: "origin/main", version: null, fellBackToMain: true };
  return { ref: tag, version: tag, fellBackToMain: false };
}

async function checkUpdate(): Promise<UpdateStatus> {
  const checkedAt = nowIso();
  const channel = readRenderSettings().updateChannel;

  // Fetch best-effort: offline thì vẫn so được với refs đã biết từ lần fetch
  // trước - máy mất mạng vẫn báo đúng "có bản mới" nếu đã biết.
  // --tags BẮT BUỘC cho kênh stable: không kéo tag về thì máy không bao giờ
  // thấy release mới. --force để tag bị dời ở remote cũng đồng bộ lại được.
  let fetchOk = true;
  let error: string | undefined;
  try {
    await git(["fetch", "origin", "--tags", "--force"]);
  } catch (err) {
    fetchOk = false;
    error = shortError(err);
  }

  // current độc lập với fetch - luôn cố lấy.
  let current = "";
  try {
    current = await git(["rev-parse", "--short", "HEAD"]);
  } catch (err) {
    error = error ?? shortError(err);
  }

  try {
    const { ref, version, fellBackToMain } = await resolveTarget(channel);
    await git(["rev-parse", "--verify", ref]);
    const currentVersion = await currentReleaseTag();
    const behind = Number(await git(["rev-list", `HEAD..${ref}`, "--count"])) || 0;
    const latestMessage = behind > 0 ? await git(["log", ref, "-1", "--format=%s"]) : null;
    // Danh sách commit sắp về để popup nói rõ "có gì mới" thay vì chỉ một con số
    let commits: UpdateCommit[] = [];
    if (behind > 0) {
      const raw = await git(["log", `HEAD..${ref}`, "-10", "--format=%h\x1f%s"]);
      commits = raw
        .split("\n")
        .map((l) => l.split("\x1f"))
        .filter((p) => p.length === 2 && p[0])
        .map(([hash, message]) => ({ hash, message }));
    }
    return {
      current,
      currentVersion,
      latestVersion: version,
      channel,
      behind,
      upToDate: behind === 0,
      latestMessage,
      commits,
      checkedAt,
      fetchOk,
      ...(fellBackToMain ? { fellBackToMain: true } : {}),
      ...(error ? { error } : {}),
    };
  } catch (err) {
    // rev-parse/rev-list cũng fail (không có git, chưa từng fetch…) → báo lỗi thật
    return {
      current,
      currentVersion: null,
      latestVersion: null,
      channel,
      behind: 0,
      upToDate: true,
      latestMessage: null,
      commits: [],
      checkedAt,
      fetchOk,
      error: error ?? shortError(err),
    };
  }
}

const CACHE_MS = 3 * 60 * 1000;
/** Cache kèm kênh: đổi kênh trong Cấu hình phải thấy kết quả mới ngay, không chờ hết 3 phút */
let cached: { at: number; channel: UpdateChannel; status: UpdateStatus } | null = null;

const router = Router();

// GET /api/update/check - cache 3 phút, ?force=1 bỏ cache
router.get("/check", async (req, res) => {
  const force = req.query.force === "1";
  const channel = readRenderSettings().updateChannel;
  if (!force && cached && cached.channel === channel && Date.now() - cached.at < CACHE_MS) {
    res.json(cached.status);
    return;
  }
  const status = await checkUpdate();
  cached = { at: Date.now(), channel, status };
  res.json(status);
});

/**
 * GET /api/update/log?tail=200 - đuôi start/update.log + bước đang chạy.
 *
 * VÌ SAO cần: script update chạy DETACHED và tự kill server này, nên không thể
 * đẩy tiến trình qua SSE. Script ghi mốc `[STEP] <tên>` vào log; UI poll endpoint
 * này lúc server còn sống (bước pull), và gọi lại sau khi server hồi sinh để hiện
 * kết quả thật của cả quãng server đã tắt.
 */
router.get("/log", (req, res) => {
  const tail = Math.min(Math.max(Number(req.query.tail) || 200, 1), 2000);
  const file = path.join(repoRoot, "start", "update.log");
  if (!fs.existsSync(file)) {
    res.json({ exists: false, lines: [], step: null, startedAt: null });
    return;
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    res.json({ exists: true, lines: [], step: null, startedAt: null, error: shortError(err) });
    return;
  }

  // Log là file CỘNG DỒN qua nhiều lần update - chỉ lấy từ dấu mốc lần chạy CUỐI,
  // nếu không UI sẽ hiện lẫn output của lần cập nhật trước.
  const all = text.split(/\r?\n/);
  // Duyệt ngược tay thay vì findLastIndex - lib TS của server chưa bật ES2023
  let startIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].includes("bắt đầu cập nhật")) {
      startIdx = i;
      break;
    }
  }
  const run = startIdx >= 0 ? all.slice(startIdx) : all;

  const stepLine = [...run].reverse().find((l) => l.includes("[STEP] "));
  const raw = stepLine?.split("[STEP] ")[1]?.trim() ?? "";
  const step = (UPDATE_STEPS as readonly string[]).includes(raw)
    ? (raw as UpdateStep)
    : null;

  res.json({
    exists: true,
    // Bỏ dòng trống ở đuôi cho UI khỏi hiện khoảng trắng thừa
    lines: run.slice(-tail).filter((l, i, a) => l.trim() !== "" || i < a.length - 1),
    step,
    startedAt: startIdx >= 0 ? (all[startIdx] ?? null) : null,
  });
});

// POST /api/update/apply - spawn script update DETACHED rồi trả 202 ngay.
// Script sẽ kill server này, nên process con phải sống độc lập (detached + unref).
router.post("/apply", async (_req, res) => {
  // Job queued cũng phải chặn - nó có thể bắt đầu chạy đúng lúc script update kill server
  if (db.getRunningJob() || db.countQueuedJobs() > 0) {
    res.status(409).json({
      error: {
        code: "JOB_RUNNING",
        message: "Đang có job render chạy/chờ trong hàng đợi - chờ xong rồi cập nhật.",
      },
    });
    return;
  }

  // Nói cho script biết phải nhảy tới ĐÂU. Truyền qua file thay vì tham số dòng
  // lệnh vì script chạy detached qua `cmd /c start` trên Windows - chuỗi tham số
  // đi qua đó rất dễ bị nuốt. File cũng là đường lùi tự nhiên: bản cài cũ chưa
  // có file này thì script mặc định origin/main y như trước.
  let targetRef = "origin/main";
  try {
    targetRef = (await resolveTarget(readRenderSettings().updateChannel)).ref;
  } catch {
    // Git lỗi thì cứ để script tự xoay với origin/main, đừng chặn cập nhật
  }
  try {
    fs.writeFileSync(path.join(repoRoot, "start", "update-target.txt"), `${targetRef}\n`, "utf8");
  } catch {
    // Không ghi được thì script dùng mặc định - chỉ mất tính năng chọn kênh
  }

  // Script update tự ghi toàn bộ output vào start/update.log - soi khi lỗi.
  res.status(202).json({ ok: true, logHint: "start/update.log", target: targetRef });
  const child =
    process.platform === "win32"
      ? spawn(
          "cmd.exe",
          ["/c", "start", "AI Edit Video - UPDATE", "cmd", "/c", "update\\update.bat"],
          { cwd: repoRoot, detached: true, stdio: "ignore" },
        )
      : spawn("bash", ["update/update.sh"], {
          cwd: repoRoot,
          detached: true,
          stdio: "ignore",
        });
  child.unref();
});

export default router;
