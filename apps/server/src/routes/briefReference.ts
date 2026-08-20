import { Router } from "express";
import multer from "multer";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { applyBriefPatch, briefOf, readMeta, writeMeta } from "../meta.js";
import { HttpError } from "../util.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});
const MAX_TEXT = 60_000;

function clipText(value: string): string {
  return value.replace(/\0/g, "").replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT);
}

async function textFromFile(file: Express.Multer.File): Promise<string> {
  const name = file.originalname.toLowerCase();
  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return clipText(result.value);
  }
  if (name.endsWith(".xlsx")) {
    const workbook = new ExcelJS.Workbook();
    const arrayBuffer = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;
    await workbook.xlsx.load(arrayBuffer);
    const parts = workbook.worksheets.map((sheet) => {
      const rows: string[] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const values = row.values as unknown[];
        rows.push(values.slice(1).map((cell) => String((cell as { text?: string })?.text ?? cell ?? "")).join("\t"));
      });
      return `### Sheet: ${sheet.name}\n${rows.join("\n")}`;
    });
    return clipText(parts.join("\n\n"));
  }
  if (/\.(csv|txt|md)$/i.test(name)) return clipText(file.buffer.toString("utf8"));
  if (name.endsWith(".xls")) {
    throw new HttpError(400, "OLD_EXCEL_FORMAT", "Excel .xls quá cũ; hãy mở và Save As thành .xlsx rồi tải lại");
  }
  throw new HttpError(400, "UNSUPPORTED_REFERENCE", "Chỉ hỗ trợ Word .docx, Excel .xlsx, CSV hoặc TXT");
}

function googleSheetExportUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "INVALID_SHEET_URL", "Link Google Sheets không hợp lệ");
  }
  if (url.hostname !== "docs.google.com") {
    throw new HttpError(400, "INVALID_SHEET_URL", "Hiện chỉ hỗ trợ link docs.google.com/spreadsheets");
  }
  const match = url.pathname.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!match) throw new HttpError(400, "INVALID_SHEET_URL", "Không tìm thấy ID Google Sheets trong link");
  const gid = url.searchParams.get("gid") ?? url.hash.match(/gid=(\d+)/)?.[1] ?? "0";
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

router.post("/:id/brief/reference-file", upload.single("file"), async (req, res) => {
  const id = String(req.params.id);
  const meta = readMeta(id);
  if (!req.file) throw new HttpError(400, "FILE_REQUIRED", "Chưa chọn tệp kịch bản");
  const content = await textFromFile(req.file);
  if (!content) throw new HttpError(400, "EMPTY_REFERENCE", "Không trích xuất được nội dung từ tệp");
  meta.brief = applyBriefPatch(briefOf(meta), {
    referenceName: req.file.originalname,
    referenceUrl: "",
    referenceContent: content,
  });
  writeMeta(id, meta);
  res.json(meta.brief);
});

router.post("/:id/brief/reference-link", async (req, res) => {
  const id = String(req.params.id);
  const meta = readMeta(id);
  const raw = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!raw) throw new HttpError(400, "URL_REQUIRED", "Chưa nhập link Google Sheets");
  const exportUrl = googleSheetExportUrl(raw);
  const response = await fetch(exportUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new HttpError(400, "SHEET_NOT_ACCESSIBLE", "Không đọc được Google Sheets; hãy bật quyền ai có link cũng có thể xem");
  }
  const content = clipText(await response.text());
  if (!content || /<html[\s>]/i.test(content)) {
    throw new HttpError(400, "SHEET_NOT_ACCESSIBLE", "Google Sheets chưa công khai hoặc không có dữ liệu đọc được");
  }
  meta.brief = applyBriefPatch(briefOf(meta), {
    referenceName: "Google Sheets",
    referenceUrl: raw,
    referenceContent: content,
  });
  writeMeta(id, meta);
  res.json(meta.brief);
});

router.delete("/:id/brief/reference", (req, res) => {
  const id = String(req.params.id);
  const meta = readMeta(id);
  meta.brief = applyBriefPatch(briefOf(meta), {
    referenceName: "",
    referenceUrl: "",
    referenceContent: "",
  });
  writeMeta(id, meta);
  res.json(meta.brief);
});

export default router;
