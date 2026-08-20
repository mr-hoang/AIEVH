import { redirect } from "next/navigation";

/** Route cũ /accelerate - trang đã đổi tên thành Cấu hình tại /config. */
export default function AccelerateRedirect() {
  redirect("/config");
}
