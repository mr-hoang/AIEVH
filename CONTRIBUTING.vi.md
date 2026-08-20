# Đóng góp cho AIEV

[🇬🇧 English](CONTRIBUTING.md) · 🇻🇳 Tiếng Việt

Cảm ơn bạn đã bỏ thời gian. Đây là dự án nhỏ do Nguyễn Văn Hoàng duy trì, nên quy tắc ở đây ngắn gọn và thực dụng.

## Trước khi bắt đầu

- **Sửa nhỏ** (lỗi chính tả, tài liệu, một điều kiện sai rành rành): cứ mở Pull Request thẳng.
- **Việc lớn hơn** (tính năng mới, trang mới, đụng vào pipeline render): mở issue trước và mô tả vấn đề bạn đang gặp. Làm vậy đỡ mất công dựng một thứ rồi mới biết không hợp kiến trúc.
- Dự án có trọng tâm rõ: **làm xong một video thật, nhanh hơn hoặc đẹp hơn**. Tính năng không phục vụ điều đó thường sẽ được từ chối, kèm lời cảm ơn.

## Chạy dự án

```bash
git clone https://github.com/mr-hoang/AIEVH.git
cd AIEV
npm install
npm run dev          # web ở http://localhost:6868, backend ở 6869
```

Cần **Node.js 22+**, **FFmpeg** trên PATH và **Google Chrome**. Chạy `node start/doctor.mjs --fix` để kiểm tra và cài giúp phần cài được. Khóa Claude và Gemini chỉ cần khi thực sự chạy phần AI, không cần để build hay typecheck.

## Trước khi mở Pull Request

Hai lệnh này bắt buộc phải sạch. CI chạy đúng hai lệnh này trên mọi PR:

```bash
npm run typecheck    # server + web + remotion
npm run build        # server + web
```

Nếu bạn sửa thứ gì liên quan đến render, hãy dựng thử một bản draft thật và xem bằng mắt. Typecheck không bao giờ nói cho bạn biết cái thẻ key đang che mất chủ thể của ảnh.

## Bố cục repo

| Đường dẫn | Là gì |
|---|---|
| `apps/web/` | Dashboard Next.js (port 6868). Chỉ hiển thị và điều khiển, không bao giờ xử lý video. |
| `apps/server/` | Backend Express (port 6869): Claude Agent SDK, render queue, SQLite. Đây là nguồn sự thật về trạng thái job. |
| `engines/remotion/` | Tầng lắp ráp: scene + footage + audio + phụ đề thành video hoàn chỉnh. |
| `.claude/skills/` | Know-how sản xuất dạng markdown. Bài học nằm ở đây, không nằm trong comment code. |
| `docs/API.md` | Hợp đồng backend. Đổi shape của route thì sửa file này trong cùng PR. |
| `CLAUDE.md` | Quy tắc kiến trúc và các quy tắc vàng của pipeline. Đọc trước khi đụng vào pipeline. |

## Quy ước

- **TypeScript** cho toàn bộ `apps/`. JavaScript thuần + GSAP trong composition HyperFrames (không React trong scene, đó là chuẩn của framework).
- **Commit message tiếng Anh**, ngắn gọn.
- **Skills viết tiếng Anh**; web UI, nội dung video và tài liệu cho người dùng vẫn **tiếng Việt**.
- **Comment giải thích ràng buộc, không kể lể máy móc.** Phần lớn comment trong repo này ghi lại một con số đã ĐO được hoặc một lỗi đã gặp thật khi sản xuất. Giữ nếp đó: viết vì sao con số là như vậy, đừng viết dòng dưới làm gì.
- **Dùng dấu gạch ngang thường** trong code, chuỗi và tài liệu, không dùng em-dash.
- **Màu lấy từ CSS custom property** (`var(--primary)`), không hardcode mã hex trong component. Xem skill `webui-design`.
- **Windows là môi trường chính.** Dùng `path.join`, đừng hardcode `/` hay `\`. Mọi script phải chạy được trên PowerShell.
- **Backend giữ trạng thái job.** Web UI hiển thị đúng thứ backend báo, không tự suy diễn trạng thái.
- **Hai lớp style không được trộn**: Style Design là nhận diện thương hiệu (màu, font, logo) và luôn được cưỡng chế; phong cách dựng là ngôn ngữ thị giác của riêng một video (chất liệu và chuyển động). Đọc CLAUDE.md mục 5.6 trước khi đụng vào phần dựng prompt.

## Những thứ sẽ bị trả PR về

- Thêm dependency npm mà không giải thích lý do trong PR. Mỗi dependency là một rủi ro chuỗi cung ứng, nhất là với dự án có giữ khóa API.
- Commit thứ sinh ra hoặc thứ riêng tư: `renders/`, `outputs/`, `imports/`, `video-projects/`, `image-projects/`, `assets/voices/`, `.env`, `*.tsbuildinfo`. Chúng bị gitignore là có lý do.
- File media (sound effect, nhạc, font, logo) không rõ nguồn và giấy phép.
- Sửa pipeline theo hướng bỏ qua bước draft hoặc bỏ qua cửa QC.
- Format lại cả file kèm theo một sửa đổi nhỏ. Làm vậy thì không ai review nổi phần thay đổi thật.

## Đóng góp một skill

Skill là file markdown trong `.claude/skills/<tên>/SKILL.md`. Đây là cách AI học nghề của dự án này, nên tiêu chuẩn là: **viết thứ bạn đã kiểm chứng, không viết thứ bạn phỏng đoán**. Đọc skill `skill-authoring` trước. Một skill nói "lỗi X sửa bằng Y, đo được trên Z" đáng giá hơn mười skill toàn lời khuyên chung chung.

## Duyệt và merge

PR do người duy trì repo duyệt. Bạn sẽ nhận câu hỏi trước khi nhận merge, và nếu bị từ chối thì cũng đừng nghĩ ngợi. PR được merge theo kiểu squash thành một commit, nên bạn không cần dọn lịch sử nhánh cho đẹp.

## Giấy phép

Khi đóng góp, bạn đồng ý phần đóng góp của mình được cấp phép theo [MIT License](LICENSE) của dự án.
