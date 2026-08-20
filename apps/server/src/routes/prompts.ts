import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { paths } from "../config.js";
import { HttpError, ensureDir, nowIso, toKebabAscii } from "../util.js";

/**
 * Prompt mẫu - prompt tái sử dụng cho ô "Yêu cầu edit" của Brief.
 * Lưu tại assets/prompts/prompts.json. Xem docs/API.md mục "Prompt mẫu".
 */

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

const promptsDir = path.join(paths.assetsDir, "prompts");
const promptsFile = path.join(promptsDir, "prompts.json");

function readPrompts(): PromptTemplate[] {
  try {
    const raw = JSON.parse(fs.readFileSync(promptsFile, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is PromptTemplate =>
        !!p &&
        typeof p === "object" &&
        typeof (p as PromptTemplate).id === "string" &&
        typeof (p as PromptTemplate).name === "string" &&
        typeof (p as PromptTemplate).content === "string",
    );
  } catch {
    return [];
  }
}

function writePrompts(list: PromptTemplate[]): void {
  ensureDir(promptsDir);
  fs.writeFileSync(promptsFile, JSON.stringify(list, null, 2) + "\n", "utf8");
}

const router = Router();

// GET /api/prompts - mới cập nhật trước
router.get("/", (_req, res) => {
  const list = readPrompts();
  list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  res.json(list);
});

// POST /api/prompts - { name, content }
router.post("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!name) throw new HttpError(400, "INVALID_NAME", "Thiếu name");
  if (!content) throw new HttpError(400, "INVALID_CONTENT", "Thiếu content");

  const list = readPrompts();
  const base = toKebabAscii(name) || "prompt";
  let id = base;
  for (let n = 2; list.some((p) => p.id === id); n++) id = `${base}-${n}`;

  const now = nowIso();
  const prompt: PromptTemplate = { id, name, content, createdAt: now, updatedAt: now };
  list.push(prompt);
  writePrompts(list);
  res.status(201).json(prompt);
});

// PUT /api/prompts/:id - { name?, content? }
router.put("/:id", (req, res) => {
  const list = readPrompts();
  const prompt = list.find((p) => p.id === req.params.id);
  if (!prompt) {
    throw new HttpError(404, "PROMPT_NOT_FOUND", `Không tìm thấy prompt "${req.params.id}"`);
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new HttpError(400, "INVALID_NAME", "name phải là string không rỗng");
    }
    prompt.name = body.name.trim();
  }
  if ("content" in body) {
    if (typeof body.content !== "string" || !body.content.trim()) {
      throw new HttpError(400, "INVALID_CONTENT", "content phải là string không rỗng");
    }
    prompt.content = body.content.trim();
  }
  prompt.updatedAt = nowIso();
  writePrompts(list);
  res.json(prompt);
});

// DELETE /api/prompts/:id
router.delete("/:id", (req, res) => {
  const list = readPrompts();
  const next = list.filter((p) => p.id !== req.params.id);
  if (next.length === list.length) {
    throw new HttpError(404, "PROMPT_NOT_FOUND", `Không tìm thấy prompt "${req.params.id}"`);
  }
  writePrompts(next);
  res.status(204).end();
});

export default router;
