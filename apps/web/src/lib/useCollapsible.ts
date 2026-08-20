"use client";

/**
 * Trạng thái gấp/mở của một NHÓM khối trong cùng một cột workspace.
 *
 * Bài học đã trả giá (xem comment gốc trong text-to-video/[id]/page.tsx): tuyệt
 * đối KHÔNG dùng useEffect để đồng bộ trạng thái gấp theo status. Các trang chi
 * tiết bám SSE job + agent, mỗi dòng log là một lần render mới, nên effect kiểu
 * đó sẽ đóng sập đúng cái khối người dùng vừa mở - và triệu chứng trông như trang
 * "tự nhảy", không ai lần ra là do SSE.
 *
 * Cách làm ở đây: mặc định được SUY RA từ `finished` ngay trong lúc render, còn
 * mỗi lần người dùng bấm thì ghi vào map `override`. Đã bấm là ý người dùng thắng
 * vĩnh viễn (cho tới khi reset), dù sau đó job có đổi trạng thái bao nhiêu lần.
 *
 * ```tsx
 * const SETUP = ["source", "script", "voice", "config"] as const;
 * const group = useCollapseGroup({
 *   keys: SETUP,
 *   finished: session.status === "done",
 * });
 * <WorkspaceBlock
 *   id="ttv-source"
 *   collapsed={group.isCollapsed("source")}
 *   onToggle={() => group.toggle("source")}
 * />
 * ```
 */

import { useState } from "react";

export interface CollapseGroup<K extends string> {
  /** Khối này đang gấp hay không - ý người dùng trước, mặc định sau */
  isCollapsed: (key: K) => boolean;
  /** Đảo trạng thái và ghi nhận là "người dùng đã tự tay bấm" */
  toggle: (key: K) => void;
  /** Đặt thẳng giá trị, cũng tính là người dùng đã bấm */
  set: (key: K, collapsed: boolean) => void;
  /** Bỏ hết ghi đè, quay lại chạy theo mặc định suy từ `finished` */
  reset: () => void;
  /** Có khối nào đang gấp không - dùng để hiện dòng giải thích "vì sao gọn hẳn" */
  anyCollapsed: boolean;
  /** Người dùng đã bấm tay khối nào chưa */
  touched: boolean;
}

export function useCollapseGroup<K extends string>({
  keys,
  finished,
  keepExpanded,
  configured,
}: {
  /** Toàn bộ khối trong nhóm - thứ tự không quan trọng */
  keys: readonly K[];
  /** Trang báo "việc đã xong": mặc định chuyển sang gấp hết cho gọn màn hình */
  finished: boolean;
  /**
   * "Khối này đã chọn xong cấu hình chưa" - trả true thì MẶC ĐỊNH gấp lại, kể
   * cả khi việc chưa xong.
   *
   * Vì sao: khối cấu hình đã điền xong thì phần lớn thời gian nó chỉ chiếm chỗ.
   * Dòng tóm tắt của WorkspaceBlock đã nói đủ đang đặt gì, còn muốn sửa thì bấm
   * một cái là mở. Ngược lại khối CHƯA cấu hình phải mở sẵn - đó chính là việc
   * người dùng cần làm tiếp.
   *
   * Vẫn chỉ là MẶC ĐỊNH: người dùng tự bấm mở thì `override` thắng và khối ở
   * nguyên đấy, không có chuyện điền thêm một chữ là nó tự sập lại.
   */
  configured?: (key: K) => boolean;
  /**
   * Khối vẫn mở khi xong - chỗ đặt khối kết quả (video thành phẩm). Xong việc thì
   * người dùng vào trang là để XEM thành phẩm, không phải sửa ô nhập nữa.
   */
  keepExpanded?: readonly K[];
}): CollapseGroup<K> {
  // Chỉ chứa khối người dùng ĐÃ TỰ TAY bấm; khối chưa bấm vắng mặt ở đây và chạy
  // theo mặc định.
  const [override, setOverride] = useState<Partial<Record<K, boolean>>>({});

  const defaultCollapsed = (key: K): boolean => {
    if ((keepExpanded ?? []).includes(key)) return false;
    return finished || configured?.(key) === true;
  };

  const isCollapsed = (key: K): boolean =>
    override[key] ?? defaultCollapsed(key);

  const set = (key: K, collapsed: boolean) => {
    setOverride((o) => ({ ...o, [key]: collapsed }));
  };

  const toggle = (key: K) => {
    // Đảo dựa trên state trong updater chứ không trên biến của lần render này -
    // giữa lúc bấm vẫn có thể có sự kiện SSE chen vào làm render lại.
    setOverride((o) => ({ ...o, [key]: !(o[key] ?? defaultCollapsed(key)) }));
  };

  return {
    isCollapsed,
    toggle,
    set,
    reset: () => setOverride({}),
    anyCollapsed: keys.some((k) => isCollapsed(k)),
    touched: Object.keys(override).length > 0,
  };
}
