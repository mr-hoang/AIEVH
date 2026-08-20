"use client";

/**
 * Đa ngôn ngữ (vi/en) cho web UI - LanguageProvider + hook useT().
 * - Mặc định "vi", lưu lựa chọn vào localStorage("aiev-lang").
 * - Tránh hydration mismatch: luôn khởi tạo "vi" (khớp SSR), đọc lại
 *   localStorage trong useEffect sau khi mount.
 * - t(key): tra dictionary; en thiếu key → fallback vi; thiếu cả hai → trả key.
 * - tf(key, vars): t + thay {var} bằng giá trị - cho chuỗi động.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setFormatLang } from "@/lib/format";
import { vi } from "@/lib/locales/vi";
import { en } from "@/lib/locales/en";

export type Lang = "vi" | "en";

const STORAGE_KEY = "aiev-lang";

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
  tf: (key: string, vars: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("vi");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "en" || saved === "vi") setLangState(saved);
    } catch {
      // localStorage bị chặn - giữ mặc định vi
    }
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // vẫn đổi ngôn ngữ cho phiên hiện tại
    }
  }, []);

  // formatRelative/formatJobDuration đọc ngôn ngữ hiện tại từ module format -
  // set ngay trong render để mọi format phía dưới cây dùng đúng ngôn ngữ.
  setFormatLang(lang);

  const t = useCallback(
    (key: string): string =>
      lang === "en" ? (en[key] ?? vi[key] ?? key) : (vi[key] ?? key),
    [lang]
  );

  const tf = useCallback(
    (key: string, vars: Record<string, string | number>): string => {
      let out = t(key);
      for (const [k, v] of Object.entries(vars)) {
        out = out.split(`{${k}}`).join(String(v));
      }
      return out;
    },
    [t]
  );

  const value = useMemo(
    () => ({ lang, setLang, t, tf }),
    [lang, setLang, t, tf]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within <LanguageProvider>");
  return ctx;
}
