"use client";

import { Info, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";

/**
 * Nút (i) giải thích một chức năng: bấm vào hiện popover mô tả chức năng đó
 * dùng để làm gì. Nội dung lấy từ từ điển i18n nên tự động song ngữ.
 *
 * VÌ SAO render qua portal + position fixed: dashboard có RẤT nhiều khối
 * `overflow-x-auto` / `overflow-y-auto` (bảng render, danh sách asset, sidebar,
 * body của Modal). Popover đặt absolute bên trong các khối đó sẽ bị cắt cụt hoặc
 * đẻ thêm thanh cuộn. Portal ra body rồi tính toạ độ từ rect của nút là cách duy
 * nhất chắc chắn không bị cắt ở mọi chỗ dùng.
 */

/** Bề rộng popover - đủ cho 2-4 câu, không tràn màn hình hẹp */
const WIDTH = 300;
/** Khoảng cách từ nút tới popover */
const GAP = 8;
/** Chừa mép màn hình để popover không dính sát viền */
const MARGIN = 12;

interface Pos {
  top: number;
  left: number;
  /** true = popover nằm TRÊN nút (không đủ chỗ bên dưới) */
  above: boolean;
}

export function InfoHint({
  /** Khóa i18n phần tiêu đề, vd "help.qc.title" */
  titleKey,
  /** Khóa i18n phần mô tả - xuống dòng bằng "\n" sẽ tách thành nhiều đoạn */
  bodyKey,
  className = "",
  /** Cỡ icon - mặc định 13 hợp với nhãn nhỏ, dùng 15 cạnh tiêu đề card */
  size = 13,
}: {
  titleKey: string;
  bodyKey: string;
  className?: string;
  size?: number;
}) {
  const { t } = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Ước lượng chiều cao trước khi popover có mặt trong DOM; đo lại ở effect sau
    const h = popRef.current?.offsetHeight ?? 140;
    const below = window.innerHeight - r.bottom;
    const above = below < h + GAP + MARGIN && r.top > below;
    const left = Math.min(
      Math.max(MARGIN, r.left + r.width / 2 - WIDTH / 2),
      Math.max(MARGIN, window.innerWidth - WIDTH - MARGIN),
    );
    setPos({
      top: above ? r.top - GAP - h : r.bottom + GAP,
      left,
      above,
    });
  }, []);

  // Mở xong mới đo được chiều cao thật -> đặt lại vị trí một lần cho khớp
  useEffect(() => {
    if (!pos) return;
    const id = requestAnimationFrame(place);
    return () => cancelAnimationFrame(id);
    // Chỉ chạy khi vừa mở, không lặp vô hạn theo pos
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos !== null]);

  // Đóng khi bấm ra ngoài / Escape / cuộn trang (toạ độ fixed sẽ lệch khi cuộn)
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPos(null);
    };
    const close = () => setPos(null);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    // capture: bắt cả cuộn trong khối con, không chỉ cuộn window
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  const open = pos !== null;
  const paragraphs = t(bodyKey).split("\n").filter(Boolean);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          // Nút thường nằm trong hàng/thẻ bấm được - đừng kích hoạt hành động đó
          e.stopPropagation();
          e.preventDefault();
          if (open) setPos(null);
          else place();
        }}
        aria-label={t("help.aria")}
        aria-expanded={open}
        className={`inline-flex shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--primary)] ${
          open ? "text-[var(--primary)]" : ""
        } ${className}`}
      >
        <Info size={size} strokeWidth={2} />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={t(titleKey)}
            style={{ top: pos.top, left: pos.left, width: WIDTH }}
            className="fixed z-[60] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-lg"
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <p className="text-xs font-semibold">{t(titleKey)}</p>
              <button
                type="button"
                onClick={() => setPos(null)}
                aria-label={t("common.close")}
                className="-mr-1 -mt-1 shrink-0 rounded-[var(--radius)] p-1 text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-subtle)] hover:text-[var(--text)]"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {paragraphs.map((p, i) => (
                <p
                  key={i}
                  className="text-xs leading-relaxed text-[var(--text-muted)]"
                >
                  {p}
                </p>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
