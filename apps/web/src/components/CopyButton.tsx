"use client";

/**
 * Copy một đoạn text vào clipboard, đổi icon sang dấu tick trong 1,5 giây.
 *
 * Trước đợt đại tu có hai bản: ProjectPublishCard dùng nút chữ nhỏ dạng ghost,
 * SystemCheckCard dùng <Button variant="secondary" small> - cùng một hành động,
 * hai hình dạng không liên quan gì đến nhau.
 */

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "@/components/IconButton";
import { useT } from "@/lib/i18n";

const RESET_MS = 1500;

export function CopyButton({
  value,
  label,
  size = "md",
}: {
  value: string;
  /** Tooltip/aria - nói rõ copy CÁI GÌ ("Copy tiêu đề" chứ không phải "Copy") */
  label?: string;
  size?: "sm" | "md";
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  // Dọn timer khi component tháo ra giữa chừng - setState sau unmount là
  // cảnh báo trong dev và rò rỉ nhẹ trong production.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), RESET_MS);
    return () => clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Trình duyệt chặn clipboard (không phải https, không có quyền) - im
      // lặng bỏ qua, người dùng vẫn bôi đen copy tay được.
    }
  }

  return (
    <IconButton
      label={copied ? t("common.copied") : (label ?? t("common.copy"))}
      size={size}
      onClick={copy}
    >
      {copied ? (
        <Check
          size={size === "sm" ? 13 : 15}
          strokeWidth={2.5}
          className="text-[var(--success)]"
        />
      ) : (
        <Copy size={size === "sm" ? 13 : 15} strokeWidth={2} />
      )}
    </IconButton>
  );
}
