# Sound Effects — thư viện dùng chung

> ## ⚠️ Đọc trước khi dùng
>
> Thư viện này là **đồ sưu tầm nhiều năm từ nhiều nguồn khác nhau, không ghi lại giấy phép của từng file**. Nó đi kèm repo để bạn dùng được ngay, nhưng **không khuyến khích dùng cho video thương mại** — không ai chứng minh được quyền với những file này, kể cả người đưa chúng vào đây.
>
> Làm video thương mại thì thay bằng thư viện của riêng bạn: nguồn CC0 hoặc đã mua giấy phép, và ghi `source` + `license` cho từng file (xem dưới). Dùng thư viện này rồi bị gậy bản quyền thì đó là rủi ro bạn tự nhận.
>
> *These sound effects were collected over years from assorted sources with no licensing records. They ship so the feature works out of the box, but they are **not recommended for commercial video** — nobody can prove rights to them. For commercial work, replace them with CC0 or properly licensed audio of your own.*

Một số file **không** đi kèm repo dù có trong danh mục: những trích đoạn nhận ra ngay là của ai (jingle Netflix, nhạc Nintendo, SpongeBob, X-Files, Windows XP…). Với chúng thì vấn đề không phải "không rõ nguồn" mà là "biết rõ của ai", và một lời khuyến cáo không đổi được điều đó. Danh sách nằm trong `.gitignore`. Entry trong `library.json` trỏ tới file không tồn tại sẽ bị bỏ qua, không làm hỏng gì.

## Thêm sound effect

Cách dễ nhất: mở web UI, vào trang **Sound Effects** → **Tải lên**, gắn tag rồi lưu. Server tự chép file vào đây, tự đo thời lượng bằng ffprobe và tự ghi vào `library.json`.

Cách thủ công: chép file audio vào thư mục này rồi thêm một entry vào `library.json` (xem `docs/API.md` mục Sound Effects):

```json
[
  {
    "file": "whoosh-nhanh.mp3",
    "tags": ["whoosh", "transition", "hay-dung"],
    "durationMs": 480,
    "description": "Whoosh ngắn, dùng cho chuyển cảnh nhanh",
    "source": "https://pixabay.com/sound-effects/whoosh-6316/",
    "license": "CC0-1.0"
  }
]
```

- `file` — tên file ASCII kebab-case, nằm ngay trong thư mục này.
- `tags` — AI dựa vào đây để chọn tiếng. Tag `hay-dung` đánh dấu bộ tiếng dùng thường xuyên.
- `durationMs` — để `null` nếu chưa đo, server đo bằng ffprobe khi upload qua UI.
- `description` — mô tả tiếng Việt, viết cho người đọc và cho AI cùng hiểu.
- `source` — **URL nơi bạn lấy file**. Ghi ngay lúc thêm, đừng để sau: sáu tháng nữa không ai nhớ nổi file này lấy ở đâu, và đó chính là lý do cả thư viện dựng sẵn ở trên phải kèm khuyến cáo.
- `license` — mã giấy phép (`CC0-1.0`, `CC-BY-4.0`, `Pixabay`, `mua-license`, `tu-thu-am`…).

Khi dùng cho một video thì copy file vào `video-projects/<ten>/assets/sound-effects/` rồi khai trong `meta.json` — project phải tự chứa đủ asset của nó.

## Nguồn sạch để thay dần

| Nguồn | Giấy phép | Ghi chú |
|---|---|---|
| [Pixabay Sound Effects](https://pixabay.com/sound-effects/) | Pixabay Content License | Không cần ghi công, dùng thương mại được |
| [Freesound](https://freesound.org) (lọc CC0) | CC0 hoặc CC BY | **Phải lọc** — Freesound có cả file yêu cầu ghi công |
| [Mixkit](https://mixkit.co/free-sound-effects/) | Mixkit Free License | Không cần ghi công |
| [BBC Sound Effects](https://sound-effects.bbcrewind.co.uk) | RemArc, phi thương mại | Chỉ dùng được nếu video của bạn phi thương mại |

Hai thứ đừng bỏ vào đây: **trích đoạn từ phim, game, chương trình** (ngắn và quen thuộc đến mấy thì vẫn thuộc về ai đó, và một số còn là nhãn hiệu âm thanh đã đăng ký), và **file tải từ YouTube**.
