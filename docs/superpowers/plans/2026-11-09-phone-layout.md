# Phone layout (#142) Implementation Plan

**Goal:** The chat screen of the Android app gets Telegram's layout: a floating header pill, bubbles for the user's messages, a floating composer with send always visible, and code blocks that open full screen.

**Approach:** Flutter widgets in `mobile/app/lib/chat/` and a new `mobile/app/lib/ui/` for shared pieces (icon set, round button, pill). `ChatScreen` drops its `AppBar` for a `ChatHeader` overlaid on the feed; the composer becomes a pill. No protocol or server change.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Look and layout", "Constraints").

## Constraints

- Every new string goes into all six ARB files (`mobile/app/lib/l10n/app_{en,ru,de,es,pt,zh}.arb`) with a real translation; `test/l10n_test.dart` checks keys.
- Icons match the web glyphs (path data from `web/src/tabs/TabStrip.tsx` `ICONS` and `web/src/controls/CompactClear.tsx`): stroke 2, round caps and joins, 24x24 viewBox, no fill.
- No new packages. Colours only from `NbColors` (`lib/theme.dart`), no new tokens (theme_test checks them against `web/src/theme.css`).
- Checks from `mobile/app`: `flutter analyze --fatal-infos`, `dart format --set-exit-if-changed lib test`, `flutter test`; gate on exit codes.
- Commits `gh-142: <summary>`; worktree `ai-ide-phone`, branch `gh-142-layout` (from `phone-ux`).

## Design

- Icon set (`lib/ui/nb_icon.dart`): `NbGlyph {back, more, send, mic, clip, stop, expand, copy, close, compact, clear, restart, usage, comments, settings}`; `NbIcon(glyph, {size = 20, color})`; top-level `svgPath(String d)` parser (commands MmLlHhVvCcSsQqAaZz, implicit repeats, arcs via `arcToPoint`; unknown command throws `FormatException`). Glyphs are shape lists (paths, rect, circle) painted by a `CustomPainter` scaled from 24, stroke 2 x scale. `usage`, `restart`, `comments`, `settings` from `TabStrip.tsx`; `compact`, `clear` from `CompactClear.tsx`; the rest lucide-style.
- Header (`chat/chat_header.dart`): `ChatHeader({tab, onTapTitle, actions})`, floating over the feed in a `Stack`, feed top padding equal to its height so items scroll under it. A 40 px round back button, an expanded 40 px pill (provider avatar letter, title ellipsized, subtitle model then meters), a round button for `actions` (existing `AgentMenu`). `providerLetter`: claude C, codex X, omp O, else first letter upper-cased or `?`. Meters: 22x4 bars, green five-hour, accent weekly, percent after each, semantics `5h n%`/`7d n%`, same scale as `web/src/stats/Meters.tsx`, clamped 0-100; a missing window shows no bar and no gap. No title shows `untitled`. Pill and buttons use `popover` at 92% with a `border` outline. `ChatScreen.onTapTitle` is wired by #143; null means not tappable.
- Bubbles: user items in a `ValueKey('bubble')` container, colour `alphaBlend(primary at .28, background)`, border `primary` 45%, radii 14 with bottom-right 4, max width 84%, padding 10/7. No time line (replayed items carry no ts).
- Composer (`chat/composer.dart`, layout only; `_send` and refusal logic unchanged): a pill (min height 40, radius 20, `popover` 95%, `border`) holding a borderless `TextField` (1-6 lines) and the mic at its right; a 40 px round send button outside it (`ValueKey('send')`), `primary` enabled, `muted` disabled, always visible. While busy with empty field and comments the slot shows stop (`destructive`, sends `interrupt`); typing turns it back into send. Paperclip comes in #146.
- Code full screen (`chat/code_screen.dart`): `CodeScreen({code, lang})`, `openCode(context, code, lang)`; expand button beside copy in `chat/code.dart`. `codeLines` plural and `expandCode` ARB keys. Body is an `InteractiveViewer` (unconstrained, scale 0.5-3) of a non-selectable line-number column plus highlighted code (`softWrap: false`, monospace 13, height 1.5) in a `SelectionArea`; bar has close, language, line count, copy. Landscape works by turning the phone; orientation is not forced. #144 adds the comment action.

## Review focus

- Very long title or model name: pill ellipsizes, round buttons keep size.
- Contrast of bubble and pill readable in all six themes (tokens only).
- One very long line and a 500-line block scroll both ways, numbers stay aligned.
- Keyboard open: composer stays above it, the feed's last item not hidden.

## Files

New: `lib/ui/nb_icon.dart`, `lib/chat/chat_header.dart`, `lib/chat/code_screen.dart`. Changed: `chat/{chat_screen,composer,code}.dart`, six ARB files. Tests: `nb_icon`, `chat_header`, `chat_screen`, `composer`, `code_screen`.

Final: three checks, then `flutter build apk --release` (debug-signed locally); no commit for this step.
