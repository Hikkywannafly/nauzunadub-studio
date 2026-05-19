---
id: english_movie
label: "Phim Hollywood / Phim lẻ EN"
description: "Phim chiếu rạp EN → VI — đối thoại tự nhiên, lip-sync friendly"
source_languages: [en]
target_language: vi
version: "1.0.0"
author: built-in
---

STYLE: Hollywood / English-language feature film dubbing. Output Vietnamese
phải nghe như phim chiếu rạp lồng tiếng — KHÔNG ai nói "Tôi sẽ đi đến đó"
trong phim cả. Câu phải ngắn gọn, tự nhiên, dễ khớp môi.

## Pronouns
- **anh / em** — couples, romantic interest, sibling cảnh tình cảm
- **tôi / bạn** — formal cảnh business, lawyer, government
- **mày / tao** — bạn rất thân, đám gangster, lính chiến đấu cùng nhau
- **ông / bà** — older characters, parents to adults
- **con / bố / mẹ** — gia đình, parents to kids
- **cậu / mình** — trẻ, college student, friends 20-30 tuổi
- Match theo TÌNH HUỐNG và RELATIONSHIP, không có default

## Câu thoại — RULES quan trọng
- **Ngắn** — câu thoại lồng tiếng cần khớp môi. "I'm going to the store" → "Tôi đi cửa hàng" (5 từ) không phải "Tôi sẽ đi đến cửa hàng đó" (8 từ).
- **Tự nhiên** — câu thoại nghe như người Việt thật nói, không như sách dịch.
- **Cảm xúc** — exclamation phải tới: "Damn it!" → "Chết tiệt!" / "Mẹ kiếp!" / "Khốn nạn!" tùy nhân vật.
- **Văng tục** — match cường độ:
  - Mild ("damn", "shit") → "chết tiệt", "trời ơi"
  - Heavy ("fuck", "motherfucker") → "đm", "đ*o", "chó chết", "khốn nạn" (tùy nhân vật / rating)
  - Slur → cẩn thận, tùy context (đôi khi giữ nguyên tone, đôi khi soften)

## Idiomatic translations (đừng dịch literal)
- "Are you kidding me?" → "Bạn đang đùa tôi à?" / "Đùa à?" / "Thật sao?"
- "What the hell?" → "Cái quái gì vậy?" / "Cái gì đây?"
- "Hold on" → "Khoan đã" / "Đợi đã"
- "No way" → "Không đời nào" / "Đâu có"
- "You got it" → "Hiểu rồi" / "Được"
- "I got your back" → "Có tôi đây" / "Yên tâm có tôi"
- "Long story short" → "Tóm lại là..." / "Nói ngắn gọn..."
- "Take it easy" → "Bình tĩnh đã" / "Từ từ nào"
- "Are you out of your mind?" → "Mày điên à?" / "Mất trí rồi à?"
- "Suit yourself" → "Tùy bạn" / "Tùy cậu"

## Tone
- Match genre:
  - Action → fast, punchy, mệnh lệnh
  - Drama → emotional, weighted
  - Comedy → punchline must land — đôi khi cần adapt joke không dịch literal
  - Thriller → tense, ngắn câu
  - Romance → warm, intimate
- Subtext rất quan trọng — phim hay nói A nghĩa B, dịch không được giết subtext

## Avoid
- Câu dài lê thê
- "Ồ" / "À ha" — không tự nhiên trong tiếng Việt
- Dịch tên riêng (giữ nguyên: "John", "Sarah", "New York")
- Quá lịch sự — Hollywood không mấy khi lịch sự
- Mất cảm xúc — phim mất cảm xúc là phim hỏng
