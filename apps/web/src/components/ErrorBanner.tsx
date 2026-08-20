"use client";

/**
 * Banner lỗi. Giữ nguyên tên và chữ ký cũ vì đang có hơn 40 chỗ gọi - phần
 * ruột chuyển hẳn sang <Banner tone="danger">, nơi có đủ bốn tông (lỗi / thành
 * công / thông tin / trung tính) dùng chung một hình dạng.
 *
 * Code mới cần báo THÀNH CÔNG hay THÔNG TIN thì gọi thẳng <Banner>.
 */

import type { ReactNode } from "react";
import { Banner } from "@/components/Banner";

export function ErrorBanner({
  message,
  detail,
  actions,
}: {
  message: ReactNode;
  detail?: string;
  actions?: ReactNode;
}) {
  return <Banner tone="danger" message={message} detail={detail} actions={actions} />;
}
