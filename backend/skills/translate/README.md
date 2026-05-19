# Translate Skills

Mỗi file `.md` ở thư mục này = 1 translate style. Khi user chọn ở dropdown
**Genre** trong UI, backend load file tương ứng và nối phần body markdown
vào system prompt của LLM translator.

## Cấu trúc file

```markdown
---
id: my_skill
label: "Tên hiển thị ở dropdown"
description: "Mô tả ngắn 1 dòng cho tooltip"
source_languages: [zh, en]    # ngôn ngữ nguồn skill này phù hợp
target_language: vi            # ngôn ngữ đích (mặc định: vi)
version: "1.0.0"
author: community
---

STYLE: <hướng dẫn cho LLM về văn phong>

## Pronouns
- <đại từ nên dùng>

## Glossary
- <từ nguồn> → <bản dịch chuẩn>

## Tone
- <ghi chú tone>
```

Toàn bộ phần sau `---` (frontmatter) đi vào prompt. Cứ viết tự nhiên,
LLM đọc được markdown headers.

## Thêm skill mới

1. Tạo file `<tên>.md` mới trong thư mục này.
2. Frontmatter bắt buộc có ít nhất `id`, `label`.
3. Restart backend HOẶC gọi API `/api/skills/translate/reload` để load.

## Sửa skill có sẵn

Edit file MD trực tiếp. Backend cache nên cần reload (xem trên).

## Skills hiện có

| ID | Source langs | Mục đích |
|----|--------------|----------|
| `postcast` | any | Podcast / vlog / talk show |
| `documentary` | any | Phim tài liệu, khoa học |
| `gaming` | any | Stream game, esports |
| `tutorial_tech` | en | Tutorial coding / tech review |
| `anime` | ja | Anime / manga / light novel |
| `cultivation_zh` | zh | Tiên hiệp, tu chân |
| `wuxia` | zh | Kiếm hiệp (Kim Dung style) |
| `court_drama_zh` | zh | Cung đấu, hậu cung |
| `cdrama_business` | zh | Phim đô thị hiện đại TQ (công sở) |
| `romance_modern` | zh | Ngôn tình hiện đại |
| `english_movie` | en | Phim Hollywood, lồng tiếng phim |
| `english_news` | en | Bản tin TV |
| `english_lecture` | en | TED talk, giảng dạy |
| `english_standup` | en | Hài đứng, comedy |
