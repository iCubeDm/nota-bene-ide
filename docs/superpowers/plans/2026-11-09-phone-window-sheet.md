# Phone window settings sheet (#143) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tapping the chat's header pill opens a sheet with the window's settings: model and effort, permission mode, plan limits, and four action tiles (Compact, Clear, Restart, Stats).

**Architecture:** The phone already speaks every message needed (`mode`, `model`, `command compact|clear`, `restart`, `stats`). `WindowTab` learns the current mode; a new `WindowSheet` widget gathers the controls; the web's mode and clear strings reach the phone through the existing strings generator, so the two clients use one text.

**Tech Stack:** Flutter 3.47.9, Dart; TypeScript generator `scripts/protocol/mobileStrings.ts` run by `npm run gen:protocol`; Vitest for the generator, flutter_test for the app.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Window settings sheet", "Older servers").

## Global Constraints

- The Global Constraints of `docs/superpowers/plans/2026-11-09-phone-layout.md` apply (six languages, web glyphs via `NbIcon`, `NbColors` only, no new packages, the three Flutter checks, commit format with `gh-143:`).
- Web-owned texts come from `web/src/i18n` through the generator, never re-typed in ARB files.
- `strings.g.dart` is generated: edit the generator, run `npm run gen:protocol`, commit both. CI fails on a stale output.
- Work in `/Users/icubedm/Documents/Projects/ai-ide-phone` on branch `gh-143-window-sheet`, cut from `gh-142-layout`.

## Review Focus

- A Codex window: its own modes, labels from the web strings (not `modeDescriptors`), as `web/src/controls/ModePill.tsx` decides.
- A server with `modes: []` or no `stats`: no mode row, no limit rows, no empty headings.
- A mode change from another tab (no `ack`): the sheet and header follow it; the phone's own change shows once the `mode` event with its `ack` arrives.
- Busy agent: Compact and Clear disabled, as the desktop (`CompactClear.tsx`); Restart stays available.
- A limit with `resetsAt` null or unparsable: the row shows the percent without a reset time.

---

### Task 1: The web's mode and clear strings on the phone

**Files:**
- Modify: `scripts/protocol/mobileStrings.ts`
- Regenerate: `mobile/app/lib/comments/strings.g.dart`
- Test: the generator's existing test file next to it (find it with `ls scripts/protocol`), and `mobile/app/test/strings_test.dart`

**Interfaces:**
- Extends the existing Dart `webString(String key, String lang)` to also cover: `mode_<id>` and `mode_<id>_desc` for every id in `MODES`, `CODEX_MODES` and `OMP_MODES` of `shared/src/protocol.ts`, plus `modeTip`, `clearTitle`, `clearQ`, `clearBtn`, `compactTip`, `clearTip`.

