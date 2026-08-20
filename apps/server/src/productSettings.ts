import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import { ensureDir } from "./util.js";

export interface ProductSettings {
  appName: string;
  source: string;
  logoFile: string | null;
  logoUrl: string | null;
}

const SETTINGS_FILE = path.join(paths.dataDir, "product-settings.json");
const DEFAULTS: Omit<ProductSettings, "logoUrl"> = {
  appName: "AIEV - Mr Hoàng",
  source: "Nguồn: Nguyễn Văn Hoàng",
  logoFile: null,
};

function cleanText(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/[\r\n]+/g, " ").slice(0, max)
    : fallback;
}

export function readProductSettings(): ProductSettings {
  let raw: Partial<Omit<ProductSettings, "logoUrl">> = {};
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as typeof raw;
  } catch {
    // Máy mới chưa có file -> dùng mặc định trung tính.
  }
  const logoFile =
    typeof raw.logoFile === "string" && /^[A-Za-z0-9._-]+$/.test(raw.logoFile)
      ? raw.logoFile
      : null;
  const logoPath = logoFile ? path.join(paths.dataDir, logoFile) : null;
  const logoExists = Boolean(logoPath && fs.existsSync(logoPath));
  const version = logoExists ? Math.round(fs.statSync(logoPath!).mtimeMs) : null;
  return {
    appName: cleanText(raw.appName, DEFAULTS.appName, 80),
    source: cleanText(raw.source, DEFAULTS.source, 160),
    logoFile: logoExists ? logoFile : null,
    logoUrl: logoExists ? `/api/product-settings/logo?v=${version}` : null,
  };
}

export function updateProductSettings(patch: { appName?: unknown; source?: unknown }): ProductSettings {
  const current = readProductSettings();
  const next = {
    appName:
      patch.appName !== undefined ? cleanText(patch.appName, DEFAULTS.appName, 80) : current.appName,
    source:
      patch.source !== undefined ? cleanText(patch.source, DEFAULTS.source, 160) : current.source,
    logoFile: current.logoFile,
  };
  ensureDir(paths.dataDir);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  return readProductSettings();
}

export function saveProductLogo(tmpPath: string, mime: string): ProductSettings {
  const ext = mime === "image/svg+xml" ? ".svg" : mime === "image/jpeg" ? ".jpg" : ".png";
  ensureDir(paths.dataDir);
  // Đọc metadata trước khi xóa logo cũ. Nếu đọc sau, readProductSettings sẽ
  // thấy logo cũ không còn tồn tại và vô tình trả appName/source mặc định.
  const current = readProductSettings();
  for (const name of fs.readdirSync(paths.dataDir)) {
    if (/^app-logo\.(png|jpg|svg)$/i.test(name)) fs.rmSync(path.join(paths.dataDir, name), { force: true });
  }
  const logoFile = `app-logo${ext}`;
  fs.copyFileSync(tmpPath, path.join(paths.dataDir, logoFile));
  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({ appName: current.appName, source: current.source, logoFile }, null, 2) + "\n",
    "utf8",
  );
  return readProductSettings();
}

export function productLogoPath(): string | null {
  const settings = readProductSettings();
  return settings.logoFile ? path.join(paths.dataDir, settings.logoFile) : null;
}
