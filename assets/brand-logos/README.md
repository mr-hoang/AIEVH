# Brand logos — thư viện logo thương hiệu

Logo của các thương hiệu khác (Meta, TikTok, OpenAI…) để chèn vào video khi kịch bản nhắc tới họ. Thư viện tự lớn dần: kịch bản cần brand nào mà chưa có thì server tự tải về.

## Nhãn hiệu thuộc về chủ sở hữu của chúng

Các file SVG ở đây là **nhãn hiệu (trademark) của chủ thương hiệu tương ứng**, không phải tài sản của dự án này và **không nằm trong giấy phép MIT của repo**. Giấy phép MIT chỉ áp cho code.

Bản thân file được lấy từ nguồn cho phép phân phối lại ([Simple Icons](https://simpleicons.org) — CC0, và [Wikidata](https://www.wikidata.org) thuộc tính P154), nhưng *quyền với nhãn hiệu* thì vẫn của chủ thương hiệu. Trong thực tế dùng: chèn logo để **nhắc tới** một thương hiệu (đưa tin, so sánh, bình luận) là chuyện bình thường; dùng logo theo cách khiến người xem tưởng thương hiệu đó tài trợ hay xác nhận nội dung của bạn thì không. Nhiều thương hiệu có brand guideline riêng về khoảng cách, màu, biến thể — cần chuẩn chỉnh thì đọc guideline của họ.

*The SVG files here are trademarks of their respective owners, not covered by this repository's MIT license. They are redistributed from CC0 sources (Simple Icons, Wikidata P154), but trademark rights remain with the owners. Use them to refer to a brand, not to imply endorsement.*

## Cấu trúc

Mỗi file có một entry trong `library.json`:

```json
{
  "slug": "openai",
  "title": "OpenAI",
  "color": "#412991",
  "file": "openai.svg",
  "source": "https://openai.com/brand",
  "license": "CC0-1.0"
}
```

`source` là **URL trang chính chủ của thương hiệu** (press kit, brand guideline, hoặc trang Wikimedia Commons của logo đó) — giữ field này khi thêm logo mới, đó là dấu vết truy nguyên file đến từ đâu. `license` là field tùy chọn, phần lớn entry hiện chưa có: file lấy từ Simple Icons nên bản thân file là CC0, còn nhãn hiệu thì luôn thuộc chủ thương hiệu bất kể field này ghi gì.

## Thêm logo

```bash
# Server tự tìm ở Simple Icons rồi Wikidata, tải về đây và trả relPath
curl -X POST http://localhost:6869/api/brand-logos -H "content-type: application/json" -d "{\"name\":\"OpenAI\"}"

# Bổ sung hàng loạt theo slug
node scripts/fetch-brand-logos.mjs openai anthropic figma
```

Hoặc bỏ thẳng file SVG vào thư mục rồi thêm entry vào `library.json`.

Không tìm thấy thì API trả `404 BRAND_LOGO_NOT_FOUND` — khi đó viết tên thương hiệu bằng chữ, **tuyệt đối không tự vẽ hay tự chế logo** (xem CLAUDE.md mục 5.5).

## Dùng trong video

Chép file cần dùng vào `assets/` của project rồi mới tham chiếu — Remotion chỉ stage file nằm trong project. Logo thương hiệu của chính bạn thì không nằm ở đây mà nằm trong Style Design (`assets/styles/`), và được đóng tự động ở góc trên trái mọi video.
