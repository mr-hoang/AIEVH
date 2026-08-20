"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "@/components/IconButton";
import { useT } from "@/lib/i18n";

type Theme = "light" | "dark";

/**
 * Đọc/ghi localStorage("theme"), áp data-theme lên <html>.
 * Mặc định "light". Script inline trong layout đã chống FOUC.
 */
export function ThemeToggle() {
  const { t } = useT();
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current =
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "dark"
        : "light";
    setTheme(current);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage bị chặn - vẫn đổi theme cho phiên hiện tại
    }
    if (next === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  return (
    // <IconButton> chứ không dựng tay: nút này đứng ngay cạnh nút đổi ngôn ngữ
    // trên header, hai cái phải cùng một hình dạng.
    <IconButton
      label={theme === "dark" ? t("theme.to-light") : t("theme.to-dark")}
      onClick={toggle}
    >
      {theme === "dark" ? (
        <Sun size={18} strokeWidth={1.75} />
      ) : (
        <Moon size={18} strokeWidth={1.75} />
      )}
    </IconButton>
  );
}
