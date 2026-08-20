"use client";

import { useEffect } from "react";

/**
 * Bắt lỗi tải chunk JS/CSS (tab đang chạy bản build cũ sau khi server thay bản mới)
 * và tự reload MỘT lần để lấy bản mới - kể cả khi lỗi không lọt vào error boundary
 * (vd: Next hiện màn "This page couldn't load" khi điều hướng client-side thất bại).
 */
export function StaleChunkGuard() {
  useEffect(() => {
    const KEY = "auto-reload-at";

    function reloadOnce() {
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last > 15_000) {
        sessionStorage.setItem(KEY, String(Date.now()));
        window.location.reload();
      }
    }

    function isChunkError(msg: string): boolean {
      return (
        /loading chunk|chunkloaderror|failed to fetch dynamically imported|import\(\)|_next\/static/i.test(
          msg,
        )
      );
    }

    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { name?: string; message?: string } | undefined;
      const text = `${reason?.name ?? ""} ${reason?.message ?? ""}`;
      if (isChunkError(text)) reloadOnce();
    };

    const onError = (e: ErrorEvent | Event) => {
      // Script/link tag fail → target là element có src/href trỏ vào _next/static
      const target = e.target as HTMLScriptElement | HTMLLinkElement | null;
      const url =
        (target as HTMLScriptElement)?.src || (target as HTMLLinkElement)?.href || "";
      if (typeof url === "string" && url.includes("/_next/static/")) reloadOnce();
    };

    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError, true); // capture để bắt lỗi resource
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError, true);
    };
  }, []);

  return null;
}
