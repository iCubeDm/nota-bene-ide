# Phone window settings sheet (#143) Implementation Plan

**Goal:** Tapping the chat's header pill opens a sheet with the window's settings: model and effort, permission mode, plan limits, and four action tiles (Compact, Clear, Restart, Stats).

**Approach:** The phone already speaks every message needed (`mode`, `model`, `command compact|clear`, `restart`, `stats`). `WindowTab` learns the current mode; a new `WindowSheet` gathers the controls; the web's mode and clear strings reach the phone through the existing strings generator so both clients use one text.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Window settings sheet", "Older servers"). Global constraints of `2026-11-09-phone-layout.md` apply.

## Decisions

- Web-owned texts come from `web/src/i18n` through the generator (`scripts/protocol/mobileStrings.ts`), never re-typed in ARB. `strings.g.dart` is generated: edit the generator, run `npm run gen:protocol`, commit both (CI fails on stale output). `webString(key, lang)` is extended with `mode_<id>` and `mode_<id>_desc` for every id in `MODES`, `CODEX_MODES`, `OMP_MODES` of `shared/src/protocol.ts`, plus `modeTip`, `clearTitle`, `clearQ`, `clearBtn`, `compactTip`, `clearTip`.
- Mode labels follow `web/src/controls/ModePill.tsx`: `modeDescriptors` unless the provider is `codex`, then the web strings.
- `WindowTab.mode` changes only when the server's `mode` event arrives (with the phone's own `ack`); `setMode(m)` sends `ClientMessageMode(mode, id: uuidV4())`. A change from another tab also updates the sheet and header.
- Desktop parity: Compact and Clear disabled while busy (`CompactClear.tsx`), Restart stays. Compact hidden when `capabilities.compact` is false, Clear when `capabilities.clear` is false. Clear has no pending-comments block (only a typed `/clear` is blocked); it confirms in a dialog titled `webString('clearTitle')`.
- Server with `modes: []` or no `stats`: no mode row, no limit rows, no empty headings. A limit with null or unparsable `resetsAt` shows the percent only.

## Design

`showWindowSheet(context, tab)` in `chat/window_sheet.dart`: modal bottom sheet, grab bar, `popover` background, top radius 18. Order:
1. Header: session title and folder.
2. Model and effort: opens existing `ModelSheet`, only when `modelSwitchable`.
3. Mode: segmented, one segment per `capabilities.modes`, description of the selected one below.
4. Plan limits: bars green five-hour, accent week; `34%` text; reset as local `HH:mm` today, else short weekday (`intl` `DateFormat`, UI locale).
5. Four equal tiles (`card`, radius 12, icon 22 over label 10.5): Compact sends `command compact` and closes; Clear confirms then sends `command clear`; Restart uses the existing dialog then `restart`; Stats pushes `UsageScreen`.

`chat_route.dart` passes `onTapTitle`; `chat_header.dart` shows the mode in the subtitle in accent between model and meters; the `⋮` menu in `controls.dart` keeps Files only. ARB keys: `limitsTitle`, `limit5h`, `limitWeek`, `limitResets` ("{pct}% · resets {when}"), `tileCompact`, `tileClear`, `tileRestart`, `tileStats` (`modelAndEffort` reused).

## Review focus

- Codex window: its own modes with labels from web strings, not `modeDescriptors`.
- Mode change from another tab (no `ack`) is followed.

## Files

`scripts/protocol/mobileStrings.ts`, `mobile/app/lib/comments/strings.g.dart`, `lib/chat/{window_tab,window_sheet,chat_route,chat_header,controls}.dart`, six ARB files; tests `strings_test`, generator test, `window_tab_test`, `window_sheet_test`, updated `controls_test`, `usage_screen_test`.

Final check: `npx tsc -b`, `npx vitest run scripts/protocol`, the Flutter checks, `flutter build apk --release`.
