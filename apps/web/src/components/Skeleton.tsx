"use client";

/**
 * Khung xám lúc chờ dữ liệu.
 *
 * Trước đợt đại tu có BA kiểu chờ cho cùng một trạng thái: câu "Đang tải…" căn
 * giữa trang (đa số trang danh sách), card `animate-pulse` cao cố định (Cấu
 * hình, Kết nối), và một component Skeleton định nghĩa ngay trong app/page.tsx
 * - tức là một primitive nằm ngoài thư mục primitive. Giờ chỉ còn file này.
 *
 * VÌ SAO KHUNG XÁM CHỨ KHÔNG PHẢI CHỮ "Đang tải…": khung giữ đúng chỗ mà nội
 * dung sắp chiếm, nên lúc dữ liệu về trang không nhảy. Câu chữ căn giữa thì
 * biến mất và đẩy toàn bộ nội dung lên - mỗi lần tải trang là một cú giật.
 */

export function Skeleton({
  className = "",
  height,
}: {
  className?: string;
  /** Chiều cao px khi cần khớp đúng khối sắp thay thế (biểu đồ, ảnh preview) */
  height?: number;
}) {
  return (
    <div
      className={`skeleton ${className}`}
      style={height ? { height } : undefined}
      aria-hidden="true"
    />
  );
}

/**
 * Khung chờ cho bảng - giữ đúng số hàng để bảng không co giãn lúc dữ liệu về.
 * Đặt TRONG <Card>, thay chỗ cho <table>.
 */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * Khung chờ cho lưới thẻ (Prompts, Skills, Style Design).
 * Số cột do lưới cha quyết định - component này chỉ đẻ ra đúng số ô.
 */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-32 w-full" />
      ))}
    </>
  );
}
