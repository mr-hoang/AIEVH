"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/Button";

/**
 * Error boundary toàn app. Nguyên nhân phổ biến nhất: tab đang mở bản build cũ
 * trong khi server đã thay bản mới → chunk JS cũ không còn → điều hướng lỗi.
 * Tự reload MỘT lần để lấy bản mới (guard chống vòng lặp reload).
 *
 * KHÔNG dùng useT() ở đây: boundary này phải sống được cả khi chính
 * LanguageProvider là thứ vừa ném lỗi, lúc đó useT() sẽ throw và người dùng
 * nhận màn trắng thay vì thông báo. Đọc thẳng localStorage cho chắc.
 */

type Lang = "vi" | "en";

function currentLang(): Lang {
  try {
    return localStorage.getItem("aiev-lang") === "en" ? "en" : "vi";
  } catch {
    return "vi";
  }
}

const TEXT = {
  vi: {
    reloading: "Đang tải bản mới của giao diện…",
    title: "Trang gặp lỗi",
    stale:
      "Giao diện vừa được cập nhật nên bản đang mở trong tab này không còn dùng được. Tải lại trang là xong.",
    unknown: "Lỗi không xác định.",
    reload: "Tải lại trang",
    retry: "Thử lại",
    detail: "Chi tiết kỹ thuật",
  },
  en: {
    reloading: "Loading the new interface…",
    title: "Page error",
    stale:
      "The interface was just updated, so the version open in this tab no longer works. Reloading fixes it.",
    unknown: "Unknown error.",
    reload: "Reload page",
    retry: "Try again",
    detail: "Technical detail",
  },
} as const;

/**
 * Lỗi "mất chunk" - tab giữ bản build cũ, file JS đã bị bản build mới thay tên.
 * Thông báo gốc của Next là tiếng Anh kỹ thuật ("Failed to load chunk … from
 * module 64893"), người dùng đọc không hiểu phải làm gì.
 */
function isStaleBuildError(message: string): boolean {
  return /load chunk|loading chunk|ChunkLoadError|Loading CSS chunk|dynamically imported module/i.test(
    message,
  );
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [autoReloading, setAutoReloading] = useState(true);
  const [lang, setLang] = useState<Lang>("vi");
  const t = TEXT[lang];

  useEffect(() => {
    setLang(currentLang());
    const KEY = "auto-reload-at";
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last > 15_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    } else {
      // Vừa auto-reload xong mà vẫn lỗi → lỗi thật, hiện UI cho người dùng
      setAutoReloading(false);
    }
  }, []);

  if (autoReloading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="progress-indeterminate w-56" />
        <p className="text-sm text-[var(--text-muted)]">{t.reloading}</p>
      </div>
    );
  }

  const stale = isStaleBuildError(error.message ?? "");

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      {/* Bậc tiêu đề TRANG: đây là dòng duy nhất nói cho người dùng biết chuyện
          gì vừa xảy ra, không phải một nhãn phụ. */}
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className="max-w-md text-sm text-[var(--text-muted)]">
        {stale ? t.stale : error.message || t.unknown}
      </p>
      <div className="flex gap-2">
        <Button onClick={() => window.location.reload()}>{t.reload}</Button>
        <Button variant="secondary" onClick={reset}>
          {t.retry}
        </Button>
      </div>
      {/* Vẫn giữ nguyên văn lỗi cho người đi báo bug - chỉ là không đập vào mặt */}
      {stale && error.message && (
        <details className="max-w-md">
          <summary className="cursor-pointer text-meta text-[var(--text-muted)]">
            {t.detail}
          </summary>
          <p className="mt-1 break-all font-mono text-meta text-[var(--text-muted)]">
            {error.message}
          </p>
        </details>
      )}
    </div>
  );
}
