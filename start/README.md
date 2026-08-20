# Khởi động AI Edit Video

## Chạy hệ thống

**Windows** — nhấp đúp **`start.bat`**.
**macOS** — nhấp đúp **`start.command`** trong Finder (file `.sh` KHÔNG double-click được trên macOS — nó chỉ mở bằng trình soạn thảo). Lần đầu nếu macOS chặn "from an unidentified developer": chuột phải file → **Open** → Open. Hoặc chạy bằng Terminal:

```bash
chmod +x start/*.sh start/*.command   # chỉ cần lần đầu (tải ZIP mới cần; git clone thì đã sẵn)
./start/start.sh
```

Script (cả hai hệ) tự động:

1. Kiểm tra Node.js 22+
2. **Kiểm tra môi trường + cài phần còn thiếu** (`doctor.mjs` — xem mục dưới)
3. Cài dependencies nếu là lần chạy đầu (vài phút)
4. Build backend + web UI nếu chưa build hoặc code mới hơn bản build
5. Tạo file `.env` nếu chưa có
6. Chạy server (port 6869) + web (port 6868) — Windows mở cửa sổ log riêng, macOS ghi log vào `start/server.log` (`tail -f start/server.log` để xem)
7. Mở trình duyệt tại **http://localhost:6868**

Nếu hệ thống đang chạy sẵn, script chỉ mở lại trình duyệt; đang chạy dở dang (một trong hai port chết) thì tự dọn sạch và khởi động lại.

## Để app ở ổ C, lưu dữ liệu nặng ở ổ D (Windows)

1. Nhấp đúp `stop.bat` để dừng AIEV.
2. Nhấp đúp `set-storage.bat`.
3. Nhập nơi lưu, ví dụ `D:\AIEV-Data`.
4. Chờ báo hoàn tất rồi chạy lại `start.bat`.

Script tự chuyển dữ liệu hiện có và tạo junction của Windows. Project, video nguồn, MP4 xuất ra, model/cache runtime và staging render sẽ nằm thật trên ổ D, còn ứng dụng vẫn chạy ở vị trí hiện tại trên ổ C. Không tháo ổ D hoặc xóa các thư mục liên kết khi AIEV đang chạy.

## Kiểm tra môi trường — `doctor.mjs`

Một file duy nhất kiểm tra máy đã đủ đồ chưa: **Node.js, FFmpeg, Google Chrome, xác thực Claude,
faster-whisper (phụ đề), khóa Gemini (tạo ảnh), cloudflared (tunnel), GPU**.

Thiếu thứ nào cài tự động được thì script hỏi `[Y/n]` rồi cài luôn (winget trên Windows, brew trên
macOS, npm/pip cho phần còn lại). Thứ nào không tự cài được — cài Node, đăng nhập Claude, dán API
key — thì in ra đúng việc cần làm. **Thiếu đồ không chặn hệ thống khởi động**: dashboard vẫn lên,
và card **Kiểm tra hệ thống** trong tab Cấu hình hiện y hệt danh sách đó kèm nút cài một chạm.

```bash
node start/doctor.mjs              # chỉ xem
node start/doctor.mjs --fix        # thiếu gì hỏi cài nấy
node start/doctor.mjs --fix --yes  # cài luôn, không hỏi
node start/doctor.mjs --json       # cho máy đọc (backend dùng đường này)
node start/doctor.mjs --lang en    # tiếng Anh
```

Đây là nguồn sự thật duy nhất cho cả terminal lẫn web (`GET /api/doctor`) — thêm một mục kiểm tra
thì sửa đúng một chỗ.

## Dừng hệ thống

- Windows: nhấp đúp **`stop.bat`** (hoặc đóng cửa sổ log AIEV)
- macOS: nhấp đúp **`stop.command`**
- Linux: `./start/stop.sh`

> Chưa đăng nhập Claude thì `start.command` (macOS) mở sẵn Claude Code để bạn gõ `/login` — bước
> đăng nhập là OAuth qua trình duyệt nên phải có bạn xác nhận, không tự làm thay được.

## Bật tính năng Chat / Edit AI

Cách 1 (khuyên dùng): đăng nhập Claude Code trên máy — chạy `claude` trong terminal rồi `/login` — hệ thống tự dùng gói subscription.

Cách 2: mở file `.env` ở thư mục gốc, điền `ANTHROPIC_API_KEY=sk-ant-...` (lấy tại https://console.anthropic.com/settings/keys) rồi chạy lại script.

Tạo ảnh AI cần thêm `GEMINI_API_KEY` trong `.env` (lấy tại https://aistudio.google.com/apikey) — hoặc điền ngay trên web UI, tab **Kết nối**.

## Dành cho dev

Muốn chạy chế độ dev (hot-reload) thay vì bản build: `npm run dev` ở thư mục gốc.
