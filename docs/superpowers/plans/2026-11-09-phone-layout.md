# Phone layout (#142) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chat screen of the Android app gets Telegram's layout: a floating header pill, bubbles for the user's messages, a floating composer with send always visible, and code blocks that open full screen.

**Architecture:** Flutter widgets in `mobile/app/lib/chat/` and a new `mobile/app/lib/ui/` for shared pieces (the icon set, the round button, the pill). `ChatScreen` drops its `AppBar` for a `ChatHeader` overlaid on the feed; the composer becomes a pill. Nothing changes in the protocol or the server.

**Tech Stack:** Flutter 3.47.9 (pinned in pubspec), Dart, flutter_test widget tests, gen-l10n ARB files.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` (sections "Look and layout", "Constraints").

## Global Constraints

- Every new user-visible string goes into all six ARB files (`mobile/app/lib/l10n/app_{en,ru,de,es,pt,zh}.arb`) with a real translation; `test/l10n_test.dart` checks keys.
- Icons match the web UI's glyphs: copy the path data from `web/src/tabs/TabStrip.tsx` (`ICONS`) and `web/src/controls/CompactClear.tsx`; stroke 2, round caps and joins, 24×24 viewBox, no fill.
- No new packages in `pubspec.yaml`.
- Colours only from `NbColors` (`lib/theme.dart`); no new theme tokens (theme_test checks tokens against `web/src/theme.css`).
- Checks, run from `mobile/app`: `flutter analyze --fatal-infos`, `dart format --set-exit-if-changed lib test`, `flutter test`. Gate on exit codes.
- Commits: `gh-142: <summary>` with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Work in the worktree `/Users/icubedm/Documents/Projects/ai-ide-phone` on branch `gh-142-layout` (cut from `phone-ux`).

## Review Focus

- A very long session title or model name: the pill ellipsizes, the round buttons keep their size.
- No `stats` yet, or `limits` without one of the two windows: the subtitle shows no bar for the missing one, no gap.
- Light themes: bubble and pill contrast comes from tokens, readable in every one of the six themes.
- A code block of one very long line and one of 500 lines: the full-screen view scrolls both ways, line numbers stay aligned.
- The keyboard open: the floating composer stays above it and the feed's last item is not hidden behind the pill.

---

### Task 1: The icon set

**Files:**
- Create: `mobile/app/lib/ui/nb_icon.dart`
- Test: `mobile/app/test/nb_icon_test.dart`

**Interfaces:**
- Produces: `enum NbGlyph { back, more, send, mic, clip, stop, expand, copy, close, compact, clear, restart, usage, comments, settings }`; `class NbIcon extends StatelessWidget { const NbIcon(this.glyph, {super.key, this.size = 20, this.color}); }` (color null = `IconTheme.of(context).color`); `Path svgPath(String d)` (top-level, for tests).

- [ ] **Step 1: Write the failing tests**

```dart
test('svgPath draws lines, relative moves and arcs', () {
  final p = svgPath('M4 20V10M10 20V4M16 20v-7M22 20H2');
  final b = p.getBounds();
  expect(b.left, 2); expect(b.top, 4); expect(b.right, 22); expect(b.bottom, 20);
  final r = svgPath('M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5').getBounds();
  expect(r.left, lessThan(4)); expect(r.bottom, greaterThan(20));
});
test('svgPath rejects an unknown command', () {
  expect(() => svgPath('M0 0X1 1'), throwsFormatException);
});
testWidgets('every glyph paints at the given size', (t) async {
  for (final g in NbGlyph.values) {
    await t.pumpWidget(Center(child: NbIcon(g, size: 24, color: const Color(0xffffffff))));
    expect(t.getSize(find.byType(NbIcon)), const Size(24, 24));
  }
});
```

- [ ] **Step 2: Run them, expect failure** — `flutter test test/nb_icon_test.dart` → FAIL (no such file/library).
- [ ] **Step 3: Implement.** A parser for the commands M m L l H h V v C c S s Q q A a Z z (comma/space separated, implicit repeats, numbers like `-.5` and `1-3`); arcs via `Path.arcToPoint(radius, rotation, largeArc, clockwise: sweep == 1)`. Each glyph is a list of shapes: path strings, plus `rect(x,y,w,h,rx)` and `circle(cx,cy,r)` for the web icons that use them. Paths: `usage`, `restart`, `comments`, `settings` from `TabStrip.tsx`; `compact`, `clear` from `CompactClear.tsx`; the rest lucide-style in the same stroke (back `m12 19-7-7 7-7M19 12H5`, more three circles r=1 at y 5/12/19, send `m22 2-7 20-4-9-9-4zM22 2 11 13`, mic `M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3`, clip `m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5`, stop rect 6,6,12,12 rx 2, expand `M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7`, copy rect 9,9,13,13 rx 2 + `M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1`, close `M18 6 6 18M6 6l12 12`). Painted by a `CustomPainter` scaled from 24 to `size`, stroke width 2 × scale.
- [ ] **Step 4: Run the tests, expect PASS.**
- [ ] **Step 5: Commit** `gh-142: the web's icon glyphs for the phone`.

