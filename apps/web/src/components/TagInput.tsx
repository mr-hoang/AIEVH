"use client";

import { X } from "lucide-react";
import { useState } from "react";
import { useT } from "@/lib/i18n";

/**
 * Chip input dùng chung (modal tạo project, form khác):
 * gõ + Enter để thêm tag, X để xóa, tự chống trùng.
 */
export function TagInput({
  tags,
  onChange,
  id,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  id?: string;
  /** Mặc định t("taginput.placeholder"). */
  placeholder?: string;
}) {
  const { t, tf } = useT();
  const [input, setInput] = useState("");

  function add() {
    const tag = input.trim();
    if (!tag) return;
    setInput("");
    if (tags.includes(tag)) return;
    onChange([...tags, tag]);
  }

  return (
    <div>
      {tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span key={tag} className="chip">
              {tag}
              <button
                type="button"
                aria-label={tf("taginput.remove-aria", { tag })}
                className="text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--danger)]"
                onClick={() => onChange(tags.filter((x) => x !== tag))}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        id={id}
        className="input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        placeholder={placeholder ?? t("taginput.placeholder")}
      />
    </div>
  );
}
