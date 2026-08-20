"use client";

import { IconButton } from "@/components/IconButton";
import { useT } from "@/lib/i18n";

/**
 * Nút đổi ngôn ngữ trên header - hiện lá cờ của ngôn ngữ HIỆN TẠI,
 * bấm thì chuyển sang ngôn ngữ còn lại (vi ↔ en).
 * Cờ là SVG tự vẽ trong public/flags/ - không icon font, không emoji.
 *
 * Dùng <IconButton> để cùng đúng một hình dạng với nút đổi theme đứng ngay
 * cạnh - trước đây hai nút này tự dựng cùng một chuỗi class 36px, lệch cỡ với
 * mọi nút icon còn lại của app.
 */
export function LanguageToggle() {
  const { lang, setLang } = useT();
  const next = lang === "vi" ? "en" : "vi";
  const title = lang === "vi" ? "Switch to English" : "Chuyển sang tiếng Việt";

  return (
    <IconButton label={title} onClick={() => setLang(next)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={lang === "vi" ? "/flags/vn.svg" : "/flags/gb.svg"}
        alt={lang === "vi" ? "Tiếng Việt" : "English"}
        width={20}
        height={14}
        className="h-[14px] w-5 rounded-[2px] border border-[var(--border)] object-cover"
      />
    </IconButton>
  );
}
