import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { hasClaudeAuth, paths, repoRoot } from "../config.js";
import { addTokenUsage } from "../db.js";
import { HttpError, ensureDir, isKebabCase, toKebabAscii } from "../util.js";

const router = Router();

function skillDirOf(name: string): string {
  return path.join(paths.skillsDir, name);
}

function skillFileOf(name: string): string {
  return path.join(skillDirOf(name), "SKILL.md");
}

function assertValidName(name: string): void {
  if (!name || !isKebabCase(name)) {
    throw new HttpError(400, "INVALID_SKILL_NAME", "Tên skill phải là kebab-case (vd: video-pipeline)");
  }
}

/** Parse frontmatter - bắt buộc có name + description */
function parseFrontmatter(content: string): { name: string; description: string } {
  let data: Record<string, unknown>;
  try {
    data = matter(content).data as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_FRONTMATTER", "Frontmatter YAML không hợp lệ");
  }
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!name || !description) {
    throw new HttpError(
      400,
      "INVALID_FRONTMATTER",
      "SKILL.md phải có frontmatter với `name` và `description`",
    );
  }
  return { name, description };
}

// ---------------------------------------------------------------- Generate (AI draft)

const GEN_ASPECTS = new Set(["9:16", "16:9", "1:1", "4:5"]);
const GEN_CAPTIONS = new Set(["karaoke", "sentence", "none"]);
/** Timeout tổng cho một lượt generate (docs/API.md: có thể chạy 1–3 phút) */
const GEN_TIMEOUT_MS = 4 * 60_000;

/**
 * Tìm nội dung SKILL.md trong text AI trả về: fence ```markdown|```md|``` đầu tiên
 * có frontmatter (bắt đầu "---" và chứa "name:"); không có fence mà toàn văn
 * bắt đầu bằng "---" thì dùng toàn văn.
 */
