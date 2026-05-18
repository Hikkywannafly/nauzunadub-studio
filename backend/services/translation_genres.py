"""Translation genre presets — system-prompt extensions theo thể loại nội dung.

Mỗi genre cung cấp 1 `system_prompt_extra` được nối vào sau prompt base của
LLM translator. Mục tiêu: ép LLM dịch sang tiếng Việt với văn phong, đại từ,
slang phù hợp với thể loại — thay vì 1 cỡ áo cho tất cả.

Dùng:
    from services.translation_genres import GENRES, get_genre_prompt
    extra = get_genre_prompt("cultivation_zh")
    full_system = base_prompt + " " + extra
"""
from __future__ import annotations

from typing import Optional


# Key naming convention: <thể_loại>[_ngôn_ngữ_nguồn]. Frontend pass `genre` key
# y nguyên xuống backend; mismatch → silent fallback về base prompt.
GENRES: dict[str, dict] = {
    "postcast": {
        "label": "Postcast / Vlog / Talk show",
        "description": "Đối thoại tự nhiên, người dẫn chương trình nói với khán giả",
        "system_prompt_extra": (
            "STYLE: Conversational podcast/vlog. Output Vietnamese MUST sound "
            "like a Vietnamese host talking naturally to listeners. Use 'mình' "
            "to refer to the speaker themselves and 'các bạn' when addressing "
            "the audience. Keep natural filler markers if present in source "
            "(e.g. 'you know', 'I mean' → 'kiểu', 'ý là'). Avoid stiff "
            "literary tone. Don't add formality the source doesn't have."
        ),
    },
    "cultivation_zh": {
        "label": "Cổ trang / Tiên hiệp Trung Quốc",
        "description": "Truyện/phim tu tiên, cổ đại Trung — giữ thuật ngữ Hán Việt",
        "system_prompt_extra": (
            "STYLE: Chinese cultivation/xianxia (修真/仙侠) or historical drama. "
            "Use classical Vietnamese pronouns: 'ngươi/ta', 'huynh/đệ/muội', "
            "'tỷ tỷ', 'tiểu thư', 'công tử', 'lão phu'. PRESERVE cultivation "
            "terminology in Hán Việt form when it exists: 渡劫=độ kiếp, 元神=nguyên "
            "thần, 修真=tu chân, 金丹=kim đan, 道友=đạo hữu, 灵气=linh khí, 仙人=tiên "
            "nhân. Avoid modern slang. Use formal classical sentence structures. "
            "When characters use respectful titles, preserve the hierarchy "
            "feeling in Vietnamese."
        ),
    },
    "romance_modern": {
        "label": "Ngôn tình hiện đại",
        "description": "Phim/truyện ngôn tình đô thị hiện đại Trung Quốc",
        "system_prompt_extra": (
            "STYLE: Modern Chinese romance drama / urban contemporary. Use "
            "warm modern pronouns appropriate to the relationship: 'anh/em' "
            "for couples and senior-junior dynamics, 'cậu/tớ' for close peers, "
            "'mình/cậu' for unmarried lovers, 'chị/em' between female friends. "
            "Preserve endearments naturally: 老公=ông xã/chồng, 老婆=bà xã/vợ, "
            "宝贝=bảo bối/cưng, 亲爱的=anh yêu/em yêu. Tone: warm, idiomatic, "
            "not stiff. Avoid overly formal literary words; this is everyday "
            "speech of young urban Chinese characters."
        ),
    },
    "anime": {
        "label": "Anime / Manga / Light Novel",
        "description": "Nhật → Việt. Giữ nakama/honorifics tùy ngữ cảnh",
        "system_prompt_extra": (
            "STYLE: Japanese anime/manga. Use youthful Vietnamese pronouns "
            "'tớ/cậu' or 'mình/cậu' for peers, 'em/anh' for senior-junior. "
            "PRESERVE Japanese honorifics in dialogue when they carry meaning: "
            "-san, -chan, -kun, -sama, -senpai (write as 'san', 'chan', etc., "
            "after the name). Preserve culturally-loaded terms: nakama (đồng "
            "đội), senpai (tiền bối), kohai (hậu bối), oni-chan (anh trai). "
            "Match the emotional intensity of the source — Japanese dialogue "
            "is often emotive (!, ?!, 〜), let Vietnamese reflect that. "
            "Onomatopoeia (キラキラ, ドキドキ) can be localized or kept as-is "
            "depending on flow."
        ),
    },
    "documentary": {
        "label": "Documentary / Tài liệu",
        "description": "Phim tài liệu, khoa học, lịch sử — văn phong trung lập",
        "system_prompt_extra": (
            "STYLE: Documentary / educational. Neutral, factual, precise. "
            "Use formal Vietnamese narration voice: 'chúng ta thấy rằng...', "
            "'nghiên cứu cho biết...', 'các nhà khoa học đã...'. Preserve "
            "technical/scientific terminology accurately — when a Vietnamese "
            "translation is established (DNA → ADN, photosynthesis → quang "
            "hợp), use it; when no good Vietnamese term exists, keep the "
            "English term in parentheses on first use. NO slang, NO "
            "emotional embellishment, NO personal pronouns toward audience."
        ),
    },
    "gaming": {
        "label": "Gaming / Stream / Esports",
        "description": "Game streaming, esports — giữ jargon EN, slang VN game thủ",
        "system_prompt_extra": (
            "STYLE: Gaming stream / esports commentary. KEEP English gaming "
            "jargon verbatim: build, item, boss, raid, GG, AFK, nerf, buff, "
            "meta, tank, DPS, support, jungle, lane, ult, combo, farm, "
            "feed, clutch, ace. Use Vietnamese gamer slang naturally: 'chuối' "
            "(noob), 'gánh team', 'cân team', 'cày', 'sấp mặt', 'ngon', "
            "'cọp', 'trẻ trâu'. Tone: hype, casual, fast. Use 'mình/các bạn' "
            "or 'tao/mày' depending on stream tone (casual stream = tao/mày "
            "OK between friends). Match the energy of the source."
        ),
    },
    "tutorial_tech": {
        "label": "Tutorial / Tech / Coding",
        "description": "Hướng dẫn lập trình, tech review — giữ tech term EN",
        "system_prompt_extra": (
            "STYLE: Technical tutorial / coding screencast. KEEP English "
            "technical terms verbatim: API, function, variable, deploy, "
            "commit, branch, merge, framework, library, dependency, debug, "
            "compile, runtime, async, callback, hook, component, props, "
            "state, server, client, frontend, backend, database, query, "
            "endpoint, package, install, build, render. Translate ONLY the "
            "explanatory text around these terms. Use 'mình/các bạn' "
            "addressing. Tone: clear, patient, walking-through-the-code "
            "feel. Avoid translating proper noun product/library names "
            "(React, Next.js, Tailwind, FastAPI, etc.)."
        ),
    },
}


def get_genre_prompt(genre: Optional[str]) -> str:
    """Trả system_prompt_extra cho genre. Empty string nếu genre không hợp lệ
    hoặc None (caller sẽ fallback về base prompt)."""
    if not genre:
        return ""
    entry = GENRES.get(genre)
    if not entry:
        return ""
    return entry.get("system_prompt_extra", "")


def list_genres() -> list[dict]:
    """List các genre cho API endpoint /api/genres. Dùng cho frontend dropdown."""
    return [
        {"id": gid, "label": g["label"], "description": g["description"]}
        for gid, g in GENRES.items()
    ]
