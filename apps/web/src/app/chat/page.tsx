import { redirect } from "next/navigation";

/**
 * Trang Chat đã bỏ - chat giờ nằm trong panel "AI của project" ở trang
 * project detail. Giữ route để link cũ không 404, redirect về Dashboard.
 */
export default function ChatPage() {
  redirect("/");
}
