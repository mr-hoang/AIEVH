"use client";

/**
 * Chọn PHONG CÁCH DỰNG cho video (giấy gấp, mực tàu, người que...).
 *
 * VÌ SAO KHÔNG DÙNG <select>: có 20 phong cách, mà cái tên tự nó không nói được
 * video sẽ trông ra sao - "Đông Hồ" hay "cắt dán báo" chỉ có nghĩa với người đã
 * biết. Người dùng cần đọc được MÔ TẢ và CÁCH CHUYỂN ĐỘNG trước khi chọn, việc
 * đó một select không làm được.
 *
 * KHÔNG CÒN THẺ "AI tự quyết": việc "không dùng phong cách riêng" giờ là CÔNG
 * TẮC ở BriefFields - tắt thì cả khối này không hiện ra. Để lại thêm một thẻ
 * mang cùng ý nghĩa bên trong danh sách là hai đường làm một việc, mà lại mâu
 * thuẫn: công tắc đang bật trong khi thẻ nói "để AI tự quyết".
 *
 * Bật công tắc mà chưa chọn phong cách nào thì component này NÓI RÕ là đang y
 * hệt lúc tắt - im lặng ở đây là người dùng tưởng đã chọn xong.
 */

import { AlertTriangle, Palette, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getVideoStyles, type VideoStyle } from "@/lib/api";
import { Badge } from "@/components/Badge";
import { Banner } from "@/components/Banner";
import { ErrorBanner } from "@/components/ErrorBanner";
import { OptionCard, OptionCardGroup } from "@/components/OptionCard";
import { Panel } from "@/components/Panel";
import { Skeleton } from "@/components/Skeleton";
import { useT } from "@/lib/i18n";

/**
 * TÊN luôn lấy từ server, KHÔNG lấy bản dịch.
 *
 * Phong cách dựng giờ sửa được ở tab riêng. Ưu tiên key dịch như trước thì người
 * dùng đổi tên một phong cách dựng sẵn xong: prompt gửi AI đổi ngay, còn nhãn
 * trong Kịch bản edit vẫn là tên cũ - hai nơi nói hai kiểu về cùng một thứ, và
 * người dùng tưởng thao tác sửa không ăn.
 *
 * Đánh đổi đã cân nhắc: giao diện tiếng Anh mất tên dịch của 20 phong cách dựng
 * sẵn. Chấp nhận được, vì chúng vốn là khái niệm thuần Việt (giấy gấp Nhật, mực
 * tàu, tranh Đông Hồ) và tên do người dùng đặt mới là thứ phải đúng.
 */
function nameOf(s: VideoStyle): string {
  return s.name;
}

function descOf(s: VideoStyle, t: (k: string) => string): string {
  const key = `vstyle.${s.id}.desc`;
  const v = t(key);
  // Không có mô tả riêng thì hiện cách chuyển động - vẫn hữu ích hơn là để trống
  return v === key ? s.motion : v;
}

export function VideoStyleSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [styles, setStyles] = useState<VideoStyle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    getVideoStyles()
      .then((list) => {
        if (!alive) return;
        setStyles(list);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setStyles([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const list = useMemo(() => styles ?? [], [styles]);
  const q = query.trim().toLowerCase();
  // Tìm cả trong tên ĐÃ DỊCH và mô tả - gõ "paper" ở bản tiếng Anh phải ra được
  const filtered = q
    ? list.filter(
        (s) =>
          nameOf(s).toLowerCase().includes(q) ||
          descOf(s, t).toLowerCase().includes(q) ||
          s.id.includes(q)
      )
    : list;

  const selected = list.find((s) => s.id === value) ?? null;
  // Phong cách đã lưu nhưng không còn trong catalog - nói ra chứ đừng im lặng bỏ
  const missing = value !== null && list.length > 0 && !selected;

  return (
    <div className="flex flex-col gap-2">
      {error && <ErrorBanner message={t("vstyle.load-error")} detail={error} />}

      {/* Dòng tóm tắt: danh sách cuộn trong khung riêng nên chọn xong kéo đi chỗ
          khác là quên mất mình đã chọn gì */}
      <Panel>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 text-meta text-[var(--text-muted)]">
            {t("vstyle.selected")}
          </span>
          {selected ? (
            <>
              <span className="min-w-0 text-sm font-semibold text-[var(--primary)]">
                {nameOf(selected)}
              </span>
              {selected.palette === "loose" && (
                <Badge
                  tone="danger"
                  dot={false}
                  label={t("vstyle.loose-badge")}
                />
              )}
            </>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-2 text-sm text-[var(--text-muted)]">
              <AlertTriangle size={14} strokeWidth={2} className="shrink-0" />
              {t("vstyle.none")}
            </span>
          )}
        </div>
      </Panel>

      {missing && <Banner tone="danger" message={t("vstyle.missing")} />}
      {/* Bật công tắc nhưng chưa chọn = y hệt lúc tắt. Nói thẳng ra, đừng để
          người dùng phát hiện khi xem video xong. `missing` đã có banner riêng
          nói đúng nguyên nhân nên không chồng hai banner lên nhau. */}
      {value === null && !missing && (
        <Banner tone="danger" message={t("vstyle.none-warning")} />
      )}

      {list.length > 8 && (
        <div className="relative">
          <Search
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            className="input pl-8"
            value={query}
            disabled={disabled}
            aria-label={t("vstyle.search")}
            placeholder={t("vstyle.search")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {styles === null ? (
        <Skeleton className="w-full" height={220} />
      ) : (
        <Panel className="max-h-[300px] overflow-y-auto">
          {/* Mô tả hiện ĐỦ, không cắt và không thu nhỏ: đúng phần giúp người
              dùng phân biệt hai phong cách lại là phần dễ bị hy sinh nhất.
              Ô lưới tự kéo bằng nhau nên thẻ vẫn thẳng hàng. */}
          {/* Tối đa HAI cột: tiêu đề thẻ cắt bằng "…" nên cột càng hẹp càng dễ
              nuốt mất tên phong cách, mà tên chính là thứ để phân biệt. */}
          <OptionCardGroup
            label={t("vstyle.label")}
            className="grid-cols-1 sm:grid-cols-2"
          >
            {filtered.map((s) => (
              <OptionCard
                key={s.id}
                selected={value === s.id}
                disabled={disabled}
                title={nameOf(s)}
                description={descOf(s, t)}
                badge={
                  s.palette === "loose" ? (
                    <Badge
                      tone="danger"
                      dot={false}
                      label={t("vstyle.loose-badge")}
                    />
                  ) : undefined
                }
                onSelect={() => onChange(s.id)}
              />
            ))}
          </OptionCardGroup>
          {filtered.length === 0 && q && (
            <p className="py-4 text-center text-sm text-[var(--text-muted)]">
              {t("vstyle.no-match")}
            </p>
          )}
        </Panel>
      )}

      <p className="flex items-start gap-2 text-meta text-[var(--text-muted)]">
        <Palette size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
        {t("vstyle.vs-style-design")}
      </p>
    </div>
  );
}
