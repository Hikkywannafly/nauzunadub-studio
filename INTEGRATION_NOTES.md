# Integration Notes

## ✅ Đã ghép xong (commit cuối)

- `pages/DubTab.jsx` — thêm nút **Voices** vào header (xuất hiện khi có segments), mở modal **VoiceSettings** overlay. `onContinue` tự gọi `handleDubGenerate` nếu đang ở step `editing`.
- `pages/Settings.jsx` — thêm tab **LLM Provider** dùng `<LLMProviderSettings>` (TABS array, tab 'llm' sau 'engines'). Tab 'capture' (dictation) đã bị xoá khỏi TABS — block content vẫn còn nhưng không render được nữa.

Code path tham khảo:
- DubTab.jsx:23  → import VoiceSettings
- DubTab.jsx:60  → `const [showVoiceSettings, setShowVoiceSettings] = useState(false)`
- DubTab.jsx:528 → nút Voices trong `dub-head__actions`
- DubTab.jsx:1048 → render modal overlay
- Settings.jsx:16 → import LLMProviderSettings
- Settings.jsx:30 → entry `{ id: 'llm', ... }` trong TABS
- Settings.jsx:1131 → `{activeTab === 'llm' && ...}` content panel

## 3. Sidebar / Launchpad — bỏ các tab không dùng

Trong sidebar/launchpad (xem `frontend/src/pages/Launchpad.jsx` hoặc `App.jsx`), xoá các route:
- `BatchQueue`
- `CloneDesignTab` (giữ nếu vẫn muốn voice design)
- `DonatePage`, `EnterprisePage`
- `Projects`
- `SetupWizard` (giữ nếu cần onboarding HF token)
- `Transcriptions` (tuỳ chọn)
- `ToolsPage`

Giữ lại: **DubTab** (luồng chính), **VoiceGallery**, **VoiceProfile**, **VoiceSettings** (mới), **Settings**.

## 4. Branding strings

Tìm và đổi `OmniVoice Studio` → `VideoDub Studio` ở:
- `frontend/index.html` (title)
- `frontend/src/i18n/locales/*.json` (UI strings)
- `frontend/src-tauri/tauri.conf.json` (product name, identifier)
- `frontend/src-tauri/Cargo.toml`

## 5. Tauri src cleanup (chưa dọn)

`src-tauri/src/lib.rs` + `commands.rs` + `config.rs` còn code cho dictation/global shortcut/floating widget. Để build pass, deps `tauri-plugin-global-shortcut` + `enigo` vẫn giữ trong Cargo.toml. Để dọn:

1. Xoá `register_global_shortcut`, `setup_widget_window`, `auto_paste_with_enigo` trong `lib.rs`.
2. Xoá `widget` window đã được tháo khỏi `tauri.conf.json`.
3. Bỏ 2 deps trên ra khỏi Cargo.toml sau khi src đã sạch.

## 6. Khi nào ghép tự động?

Phần ghép này cần đọc context lớn của App.jsx (>1500 dòng). Nếu bạn muốn, gọi:

```
/sc:implement Ghép VoiceSettings page vào DubTab flow (giữa translate và generate) và thêm tab LLM Provider vào Settings page hiện có.
```

hoặc làm thủ công theo các snippet ở trên.
