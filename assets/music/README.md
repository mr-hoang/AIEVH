# Music — thư viện nhạc nền dùng chung

> **Repo không kèm sẵn bài nhạc nào.** Nhạc có bản quyền phức tạp hơn code rất nhiều, nên bạn tự thêm nhạc của mình vào đây. Tính năng nhạc nền chỉ hoạt động sau khi thư mục này có ít nhất một bài.
> *This folder ships empty on purpose: music licensing is messy, so bring your own tracks. Background music only works once there is at least one file here.*

## Thêm nhạc

Cách dễ nhất: mở web UI, vào trang **Sound Effects** → tab **Nhạc nền** → **Tải nhạc lên**, gắn tag rồi lưu. Server tự chép file vào đây, tự đo thời lượng bằng ffprobe và tự ghi vào `library.json`.

Cách thủ công: chép file audio vào thư mục này rồi thêm một entry vào `library.json`:

```json
[
  {
    "file": "chill-lofi-loop.mp3",
    "tags": ["chill", "nen-nha"],
    "durationMs": 143000,
    "description": "Lofi nhẹ, hợp video giải thích chậm rãi"
  }
]
```

- `file` — tên file ASCII kebab-case, nằm ngay trong thư mục này.
- `tags` — **mood** của bài, đây là thứ AI dựa vào để chọn nhạc: `nang-luong`, `chill`, `cam-hung`, `cang-thang`, `vui-ve`, `trang-nghiem`…
- `durationMs` — để `null` nếu chưa đo, server sẽ đo khi upload qua UI.
- `description` — mô tả tiếng Việt, viết cho người đọc và cho AI cùng hiểu.

Entry trỏ tới file không tồn tại sẽ bị bỏ qua khi đọc thư viện, không làm hỏng gì.

## Chọn nhạc thế nào

Khi brief bật **Nhạc nền: auto**, AI đọc thư viện này, chọn bài theo mood khớp nội dung video rồi khai vào `meta.json` mục `audio.music`. Khâu lắp ráp Remotion tự hạ âm lượng nhạc xuống khi có tiếng nói (auto-ducking) và nâng lại ở quãng nghỉ. Chi tiết ở skill `background-music`.

## Bản quyền

Chỉ bỏ vào đây nhạc bạn **có quyền dùng cho video sẽ đăng công khai**: nhạc CC0 / public domain, nhạc bạn đã mua giấy phép, hoặc nhạc bạn tự làm. Nhạc rip từ YouTube hay lấy từ nguồn không rõ sẽ khiến video của bạn bị gậy bản quyền, và nếu bạn commit file đó lên một repo công khai thì rắc rối là của bạn chứ không phải của nền tảng.

Vài nguồn nhạc miễn phí dùng được cho video thương mại (tự đọc kỹ điều khoản từng bài): [Free Music Archive](https://freemusicarchive.org) (lọc CC0/CC BY), [Pixabay Music](https://pixabay.com/music/), [Incompetech](https://incompetech.com) (CC BY, phải ghi công).

Thư mục này đã được cấu hình để **không commit file audio lên git** — chỉ `library.json` và README này được theo dõi. Nhạc của bạn ở lại máy bạn.