- [ ] **Step 1: Failing tests.** Generator test: the output contains `webString` and, for `ru`, the text of `mode_plan` from `web/src/i18n/ru.ts`. Dart test: `webString('clearBtn', 'de')` equals the German `clearBtn`; `webString('mode_auto', 'xx')` equals the English one.
- [ ] **Step 2: Run, expect FAIL** (`npx vitest run scripts/protocol` and `flutter test test/strings_test.dart`).
- [ ] **Step 3: Implement:** `WEB_KEYS` and `webString` already exist (#142, holding `h5`, `week`); extend the list with the mode keys built from the three mode arrays and the six fixed keys; a function-typed key is an error. Run `npm run gen:protocol`.
- [ ] **Step 4: Run, expect PASS.** Also `npx tsc -b` exit 0.
- [ ] **Step 5: Commit** `gh-143: the web's mode and clear strings for the phone`.

### Task 2: The tab knows the mode

**Files:**
- Modify: `mobile/app/lib/chat/window_tab.dart`
- Test: `mobile/app/test/window_tab_test.dart`

**Interfaces:**
- Produces: `AgentMode? mode;` on `WindowTab`, set by every `ServerEventMode` (and by whatever the server sends on connect — read `server/src` to see whether the mode comes in `replay`, `hello` or a separate `mode` event, and handle that); `bool setMode(AgentMode m)` sends `ClientMessageMode(mode: m, id: uuidV4())` and returns `send`'s result; the shown mode changes only when the event arrives.
- `String modeLabel(WindowTab tab, AgentMode m, String lang)` and `String modeDescription(...)`: `modeDescriptors` unless the provider is `codex`, else `webString('mode_<id>')` / `'mode_<id>_desc'` — the rule of `ModePill.tsx`.

- [ ] **Step 1: Failing tests:** a `mode` event sets `tab.mode` and notifies; `setMode` sends `{type: mode, mode, id}`; `tab.mode` is unchanged until the event; labels: a claude hello with `modeDescriptors` uses the descriptor name, a codex hello with descriptors uses the web string.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `gh-143: the phone tracks and sets the permission mode`.

### Task 3: The window sheet

**Files:**
- Create: `mobile/app/lib/chat/window_sheet.dart`
- Modify: `mobile/app/lib/chat/chat_route.dart` (pass `onTapTitle` to `ChatScreen`), `mobile/app/lib/chat/chat_header.dart` (the mode in the subtitle, accent colour, between model and the meters), `mobile/app/lib/chat/controls.dart` (the `⋮` menu keeps Files only; `ModelSheet` and `_restart`'s dialog are reused by the sheet), the six ARB files
- Test: `mobile/app/test/window_sheet_test.dart`; update `test/controls_test.dart`, `test/usage_screen_test.dart` and others that open the old menu items

**Interfaces:**
- Consumes: `tab.mode`, `setMode`, `modeLabel`, `modeDescription` (Task 2); `webString` (Task 1); `NbIcon`, `NbGlyph.compact/clear/restart/usage` (#142); `ChatScreen.onTapTitle` (#142); `ModelSheet`, `modelSwitchable` (controls.dart); `UsageScreen`.
- Produces: `Future<void> showWindowSheet(BuildContext context, WindowTab tab)`.
- New ARB keys (all six): `windowSheetModel` ("Model and effort" — reuse `modelAndEffort` if it reads right, then no new key), `limitsTitle` ("Plan limits"), `limit5h` ("5 hours"), `limitWeek` ("Week"), `limitResets` ("{pct}% · resets {when}"), `tileCompact` ("Compact"), `tileClear` ("Clear"), `tileRestart` ("Restart"), `tileStats` ("Stats").

- [ ] **Step 1: Failing tests** (via `test/support/rig.dart`):
  - tapping the header title opens the sheet showing the session title and the folder path;
  - the mode row has one segment per `capabilities.modes`, the current one selected, the description of the selected one under it; tapping another sends `mode`; with `modes: []` the row and its heading are absent;
  - with `stats.limits.five_hour` 34 and `seven_day` 62, two bars with `34%` and `62%`; without `stats`, no limits heading;
  - four tiles; Compact sends `command compact` and closes the sheet; Clear opens a dialog titled `webString('clearTitle')` and sends `command clear` only on its confirm button (`clearBtn`); Restart asks (existing restart dialog) then sends `restart`; Stats pushes `UsageScreen`;
  - while busy, Compact and Clear are disabled, Restart is not; Compact is absent when `capabilities.compact` is false, Clear when `capabilities.clear` is false;
  - the model row shows the current model and opens `ModelSheet` (only when `modelSwitchable`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per the spec's order: header (title, folder), model and effort, mode (segmented, description), limits (bars: green five-hour, accent week; reset time from `resetsAt` as local `HH:mm` when today, else the short weekday — `intl` `DateFormat` with the UI locale), tiles (4 equal, `card` background, radius 12, icon 22 above a label 10.5). A modal bottom sheet with a grab bar, `popover` background, top radius 18. Desktop parity: Clear has no pending-comments block (the desktop button has none; only a typed `/clear` is blocked).
- [ ] **Step 4: Run all tests, expect PASS.**
- [ ] **Step 5: Commit** `gh-143: the window settings sheet`.

### Task 4: Whole-app check and APK

- [ ] **Step 1:** `npx tsc -b`, `npx vitest run scripts/protocol`, then from `mobile/app` the three Flutter checks → all exit 0.
- [ ] **Step 2:** `flutter build apk --release` → the APK exists. No commit.
