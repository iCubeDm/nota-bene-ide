# Remote: usage statistics in the app (#91) Implementation Plan

**Goal:** The phone shows the host's usage report as the desktop's Usage tab does (`web/src/usage/UsageView.tsx`).

**Approach:** The app reads `GET /usage?provider=&period=` and posts `/usage/reset` through the window's channel (`windowHttp` in `lib/files/image_screen.dart`). The report is the generated `UsageReport` (`mobile/protocol`). The words are the web's own: the strings generator (`scripts/protocol/mobileStrings.ts`) copies every `usage*` key of the six web dictionaries into `strings.g.dart`, as #90 did for the batch. Number formatters are ported and pinned by a fixture the web code writes.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` (Controls: "usage statistics").

## Decisions

- Six languages; text only from the generated usage strings or the app's ARB. Neutral fixtures. Tests only on ports 4790-4795.
- Same requests as the desktop: `/usage?provider=<claude|codex>&period=<trip|7d|30d|all>`, `POST /usage/reset` with `{"provider": ...}`; poll every 2 s only while `importing` and the screen is open (leaving stops it).
- Default provider is the window's (`capabilities.provider == 'codex'` gives codex, else claude); default period `trip`.
- A report for a provider/period other than the current choice is never shown (the desktop's `shown` check). A failing request shows `usageLoadFail(status)`, no endless spinner.
- Reset asks first (`usageResetQ`), posts, switches to `trip`, reloads; a refused reset says so.
- Russian unit words (`тыс`, `млн`, `млрд`) and `<1%` parts read as on the desktop.

## Design

- Strings: every `usage*` key of `web/src/i18n/en.ts` goes to the generated output: plain strings via `usageString(key, lang)` (`USAGE_KEYS`), functions as templates via `usageTemplate(key, lang, args)` reusing the existing `TEMPLATE_KEYS` mechanism (mirrors `batchString`/`batchTemplate`). Key list derived at generation time, deterministic.
- Formatters (`lib/usage/format.dart`), pinned by `web/src/usage/mobileFormat.test.ts` writing `mobile/app/test/fixtures/usage/format.json` (`UPDATE_FIXTURES=1`): `pct`, `part`, `fmtTokens`, `modelName`, `num` (grouping as `toLocaleString`), `money(minor, currency, lang)` (`intl`, minor digits from the currency), `when`, `shortTime`, `weekDay` (`DateFormat` skeletons nearest the web's). `UsageView.tsx` exports what the fixture needs without behaviour change. Dates are not pinned (ICU and `intl` punctuation differ); only that `when` contains day and minutes. If `num`/`money` differ by a non-breaking space between ICU and `intl`, normalise only that and record it.
- Screen (`lib/usage/usage_screen.dart`, `UsageScreen({tab})`): provider choices (Claude, Codex), period choices, states loading / error / importing (`usageImporting`) / empty (the desktop's `live()` check) / report. Report as `Report` in UsageView.tsx: total with `fmtTokens`, side, model mix (stacked bar of top two plus rest), `Limits` (5-hour windows and weeks as bars with hit marks, hits list with show-all/top, extra and tank lines), `Spent` (tasks or projects, top 5 with show-all; a task opens `TaskDetail`). App theme colours, no web CSS port, one-column `ListView`. AppBar action `usageReset`. Entry: a "usage" item in `chat/controls.dart`, enabled when `capabilities.usage ?? true`.

## Files

`scripts/protocol/mobileStrings.ts`, `mobile/app/lib/l10n/strings.g.dart`, `lib/usage/{format,usage_screen}.dart`, `lib/chat/controls.dart`, `web/src/usage/{UsageView.tsx,mobileFormat.test.ts}`, tests `strings_test`, `usage_format_test`, `usage_screen_test` (with `FakeChannel` and `Rig`), `mobile/README.md`.

Final check: `flutter analyze`, `dart format --set-exit-if-changed`, `flutter test`, `npm test`, `npx tsc -b`, `npm run gen:protocol -- --check`. Commits `gh-91: ...`; draft PR into `remote`.
