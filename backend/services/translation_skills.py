"""Translation skill loader — đọc file .md từ `backend/skills/translate/`.

Mỗi file MD = 1 translate skill. Format:

    ---
    id: cultivation_zh
    label: "Cổ trang / Tiên hiệp Trung Quốc"
    description: "Truyện/phim tu tiên Trung — giữ thuật ngữ Hán Việt"
    source_languages: [zh]
    target_language: vi
    version: "1.0.0"
    author: community
    ---

    STYLE: ...

    ## Pronouns
    - ngươi/ta
    ...

Body markdown (sau frontmatter) được dùng làm `system_prompt_extra` nối
vào system prompt của LLM translator.

Loader cache trong-process; gọi `reload_skills()` nếu user vừa edit file.
Không có ngoại lệ ra ngoài — file hỏng → log warning + skip, để app không
chết vì 1 skill xấu.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger("videodub.translation_skills")

# Skills sống cạnh `backend/` chứ không phải trong `services/` — để user
# nhìn folder cấp 1 là biết "à đây là chỗ chỉnh prompt translate".
SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills" / "translate"

_CACHE: Optional[dict[str, dict]] = None


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Tách `---\\nkey: value\\n---\\nbody` thành (meta_dict, body_str).

    Stdlib-only — không pull PyYAML để giữ deps mỏng. Hỗ trợ:
      * key: value (string, bỏ quotes nếu có)
      * key: [a, b, c] (list inline, bỏ quotes từng item)
      * Bỏ qua dòng trống và comment `#`.

    Nếu file không có frontmatter → trả ({}, original_text).
    """
    if not text.startswith("---"):
        return {}, text
    # Tìm `---` đóng — phải ở đầu dòng để không nhầm với `---` trong body MD.
    lines = text.splitlines()
    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return {}, text

    meta: dict = {}
    for line in lines[1:end_idx]:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        # List shorthand: [a, b, c]
        if val.startswith("[") and val.endswith("]"):
            val = [
                item.strip().strip("\"'")
                for item in val[1:-1].split(",")
                if item.strip()
            ]
        else:
            # Strip surrounding quotes (single or double)
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
        meta[key] = val

    body = "\n".join(lines[end_idx + 1:]).strip()
    return meta, body


def _load_one(path: Path) -> Optional[dict]:
    """Đọc 1 file MD → skill dict. Trả None nếu file hỏng."""
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception as e:
        logger.warning("translation_skills: failed to read %s: %s", path, e)
        return None

    meta, body = _parse_frontmatter(raw)
    skill_id = meta.get("id") or path.stem
    label = meta.get("label") or skill_id
    description = meta.get("description") or ""
    src_langs = meta.get("source_languages") or []
    if isinstance(src_langs, str):
        src_langs = [src_langs]
    target_lang = meta.get("target_language") or "vi"
    version = meta.get("version") or "1.0.0"
    author = meta.get("author") or "local"

    if not body.strip():
        logger.warning("translation_skills: %s has no body — skipped", path)
        return None

    return {
        "id": skill_id,
        "label": label,
        "description": description,
        "source_languages": src_langs,
        "target_language": target_lang,
        "version": version,
        "author": author,
        "system_prompt_extra": body,
        "source_file": str(path.name),
    }


def load_all_skills(force: bool = False) -> dict[str, dict]:
    """Load tất cả skills từ SKILLS_DIR. Cache process-wide.

    `force=True` → bỏ cache, đọc lại từ đĩa (gọi sau khi user edit file).
    """
    global _CACHE
    if _CACHE is not None and not force:
        return _CACHE

    out: dict[str, dict] = {}
    if not SKILLS_DIR.exists():
        logger.info("translation_skills: %s không tồn tại — dùng Python fallback", SKILLS_DIR)
        _CACHE = out
        return out

    for path in sorted(SKILLS_DIR.glob("*.md")):
        # Skip README.md và file ẩn.
        if path.name.lower() == "readme.md":
            continue
        if path.name.startswith("."):
            continue
        skill = _load_one(path)
        if skill:
            out[skill["id"]] = skill

    _CACHE = out
    logger.info("translation_skills: loaded %d skills from %s", len(out), SKILLS_DIR)
    return out


def reload_skills() -> dict[str, dict]:
    """Force-reload skills từ đĩa. Dùng khi user vừa edit/copy file MD."""
    return load_all_skills(force=True)


def get_skill_prompt(skill_id: Optional[str]) -> str:
    """Trả `system_prompt_extra` cho skill_id. '' nếu không tìm thấy."""
    if not skill_id:
        return ""
    skills = load_all_skills()
    skill = skills.get(skill_id)
    if not skill:
        return ""
    return skill.get("system_prompt_extra", "")


def list_skills() -> list[dict]:
    """List skill cho API endpoint frontend dropdown.

    Loại bỏ field `system_prompt_extra` (nặng + không cần ở UI).
    """
    skills = load_all_skills()
    return [
        {
            "id": s["id"],
            "label": s["label"],
            "description": s["description"],
            "source_languages": s["source_languages"],
            "target_language": s["target_language"],
            "version": s["version"],
            "author": s["author"],
            "source_file": s["source_file"],
        }
        for s in skills.values()
    ]
