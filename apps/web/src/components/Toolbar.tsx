"use client";

/**
 * Hàng công cụ đứng ĐẦU MỖI CARD DANH SÁCH: ô tìm kiếm, bộ lọc, và - khi có
 * hàng được tick - chuyển thành thanh thao tác hàng loạt.
 *
 * Trước đợt đại tu, cùng một thanh này được đặt ba chỗ khác nhau: bên TRONG
 * card ở Videos Project và Images Project, bên NGOÀI card ở Style Design, và
 * không có ở Render Queue / Assets dù đó mới là danh sách dài nhất. Ô tìm kiếm
 * của Sound Effects thì lơ lửng ngoài card, không thuộc về cái gì cả.
 *
 * Chốt: LUÔN nằm trong card, ngay trên bảng, nền --bg-subtle để tách khỏi phần
 * dữ liệu bên dưới mà không cần thêm đường kẻ.
 *
 * ```tsx
 * <Card>
 *   <Toolbar
 *     search={{ value: q, onChange: setQ, placeholder: t("sfx.search") }}
 *     selectedCount={selected.size}
 *     bulkActions={<Button variant="destructive" small …>…</Button>}
 *     onClearSelection={() => setSelected(new Set())}
 *   >
 *     <FilterChips … />
 *   </Toolbar>
 *   <table className="table">…</table>
 * </Card>
 * ```
 */

import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/Button";
import { IconButton } from "@/components/IconButton";
import { useT } from "@/lib/i18n";

export function Toolbar({
  search,
  selectedCount = 0,
  bulkActions,
  onClearSelection,
  actions,
  children,
}: {
  search?: {
    value: string;
    onChange: (next: string) => void;
    placeholder: string;
  };
  /** > 0 thì toolbar chuyển sang chế độ thao tác hàng loạt */
  selectedCount?: number;
  bulkActions?: ReactNode;
  onClearSelection?: () => void;
  /** Nút bên phải lúc KHÔNG chọn gì (vd "Làm mới") */
  actions?: ReactNode;
  /** Chip lọc - xuống hàng dưới khi danh sách chip dài */
  children?: ReactNode;
}) {
  const { t } = useT();
  const selecting = selectedCount > 0;

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-[var(--radius)] bg-[var(--bg-subtle)] px-3 py-2">
      {/* Hàng thao tác hàng loạt xếp THÊM lên trên, KHÔNG thay chỗ hàng tìm
          kiếm. Bản đầu cho nó thay chỗ để bảng khỏi tụt xuống, nhưng như thế là
          giấu mất ô tìm kiếm đúng lúc nó quan trọng nhất: đang lọc "a", tick 5
          dòng, thì bằng chứng duy nhất trên màn hình rằng danh sách ĐANG BỊ LỌC
          biến mất - người dùng đọc "5 đã chọn" và tưởng đó là 5 trong toàn bộ
          danh sách. Tụt một hàng đổi lấy chuyện đó là đáng. */}
      {selecting && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {selectedCount} {t("common.selected")}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {bulkActions}
            {onClearSelection && (
              <Button variant="secondary" small onClick={onClearSelection}>
                <X size={14} strokeWidth={2} aria-hidden="true" />
                {t("common.deselect")}
              </Button>
            )}
          </div>
        </div>
      )}

      {(search || actions) && (
          <div className="flex flex-wrap items-center gap-2">
            {search && (
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search
                  size={15}
                  strokeWidth={2}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-muted)]"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  className="input h-8 pl-8"
                  value={search.value}
                  placeholder={search.placeholder}
                  aria-label={search.placeholder}
                  onChange={(e) => search.onChange(e.target.value)}
                />
                {search.value && (
                  <IconButton
                    label={t("common.clear")}
                    size="sm"
                    onClick={() => search.onChange("")}
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                  >
                    <X size={13} strokeWidth={2} />
                  </IconButton>
                )}
              </div>
            )}
            {actions && (
              <div className="ml-auto flex items-center gap-2">{actions}</div>
            )}
          </div>
      )}

      {/* Chip lọc VẪN HIỆN lúc đang chọn nhiều: ẩn đi thì người dùng không thấy
          mình đang chọn trong phạm vi lọc nào, dễ tưởng "xóa đã chọn" là xóa
          hết cả danh sách. */}
      {children && (
        <div className="flex flex-wrap items-center gap-1">{children}</div>
      )}
    </div>
  );
}

/** Chip lọc bật/tắt - cùng hình dạng ở mọi trang danh sách. */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`chip transition-colors duration-150 ${
        active
          ? "border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary)]"
          : "hover:border-[var(--text-muted)] hover:text-[var(--text)]"
      }`}
    >
      {children}
    </button>
  );
}
