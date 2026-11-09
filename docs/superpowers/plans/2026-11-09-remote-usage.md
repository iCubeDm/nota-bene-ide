# Remote: usage statistics in the app (#91) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the phone shows the host's usage report as the desktop's Usage tab does (`web/src/usage/UsageView.tsx`).

**Architecture:** the app reads `GET /usage?provider=&period=` and posts `/usage/reset` through the window's channel
(`windowHttp` in `lib/files/image_screen.dart`). The report is the generated `UsageReport` (`mobile/protocol`). The
words are the web's own: the strings generator (`scripts/protocol/mobileStrings.ts`) copies every `usage*` key of
the six web dictionaries into `strings.g.dart`, as #90 did for the batch. The number formatters are ported and
pinned by a fixture the web code writes.

**Tech Stack:** Flutter (mobile/app), Dart `intl`, Vitest for fixtures, the existing strings generator.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` (Controls: "usage statistics").

## Global Constraints

- All six app languages; user-visible text only from the generated usage strings or the app's ARB (`AppLocalizations`).
  New ARB keys need real translations in en, ru, zh, es, pt, de.
- Same requests as the desktop: `/usage?provider=<claude|codex>&period=<trip|7d|30d|all>`, `POST /usage/reset`
  with JSON `{"provider": ...}`; poll every 2 s only while `importing` and the screen is open.
- Default provider is the window's (`tab.capabilities?.provider == 'codex'` → codex, else claude); default period `trip`.
- Public repo: neutral fixtures, nothing personal.
- Tests only on ports 4790–4795; never 4777–4789 or `~/.nota-bene`.

## Review Focus

1. A report for another provider/period than the one now chosen is never shown (the desktop's `shown` check).
2. A failing request shows `usageLoadFail` with the status and keeps the last report away; the screen does not spin forever.
3. Reset asks first (`usageResetQ`), then posts, switches to `trip` and reloads; a refused reset says so.
4. Leaving the screen stops the import polling.
5. Russian unit words (`тыс`, `млн`, `млрд`) and `<1%` parts read as on the desktop.

---

### Task 1: the web's usage words in the app

**Files:** Modify `scripts/protocol/mobileStrings.ts`, regenerate `mobile/app/lib/l10n/strings.g.dart`
(via `npm run gen:protocol`); Test `mobile/app/test/strings_test.dart`.

- [ ] Add every key of `web/src/i18n/en.ts` that starts with `usage` (strings and functions alike) to the generated
  output: plain strings into a `USAGE_KEYS` list served by `usageString(key, lang)`; functions as templates (the
  existing `TEMPLATE_KEYS` mechanism: placeholders `{0}`, `{1}`…, argument kinds from each function's parameters)
  served by `usageTemplate(key, lang, args)`. Mirror `batchString`/`batchTemplate`; reuse the template code rather than
  copy it. A key list derived from en.ts at generation time is fine, as long as the generated file is deterministic.
- [ ] Test: for `ru` and `en`, `usageString('usageReset', …)` and one template with an argument
  (`usageTemplate('usageShowAll', lang, [7])`) equal the web's text (read the expected values from `web/src/i18n/*.ts`).
  Watch it fail first.
- [ ] `npm run gen:protocol -- --check` passes; `flutter test test/strings_test.dart` passes.
- [ ] Commit `gh-91: the web's usage words in the app`.

### Task 2: the usage formatters

**Files:** Create `mobile/app/lib/usage/format.dart`, `web/src/usage/mobileFormat.test.ts` (writes
`mobile/app/test/fixtures/usage/format.json` with `UPDATE_FIXTURES=1`, compares otherwise), Test
`mobile/app/test/usage_format_test.dart`. Export from `UsageView.tsx` whatever the fixture test needs (`pct`, `part`,
`modelName`, `fmtTokens`, `money`, `num`), without changing their behaviour.

- [ ] Port with the same names: `pct(a, b)`, `part(a, b)`, `fmtTokens(n, lang)`, `modelName(id)`, `num(n, lang)`
  (grouping as `toLocaleString`), `money(minor, currency, lang)` (`intl` `NumberFormat.simpleCurrency`/`currency`; the
  minor-unit digits from the currency), and `when(ts, lang)`, `shortTime(ts, lang)`, `weekDay(key, lang, plus)` with
  `intl` `DateFormat` skeletons closest to the web's options.
- [ ] Fixture: for each of the six languages, values of `pct`, `part`, `fmtTokens` (0, 999, 1500, 2.5e6, 3.2e9),
  `modelName` (`claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-5.5`), `num(1234567)`, `money(12345, 'USD')`,
  `money(500, 'JPY')`. The Dart test equals the fixture for those. Dates are NOT pinned (ICU and `intl` differ in
  punctuation); test only that `when` contains the day number and the minutes in a fixed local time.
- [ ] Ruling to ledger if `num`/`money` differ by a non-breaking space or similar between ICU and `intl`: normalise
  only that, say so.
- [ ] Commit `gh-91: the usage formatters, pinned to the desktop's`.

### Task 3: the usage screen

**Files:** Create `mobile/app/lib/usage/usage_screen.dart`; Modify `mobile/app/lib/chat/controls.dart` (a menu
item "usage", label `usageString('usage', lang)`, enabled when `tab.capabilities?.usage ?? true`, opens the screen);
Test `mobile/app/test/usage_screen_test.dart`, using `FakeChannel` (`test/support/fakes.dart`) and the `Rig`.

- [ ] `UsageScreen({required WindowTab tab})`: the AppBar title `usage`. A row of provider choices (Claude, Codex) and
  period choices (`usagePeriodTrip/7d/30d/all`). States: loading `usageLoading`, error `usageLoadFail(status)`,
  importing `usageImporting` (and poll every 2 s while open), empty `usageEmpty` (the desktop's `live()` check: read it
  in UsageView.tsx), else the report. Show a report only if its `provider` and `period` equal the current choice.
- [ ] The report, top to bottom as `Report` in UsageView.tsx: the total (`usageTokens`, `fmtTokens(total.w)`,
  `usageSince(when(from))` for trip), `usageSide`, the model mix (a stacked bar of the top two models plus the rest,
  each named under it), `Limits` (the 5-hour windows and weeks as bars with a hit mark, the hits list with
  `usageShowAll`/`usageShowTop`, the extra line and the tank line), `Spent` (tasks or projects, top 5 with
  show-all; a task taps open to `TaskDetail`: its line, subagents, top calls). Reuse colours from the app theme;
  no web CSS port. Phone layout: one column, `ListView`.
- [ ] Reset: an AppBar action `usageReset` → a dialog with `usageResetQ` and a `usageReset` button → `POST
  /usage/reset` `{"provider": p}` → on 200 period `trip` and reload; otherwise `usageLoadFail(status)`.
- [ ] Tests (write first, see each fail): (1) opens with the window's provider and `trip`, asks
  `/usage?provider=claude&period=trip`, shows the total; (2) switching period asks again and a late answer for the old
  period is not shown; (3) 500 → `usageLoadFail` text; (4) `importing: true` → `usageImporting` and a second request
  after 2 s; leaving the screen → no further request; (5) reset: confirm → POST body `{"provider":"claude"}` → reload
  with `trip`; (6) a task row taps open to its detail; (7) the menu item opens the screen and is disabled when
  `capabilities.usage` is false.
- [ ] Checks: focused test; whole `flutter test` once; `dart format lib test && flutter analyze`; `flutter build apk --debug`.
- [ ] Commit `gh-91: the usage screen`.

### Task 4: Finish

- [ ] `mobile/README.md`: a sentence on usage statistics (where the words come from).
- [ ] `flutter analyze`, `dart format --set-exit-if-changed`, `flutter test` (app, channel), `npm test`, `npx tsc -b`,
  `npm run gen:protocol -- --check`, each gated on its exit code, one at a time.
- [ ] Commit `gh-91: docs for usage on the phone`; push; draft PR into `remote`.