function extractSkillMarkdown(text: string): string | null {
  const fenceRe = /```(?:markdown|md)?[^\n]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const inner = m[1].trim();
    if (inner.startsWith("---") && /\bname\s*:/.test(inner)) return inner;
  }
  const whole = text.trim();
  if (whole.startsWith("---")) return whole;
  return null;
}

// POST /api/skills/generate - tạo draft SKILL.md bằng Claude (một lượt, không tool). KHÔNG ghi file.
router.post("/generate", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof body[key] === "string" && (body[key] as string).trim()
      ? (body[key] as string).trim()
      : undefined;

  const goal = str("goal");
  if (!goal) throw new HttpError(400, "GOAL_REQUIRED", "Thiếu goal - mục đích & loại video");

  // Enum lỏng: giá trị lạ → bỏ qua field, không lỗi
  const platform = str("platform");
  const aspectRaw = str("aspect");
  const aspect = aspectRaw && GEN_ASPECTS.has(aspectRaw) ? aspectRaw : undefined;
  const fps = body.fps === 30 || body.fps === 60 ? (body.fps as number) : undefined;
  const duration = str("duration");
  const style = str("style");
  const captionsRaw = str("captions");
  const captions = captionsRaw && GEN_CAPTIONS.has(captionsRaw) ? captionsRaw : undefined;
  const highlights = typeof body.highlights === "boolean" ? body.highlights : undefined;
  const sfx = typeof body.sfx === "boolean" ? body.sfx : undefined;
  const suggestedName = str("name");
  const baseSkillName = str("baseSkill");
  const notes = str("notes");

  // baseSkill (nếu truyền) phải tồn tại
  let baseSkillContent: string | null = null;
  if (baseSkillName) {
    const file = skillFileOf(baseSkillName);
    if (!isKebabCase(baseSkillName) || !fs.existsSync(file)) {
      throw new HttpError(404, "SKILL_NOT_FOUND", `Không tìm thấy skill "${baseSkillName}"`);
    }
    baseSkillContent = fs.readFileSync(file, "utf8");
  }

  if (!hasClaudeAuth()) {
    throw new HttpError(
      503,
      "NO_CLAUDE_AUTH",
      "Chưa có xác thực Claude. Cách 1 (khuyên dùng): đăng nhập Claude Code trên máy này (VSCode extension hoặc chạy `claude` trong terminal rồi /login) - hệ thống tự dùng gói subscription. Cách 2: điền ANTHROPIC_API_KEY vào file .env rồi khởi động lại server.",
    );
  }

  // (a) chuẩn viết skill
  let authoring = "";
  try {
    authoring = fs.readFileSync(path.join(paths.skillsDir, "skill-authoring", "SKILL.md"), "utf8");
  } catch {
    /* không có skill-authoring thì prompt vẫn chạy được */
  }

  // (c) câu trả lời form - chỉ field có giá trị, nhãn tiếng Việt
  const answers: string[] = [`- Mục đích: ${goal}`];
  if (platform) answers.push(`- Nền tảng: ${platform}`);
  if (aspect) answers.push(`- Định dạng khung: ${aspect}`);
  if (fps) answers.push(`- FPS: ${fps}`);
  if (duration) answers.push(`- Độ dài mục tiêu: ${duration}`);
  if (style) answers.push(`- Phong cách & nhịp: ${style}`);
  if (captions) answers.push(`- Phụ đề: ${captions}`);
  if (highlights !== undefined) answers.push(`- Keyword highlight: ${highlights ? "Có" : "Không"}`);
  if (sfx !== undefined) answers.push(`- Sound effect: ${sfx ? "Có" : "Không"}`);
  if (suggestedName) answers.push(`- Tên gợi ý: ${suggestedName}`);
  if (notes) answers.push(`- Ghi chú: ${notes}`);

  const promptParts: string[] = [
    "Bạn là chuyên gia viết skill cho hệ thống AI Edit Video (HyperFrames + Remotion). Hãy soạn một file SKILL.md mới theo yêu cầu bên dưới.",
    `## Chuẩn viết skill (skill-authoring)\n\n<skill-authoring>\n${authoring}\n</skill-authoring>`,
  ];
  if (baseSkillContent) {
    promptParts.push(
      `## Skill mẫu tham khảo - kế thừa cấu trúc/kỹ thuật, KHÔNG copy branding\n\n<base-skill name="${baseSkillName}">\n${baseSkillContent}\n</base-skill>`,
    );
  }
  promptParts.push(`## Câu trả lời form của người dùng\n\n${answers.join("\n")}`);
  promptParts.push(
    // Thân skill viết TIẾNG ANH: toàn bộ skill của dự án đã chuyển sang tiếng Anh,
    // skill sinh mới mà còn tiếng Việt thì thư viện lẫn lộn hai ngôn ngữ.
    // Ví dụ minh họa đặc thù tiếng Việt (chữ có dấu, filler) vẫn giữ nguyên tiếng Việt.
    "## Yêu cầu đầu ra\n\nTrả về DUY NHẤT nội dung file SKILL.md hoàn chỉnh trong một code fence ```markdown. Frontmatter có name (kebab-case) + description (nêu rõ KHI NÀO dùng, viết bằng TIẾNG ANH). **Thân skill viết bằng TIẾNG ANH** theo đúng chuẩn skill-authoring - riêng các chuỗi ví dụ đặc thù tiếng Việt (chữ có dấu để minh họa lỗi font, ví dụ filler \"ừm/à/kiểu\") thì GIỮ NGUYÊN tiếng Việt vì dịch đi là mất ý nghĩa minh họa. Có OUTPUT SPEC (kích thước px theo aspect, fps), quy tắc caption/highlight/SFX theo câu trả lời, mục '⚖️ STYLE DESIGN - PRIORITY RULE' ngay sau heading đầu (xem skill mẫu), và mục 'Known issues' để tích lũy về sau.",
  );

  // Gọi Agent SDK - một lượt, không tool, không nạp settings/CLAUDE.md
  const options: Record<string, unknown> = {
    cwd: repoRoot,
    maxTurns: 1,
    allowedTools: [],
    settingSources: [],
    permissionMode: "default",
  };

  let resultText = "";
  let inTok = 0;
  let outTok = 0;
  let cost = 0;

  try {
    const q = query({
      prompt: promptParts.join("\n\n"),
      options: options as Parameters<typeof query>[0]["options"],
    });

    const run = (async () => {
      for await (const raw of q) {
        const msg = raw as {
          type?: string;
          result?: string;
          total_cost_usd?: number;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        if (msg.type === "result") {
          // Cộng cache vào input như agent.ts
          inTok =
            (msg.usage?.input_tokens ?? 0) +
            (msg.usage?.cache_creation_input_tokens ?? 0) +
            (msg.usage?.cache_read_input_tokens ?? 0);
          outTok = msg.usage?.output_tokens ?? 0;
          cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
          if (typeof msg.result === "string") resultText = msg.result;
        }
      }
    })();
    // Nếu timeout thắng race, run có thể reject sau đó (do interrupt) - nuốt để không unhandled
    run.catch(() => {});

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void q.interrupt().catch(() => {});
        reject(new Error(`Quá ${GEN_TIMEOUT_MS / 60_000} phút chưa có kết quả`));
      }, GEN_TIMEOUT_MS);
    });
    try {
      await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    throw new HttpError(
      500,
      "GENERATION_FAILED",
      `Tạo skill thất bại: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Ghi token đã dùng (kể cả khi output không parse được - token vẫn đã tiêu)
  try {
    if (inTok > 0 || outTok > 0 || cost > 0) {
      addTokenUsage(`skillgen_${nanoid(8)}`, null, inTok, outTok, cost, "claude");
    }
  } catch {
    /* usage là phụ */
  }

  // Parse + validate frontmatter
  let content = extractSkillMarkdown(resultText);
  let fmName = "";
  let fmDescription = "";
  if (content) {
    try {
      const data = matter(content).data as Record<string, unknown>;
      fmName = typeof data.name === "string" ? data.name.trim() : "";
      fmDescription = typeof data.description === "string" ? data.description.trim() : "";
    } catch {
      /* frontmatter hỏng → 422 bên dưới */
    }
  }
  if (!content || !fmName || !fmDescription) {
    res.status(422).json({
      error: {
        code: "BAD_SKILL_OUTPUT",
        message:
          "AI trả về sai định dạng SKILL.md (thiếu code fence hoặc frontmatter name/description) - xem raw để tự sửa",
      },
      raw: resultText,
    });
    return;
  }

  // Tên cuối: body.name kebab hợp lệ ưu tiên, không thì frontmatter name ép kebab; tránh trùng bằng -2, -3...
  let finalName =
    suggestedName && isKebabCase(suggestedName) ? suggestedName : toKebabAscii(fmName);
  if (!finalName) finalName = "skill-moi";
  if (fs.existsSync(skillDirOf(finalName))) {
    let i = 2;
    while (fs.existsSync(skillDirOf(`${finalName}-${i}`))) i++;
    finalName = `${finalName}-${i}`;
  }
  if (finalName !== fmName) {
    // Chỉ thay dòng name TRONG block frontmatter (giữa "---" đầu và "---" thứ hai) -
    // tránh đụng dòng "name:" xuất hiện trong thân skill
    content = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, (frontmatter) =>
      frontmatter.replace(/^name\s*:.*$/m, `name: ${finalName}`),
    );
  }

  res.json({ name: finalName, content, tokens: { input: inTok, output: outTok } });
});

// GET /api/skills - [{ name, description, updatedAt, sizeBytes }]
router.get("/", (_req, res) => {
  const out: Array<{ name: string; description: string; updatedAt: string; sizeBytes: number }> =
    [];
  if (fs.existsSync(paths.skillsDir)) {
    for (const entry of fs.readdirSync(paths.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = skillFileOf(entry.name);
      if (!fs.existsSync(file)) continue;
      try {
        const stat = fs.statSync(file);
        const content = fs.readFileSync(file, "utf8");
        const data = matter(content).data as Record<string, unknown>;
        out.push({
          name: entry.name,
          description: typeof data.description === "string" ? data.description : "",
          updatedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      } catch {
        // SKILL.md hỏng → vẫn liệt kê với description rỗng
        const stat = fs.statSync(file);
        out.push({
          name: entry.name,
          description: "",
          updatedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json(out);
});

// GET /api/skills/:name → { name, content }
router.get("/:name", (req, res) => {
  const name = req.params.name;
  assertValidName(name);
  const file = skillFileOf(name);
  if (!fs.existsSync(file)) {
    throw new HttpError(404, "SKILL_NOT_FOUND", `Không tìm thấy skill "${name}"`);
  }
  res.json({ name, content: fs.readFileSync(file, "utf8") });
});

// POST /api/skills - { name, content } → 201 (409 nếu trùng)
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  let content = typeof body.content === "string" ? body.content : "";
  assertValidName(name);
  if (!content.trim()) throw new HttpError(400, "INVALID_CONTENT", "Thiếu content");
  const fm = parseFrontmatter(content);
  if (fs.existsSync(skillFileOf(name))) {
    throw new HttpError(409, "SKILL_EXISTS", `Skill "${name}" đã tồn tại`);
  }
  if (fm.name !== name) {
    // Đồng bộ frontmatter name với tên folder cuối (như /generate) - draft bị đổi tên
    // trước khi lưu mà không sửa lại là hai tên lệch nhau vĩnh viễn.
    // Chỉ thay dòng name TRONG block frontmatter (giữa "---" đầu và "---" thứ hai) -
    // tránh đụng dòng "name:" xuất hiện trong thân skill
    content = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, (frontmatter) =>
      frontmatter.replace(/^name\s*:.*$/m, `name: ${name}`),
    );
    // Regex không khớp (vd viết "name": có ngoặc kép - gray-matter vẫn parse được)
    // thì replace ở trên im lặng không làm gì → kiểm lại, lệch thì báo hẳn ra
    // thay vì lưu file mang hai tên khác nhau
    if (parseFrontmatter(content).name !== name) {
      throw new HttpError(
        422,
        "NAME_MISMATCH",
        `Không đồng bộ được frontmatter name với tên skill "${name}" - sửa dòng "name:" trong frontmatter cho khớp rồi lưu lại`,
      );
    }
  }
  ensureDir(skillDirOf(name));
  fs.writeFileSync(skillFileOf(name), content, "utf8");
  res.status(201).json({ name, content });
});

// PUT /api/skills/:name - { content } → 200
router.put("/:name", (req, res) => {
  const name = req.params.name;
  assertValidName(name);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) throw new HttpError(400, "INVALID_CONTENT", "Thiếu content");
  if (!fs.existsSync(skillFileOf(name))) {
    throw new HttpError(404, "SKILL_NOT_FOUND", `Không tìm thấy skill "${name}"`);
  }
  parseFrontmatter(content);
  fs.writeFileSync(skillFileOf(name), content, "utf8");
  res.json({ name, content });
});

// DELETE /api/skills/:name - xóa cả folder skill
router.delete("/:name", (req, res) => {
  const name = req.params.name;
  assertValidName(name);
  if (!fs.existsSync(skillDirOf(name))) {
    throw new HttpError(404, "SKILL_NOT_FOUND", `Không tìm thấy skill "${name}"`);
  }
  fs.rmSync(skillDirOf(name), { recursive: true, force: true });
  res.status(204).end();
});

export default router;
