import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { paths } from "../config.js";
import {
  generateOmniVideo,
  type OmniAspect,
  type OmniVideoTask,
} from "../geminiVideo.js";
import { HttpError } from "../util.js";

const router = Router();
const upload = multer({
  dest: paths.uploadTmpDir,
  limits: { fileSize: 250 * 1024 * 1024, files: 1, fields: 10 },
});

const TASKS = new Set<OmniVideoTask>([
  "text_to_video",
  "image_to_video",
  "reference_to_video",
  "edit",
]);

router.get("/", (_req, res) => {
  const items = fs
    .readdirSync(paths.outputsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^omni-.*\.mp4$/i.test(entry.name))
    .map((entry) => {
      const stat = fs.statSync(path.join(paths.outputsDir, entry.name));
      return {
        id: entry.name.replace(/\.mp4$/i, ""),
        file: entry.name,
        relPath: `outputs/${entry.name}`,
        mediaUrl: `/media/outputs/${encodeURIComponent(entry.name)}`,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(items);
});

router.post("/", upload.single("source"), async (req, res) => {
  const tmp = req.file?.path ?? null;
  try {
    const prompt = typeof req.body.prompt === "string" ? req.body.prompt : "";
    const taskRaw = typeof req.body.task === "string" ? req.body.task : "text_to_video";
    const aspectRaw = typeof req.body.aspect === "string" ? req.body.aspect : "16:9";
    const previous =
      typeof req.body.previousInteractionId === "string" && req.body.previousInteractionId
        ? req.body.previousInteractionId
        : null;
    if (!TASKS.has(taskRaw as OmniVideoTask)) {
      throw new HttpError(400, "INVALID_TASK", "Task Gemini Omni không hợp lệ");
    }
    if (aspectRaw !== "16:9" && aspectRaw !== "9:16") {
      throw new HttpError(400, "INVALID_ASPECT", "Tỷ lệ phải là 16:9 hoặc 9:16");
    }
    if (req.file && !/^(image|video)\//i.test(req.file.mimetype)) {
      throw new HttpError(400, "INVALID_SOURCE", "Chỉ nhận ảnh hoặc video nguồn");
    }
    const result = await generateOmniVideo({
      prompt,
      task: taskRaw as OmniVideoTask,
      aspect: aspectRaw as OmniAspect,
      sourcePath: tmp,
      sourceMime: req.file?.mimetype,
      previousInteractionId: previous,
    });
    res.status(201).json(result);
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
});

export default router;