### Task 2: The header pill

**Files:**
- Create: `mobile/app/lib/chat/chat_header.dart`
- Modify: `mobile/app/lib/chat/chat_screen.dart` (replace the `AppBar`; keep the status strip and everything else)
- Test: `mobile/app/test/chat_header_test.dart`, and update `test/chat_screen_test.dart` where it reads the app bar

**Interfaces:**
- Consumes: `NbIcon`, `NbGlyph` (Task 1); `WindowTab.feed.title`, `.model`, `.stats`, `.capabilities?.provider`.
- Produces: `class ChatHeader extends StatelessWidget { const ChatHeader({super.key, required this.tab, this.onTapTitle, this.actions = const []}); }`. `ChatScreen` gains `final VoidCallback? onTapTitle;` passed through (wired by #143). `actions` render in a round button; the existing `AgentMenu` is passed as today.
- `String providerLetter(String? provider)`: `claude`→`C`, `codex`→`X`, `omp`→`O`, otherwise first letter upper-cased or `?`.

- [ ] **Step 1: Write the failing tests** (`chat_header_test.dart`, using `test/support/rig.dart`):
  - the pill shows the session title from the replay and the model in the subtitle;
  - with a `stats` event carrying `limits.five_hour.utilization` and `seven_day`, two meters with semantics labels `5h <n>%` and `7d <n>%` appear; with only `five_hour`, one;
  - with no title, the pill shows `untitled` (existing string);
  - tapping the pill calls `onTapTitle`; with `onTapTitle` null it is not tappable (no `InkWell` ancestor of the title text);
  - the back button pops the route.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Layout per the spec: a 40 px round back button (`NbGlyph.back`), an expanded 40 px-high pill (avatar circle with `providerLetter`, title one line ellipsized, subtitle `model` then the meters: 22×4 bars, green for five-hour, accent for weekly, percent text after each), a 40 px round button holding `actions`. Pill and buttons: `popover` at 92% opacity with a `border` outline. Utilization on the same scale as `web/src/stats/Meters.tsx` (read it; clamp to 0–100). The header floats: `ChatScreen` puts it in a `Stack` over the feed with the feed's top padding equal to the header's height, so items scroll under it.
- [ ] **Step 4: Run the new and the existing chat tests, expect PASS.**
- [ ] **Step 5: Commit** `gh-142: a floating header pill with the session, model and limits`.

### Task 3: Bubbles

**Files:**
- Modify: `mobile/app/lib/chat/chat_screen.dart` (`FeedItemView`, the `UserItem` case)
- Test: `mobile/app/test/chat_screen_test.dart`

- [ ] **Step 1: Write the failing test:** a user item renders inside a widget keyed `ValueKey('bubble')` whose decoration colour equals `Color.alphaBlend(c.primary.withValues(alpha: .28), c.background)` and whose bottom-right radius is 4 while the others are 14; an assistant item has no such key.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement:** max width 84% of the feed (LayoutBuilder), padding 10/7, border `primary` at 45% alpha, text `foreground`, a time line under the text is not added (the feed items carry no ts for replays; out of scope).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `gh-142: the user's messages as bubbles`.

### Task 4: The floating composer

**Files:**
- Modify: `mobile/app/lib/chat/composer.dart` (layout only; `_send` and refusal logic unchanged)
- Test: `mobile/app/test/composer_test.dart`

**Interfaces:**
- Consumes: `NbIcon` (Task 1). `MicButton` keeps its API; it is placed inside the pill instead of as `suffixIcon`.

- [ ] **Step 1: Write the failing tests:**
  - with an empty field and no comments the send button is present and disabled (`onPressed == null`), keyed `ValueKey('send')`;
  - with text it is enabled and sends as before (existing tests keep passing);
  - while the tab is busy and the field and comments are empty, the send slot shows the stop button (tooltip `stop`), which sends `interrupt`; typing text turns it back into send (which asks "send now", as today).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement:** a pill (min height 40, radius 20, `popover` 95%, `border` outline) holding the `TextField` without its own border (min 1, max 6 lines) and the mic at its right; a 40 px round send button outside it, `primary` when enabled, `muted` with `mutedFg` icon when disabled; stop uses `destructive`. The paperclip is not added here (#146).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `gh-142: a floating composer, send always visible`.

### Task 5: Code full screen

**Files:**
- Create: `mobile/app/lib/chat/code_screen.dart`
- Modify: `mobile/app/lib/chat/code.dart` (an expand button beside copy)
- Modify: the six ARB files (keys below)
- Test: `mobile/app/test/code_screen_test.dart`

**Interfaces:**
- Produces: `class CodeScreen extends StatelessWidget { const CodeScreen({super.key, required this.code, this.lang}); }` and `void openCode(BuildContext context, String code, String? lang)` (pushes a `MaterialPageRoute`). #144 adds the comment action to its bar.
- New ARB keys: `expandCode` ("Open full screen"), `codeLines` ("{count, plural, one{{count} line} other{{count} lines}}"), translated in all six.

- [ ] **Step 1: Write the failing tests:**
  - a `CodeBlock` shows an expand button (tooltip `expandCode`); tapping it opens `CodeScreen` with the language and `codeLines` in its bar;
  - `CodeScreen` shows numbers `1`..`n` for an n-line code, in their own non-selectable column;
  - a 300-character line does not wrap: the code's `Text` has `softWrap: false`;
  - copy puts the whole code on the clipboard (mock `SystemChannels.platform`); close pops.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement:** black-on-`codeBg` full screen; a bar with close (`NbGlyph.close`), the language and line count, copy; the body an `InteractiveViewer` (`constrained: false`, min scale 0.5, max 3) holding a row of the line-number column (`mutedFg`, right-aligned) and the highlighted code (`highlightSpans`, `softWrap: false`, monospace 13, height 1.5) inside a `SelectionArea`. The app is not locked to portrait, so landscape works by turning the phone; nothing forces it.
- [ ] **Step 4: Run, expect PASS; run `flutter test test/l10n_test.dart`.**
- [ ] **Step 5: Commit** `gh-142: code blocks open full screen`.

### Task 6: Whole-app check and APK

- [ ] **Step 1:** From `mobile/app`: `flutter analyze --fatal-infos && dart format --set-exit-if-changed lib test && flutter test` → all exit 0.
- [ ] **Step 2:** `flutter build apk --release` → `build/app/outputs/flutter-apk/app-release.apk` exists (debug-signed locally; the author installs it over the current one, which is debug-signed too).
- [ ] **Step 3:** No commit; report the APK path.
