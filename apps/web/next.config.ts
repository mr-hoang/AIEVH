import type { NextConfig } from "next";

const SERVER_PORT = process.env.SERVER_PORT || "6869";

const nextConfig: NextConfig = {
  // MỘT biến SERVER_PORT điều khiển cả hai đường tới backend:
  // - rewrites bên dưới (proxy /api, /media qua Next);
  // - serverOrigin() trong lib/api.ts (client gọi THẲNG backend cho upload,
  //   bootstrap token) - phía client chỉ đọc được biến NEXT_PUBLIC_*.
  // Lưu ý: NEXT_PUBLIC_* được "nướng" vào bundle LÚC BUILD - đổi SERVER_PORT
  // thì phải build lại (dev server tự restart là đủ).
  env: {
    NEXT_PUBLIC_SERVER_PORT:
      process.env.SERVER_PORT ?? process.env.NEXT_PUBLIC_SERVER_PORT ?? "6869",
  },
  // Huy hiệu dev-tools của Next mặc định neo góc TRÁI DƯỚI - đúng chỗ nút thu gọn
  // thanh điều hướng nằm, nên lúc chạy `npm run dev` nó đè lên nút (bản production
  // không có huy hiệu này). Đẩy sang phải cho khỏi vướng.
  devIndicators: {
    position: "bottom-right",
  },
  experimental: {
    // Proxy rewrite mặc định timeout 30s - video lớn (media/stream) cần lâu hơn.
    // Trên LAN upload đi thẳng backend, nhưng qua domain công cộng thì mọi thứ
    // kể cả upload đều chui qua đây, nên hai mốc dưới là đường đi chính.
    proxyTimeout: 10 * 60 * 1000,
    // Proxy mặc định CẮT body ở 10MB: phần vượt bị bỏ, multer chờ hết stream
    // rồi timeout -> upload video qua domain công cộng chết với lỗi 500 khó hiểu.
    // Nới bằng mức multer đang cho phép (2GB) để một chỗ không âm thầm chặn chỗ kia.
    proxyClientMaxBodySize: 2 * 1024 * 1024 * 1024,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://localhost:${SERVER_PORT}/api/:path*`,
      },
      {
        source: "/media/:path*",
        destination: `http://localhost:${SERVER_PORT}/media/:path*`,
      },
    ];
  },
};

export default nextConfig;
