# Security Policy

🇬🇧 English below · 🇻🇳 Tiếng Việt ở cuối trang

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead: [**Report a vulnerability**](https://github.com/mr-hoang/AIEVH/security/advisories/new). It is private between you and the maintainer until a fix is out.

Include what you can: what an attacker can do, how to reproduce it, and the commit you tested. A proof of concept helps a lot. This is a small project maintained by one person, so expect a first reply within a few days rather than within hours.

## What is in scope

The project runs on your own machine and holds credentials for Claude and Gemini, so the interesting attacks are the ones that reach those credentials or the filesystem. Reports along these lines are very welcome:

- A request that escapes the project directories and reads or writes elsewhere on disk (path traversal in the media, asset, staging or QC paths).
- A way to use the API without the token from a non-loopback origin, or to make the server hand the token to a remote caller.
- HTML, SVG or script content served from `/media` that executes in the dashboard's origin.
- A dependency or install step that exfiltrates `.env`, the SQLite database, or cloned voice recordings.
- Prompt injection through a video transcript, an article URL or an uploaded file that escalates into commands outside the allowlist in `.claude/settings.json`.
- Credentials, tokens or personal paths leaking into logs, API responses, rendered output or committed files.

## Known design decisions, not vulnerabilities

These are deliberate and documented, so please do not report them as findings:

- **The dashboard trusts loopback.** Any process running as your user on the same machine can read the API token from `/api/health` and drive the system. AIEV is built for a single-user workstation, not for shared or multi-tenant hosting.
- **Exposing the dashboard to the internet is the operator's responsibility.** The Cloudflare Tunnel option exists for phone uploads; the README says plainly to put Cloudflare Access in front of it or not share the link. An open tunnel is a configuration choice, not a bug in the code.
- **The AI agent runs with real tool permissions on your machine**, bounded by `.claude/settings.json`. That is the product, not a flaw. What *is* a flaw is any path that escapes those bounds.
- **API keys sit in `.env` in plaintext**, like most local developer tooling.

## Supported versions

Only the current `main` branch is supported. There are no long-lived release branches yet.

---

# Chính sách bảo mật

## Báo lỗ hổng

**Xin đừng mở issue công khai cho vấn đề bảo mật.**

Hãy dùng kênh riêng của GitHub: [**Report a vulnerability**](https://github.com/mr-hoang/AIEVH/security/advisories/new). Nội dung chỉ có bạn và người duy trì repo thấy cho tới khi có bản vá.

Ghi được gì thì ghi: kẻ tấn công làm được gì, cách tái hiện, và commit bạn đã thử. Có mã minh họa thì càng tốt. Dự án do một người duy trì, nên bạn hãy chờ phản hồi trong vài ngày chứ không phải vài giờ.

## Thuộc phạm vi

Hệ thống chạy trên máy của chính bạn và giữ khóa Claude, Gemini, nên thứ đáng lo là những đường tấn công chạm tới khóa hoặc tới ổ đĩa. Rất hoan nghênh các báo cáo kiểu:

- Một request thoát khỏi thư mục project để đọc hoặc ghi chỗ khác trên ổ đĩa (path traversal ở các đường media, asset, staging, QC).
- Cách gọi API mà không cần token từ một nguồn không phải loopback, hoặc khiến server trao token cho máy ở xa.
- Nội dung HTML, SVG hay script phục vụ qua `/media` mà chạy được trong origin của dashboard.
- Một dependency hoặc bước cài đặt lén gửi `.env`, file SQLite, hay bản ghi giọng nhân bản ra ngoài.
- Prompt injection qua lời thoại video, URL bài viết hay file upload, leo thang thành lệnh nằm ngoài allowlist trong `.claude/settings.json`.
- Khóa, token hay đường dẫn cá nhân lọt vào log, phản hồi API, sản phẩm render hoặc file được commit.

## Là chủ ý thiết kế, không phải lỗ hổng

Những điều sau là cố ý và đã ghi rõ trong tài liệu, xin đừng báo như một phát hiện:

- **Dashboard tin tưởng loopback.** Mọi tiến trình chạy dưới tài khoản của bạn trên cùng máy đều đọc được API token từ `/api/health` và điều khiển được hệ thống. AIEV làm cho máy cá nhân một người dùng, không phải để host chung nhiều người.
- **Mở dashboard ra internet là trách nhiệm của người vận hành.** Tùy chọn Cloudflare Tunnel sinh ra để upload từ điện thoại; README đã nói thẳng là phải bọc Cloudflare Access hoặc tuyệt đối không chia sẻ link. Để tunnel mở toang là lựa chọn cấu hình, không phải lỗi của code.
- **Agent AI chạy với quyền công cụ thật trên máy bạn**, trong giới hạn của `.claude/settings.json`. Đó là bản chất sản phẩm. Cái *đáng* báo là bất kỳ đường nào thoát khỏi giới hạn đó.
- **Khóa API nằm trong `.env` dạng văn bản thường**, như phần lớn công cụ chạy máy cá nhân.

## Phiên bản được hỗ trợ

Chỉ hỗ trợ nhánh `main` hiện tại. Chưa có nhánh phát hành dài hạn.
