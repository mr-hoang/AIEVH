"use client";

/**
 * Style Design dùng chung giữa các nơi tạo sản phẩm (Tạo ảnh, Brief video):
 * - useStyles(): danh sách style + defaultId, cache module-level 1 fetch/phiên UI
 * - refreshStyles(): bust cache - trang /styles gọi sau mỗi lần sửa
 * - StyleSelect: select chọn style, option đầu "Mặc định (<tên default>)" = null
 */

import { useEffect, useState } from "react";
import { getStyles, type StyleDesign, type StylesResponse } from "@/lib/api";
import { useT } from "@/lib/i18n";

// Cache module-level - style ít đổi, một lần fetch mỗi phiên UI là đủ;
// trang /styles sửa xong sẽ gọi refreshStyles() để nơi khác nhận bản mới.
let stylesCache: StylesResponse | null = null;
let stylesPromise: Promise<StylesResponse> | null = null;

/** Bust cache styles - gọi sau khi tạo/sửa/xóa/đổi default ở trang /styles. */
export function refreshStyles(): void {
  stylesCache = null;
  stylesPromise = null;
}

export function useStyles(): {
  data: StylesResponse | null;
  error: string | null;
} {
  const [data, setData] = useState<StylesResponse | null>(stylesCache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stylesCache) return;
    let alive = true;
    if (!stylesPromise) {
      stylesPromise = getStyles().then((r) => {
        stylesCache = r;
        return r;
      });
    }
    stylesPromise
      .then((r) => {
        if (alive) setData(r);
      })
      .catch((e) => {
        // fetch hỏng → cho phép thử lại ở lần mount sau
        stylesPromise = null;
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return { data, error };
}

/** Nhãn option của một style - tên + tags rút gọn (tối đa 3 tag). */
export function styleOptionLabel(s: StyleDesign): string {
  const tags = s.tags.slice(0, 3).join(", ");
  const more = s.tags.length > 3 ? "…" : "";
  return tags ? `${s.name} - ${tags}${more}` : s.name;
}

/** Tên style hiển thị cho một styleId (null = mặc định) - dùng ở tóm tắt. */
export function styleDisplayName(
  data: StylesResponse | null,
  styleId: string | null,
  t: (key: string) => string
): string {
  const defaultStyle =
    data?.styles.find((s) => s.id === data.defaultId) ?? null;
  if (styleId === null) {
    return defaultStyle
      ? `${t("styles.default")} (${defaultStyle.name})`
      : t("styles.default");
  }
  return data?.styles.find((s) => s.id === styleId)?.name ?? styleId;
}

/**
 * Select "Style Design" - value null = dùng style mặc định.
 * Style đã lưu không còn trong danh sách → vẫn hiển thị bằng id thô.
 */
export function StyleSelect({
  id,
  value,
  onChange,
  disabled = false,
  className = "input",
}: {
  id?: string;
  value: string | null;
  onChange: (styleId: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useT();
  const { data } = useStyles();
  const styles = data?.styles ?? [];
  const defaultStyle = styles.find((s) => s.id === data?.defaultId) ?? null;
  const missing = value !== null && !styles.some((s) => s.id === value);

  return (
    <select
      id={id}
      className={className}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">
        {defaultStyle
          ? `${t("styles.default")} (${defaultStyle.name})`
          : t("styles.default")}
      </option>
      {missing && <option value={value!}>{value}</option>}
      {styles.map((s) => (
        <option key={s.id} value={s.id}>
          {styleOptionLabel(s)}
        </option>
      ))}
    </select>
  );
}
