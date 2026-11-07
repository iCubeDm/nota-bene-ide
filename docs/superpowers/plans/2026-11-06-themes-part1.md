# Themes, part 1: theme system, Darcula, Plannotator, icons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every colour goes through theme tokens; two dark themes ship (Darcula, the new default, and Plannotator, today's look),
chosen in the gear menu and in a Themes section of Settings; the header's Sessions and ↻ Agent and the file bar's
"Open raw" become icons; every control with a shortcut names it in its tooltip.

**Architecture:** A theme is a block of CSS variables on `:root[data-theme="<id>"]` in `web/src/theme.css`. The choice is a
global preference handled exactly like `uiScale`: `prefs.json` on the server, `hello.theme`, a localStorage cache applied
before React renders, a small store in `web/src/shell/theme.ts`. Code highlighting and mermaid read the tokens and the
theme's kind (dark or light).

**Tech Stack:** React 19, Redux, Tailwind 4 (`@theme inline`), highlight.js, mermaid 10, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-themes-design.md` (sections 1 and "Decided by the builder"). Light themes
(section 2) and the markup palette (section 3) are later plans.

## Global Constraints

- Theme ids, in this order: `darcula` (default), `plannotator`, `intellij-light`, `github-light`, `solarized-light`. This
  plan ships the first two; the list type holds all five only when part 2 adds them. Names are not translated.
- An unknown or missing id falls back to `darcula`. `hello.theme` is optional, like `uiScale`: no protocol bump.
- Plannotator keeps today's values exactly, the 24px grid included.
- Layout, tabs, panels, controls, features and shortcuts do not change; shadcn/ui shapes stay (no square corners, no
  solid slabs, no status bar).
- WCAG AA (4.5:1 body text, 3:1 controls and large text) in every theme; a failing value moves in lightness, never hue.
- Every user-visible string goes through `web/src/i18n` with a real translation in all six files (`en ru de es pt-BR
  zh-CN`).
- Tests and smoke only on ports 4790–4795. Run full suites one at a time; trust exit codes.
- Branch from `main` as `gh-70-themes`; commits `gh-70: …` with the trailer
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. One PR, squash.

## Rulings made while planning (not in the spec)

- **Cross-window sharing works as the scale does:** another window picks the theme up on its next `hello` (reconnect or
  reload), not live. A live broadcast would be a new server event for one preference; the scale has lived without it.
  "A switch re-renders diagrams in every window" therefore means: in the window where it changes, at once; elsewhere, on
  the next hello.
- **Favicon colours stay literal** (allow-listed): the browser tab is not themed, and the status colours must stay
  recognisable across themes.
- **The 3D viewer's background** reads `--card` at runtime (its existing CSS-to-three helper); its `#202020` canvas
  fallback is allow-listed.
- **TextBody's inline "Open raw"** (inside "Too large · Open raw") keeps its text: it is a sentence, not a toolbar.

## Review Focus

1. **First paint after a reload with Plannotator saved:** no Darcula flash. Covered by Task 2's
   `applies the cached theme at import` test and Task 6's e2e reload.
2. **A stale `hello` arriving after a local choice** must not undo it (same race as the scale). Task 2 test
   `an older hello does not undo an unconfirmed choice`.
3. **A part left in the old colours** after the switch: code blocks, diagrams, the composer, popovers, focus ring,
   flashes. Task 3's literal check plus Task 6's e2e that samples five elements in both themes.
4. **The pressed tool button when nothing has focus** (page load, body focused) shows the unfocused grey, not blue. Task 4
   test `pressed button is grey until its panel has focus`.
5. **A screen-reader or test finding the header buttons by name** after the text goes: `aria-label`s keep the names.
   Task 5 tests look the buttons up by role and name.

---

### Task 1: The theme preference on the server

**Files:**
- Modify: `shared/src/lang.ts` (next to `UI_SCALES`), `shared/src/protocol.ts:227` (hello) and its re-export line `:524`
- Modify: `server/src/prefs.ts` (type, `readPrefs`, new setter), `server/src/system.ts:327-339` (POST `/system/prefs`),
  `server/src/server.ts:325-326` (hello)
- Test: `server/src/prefs.test.ts`, `server/src/system.test.ts`

**Interfaces:**
- Produces: `THEMES = ['darcula', 'plannotator'] as const`, `type ThemeId`, `isThemeId(v: unknown): v is ThemeId`,
  `DEFAULT_THEME: ThemeId = 'darcula'`, `THEME_KIND: Record<ThemeId, 'dark' | 'light'>` exported from
  `@nota-bene/shared`; `Prefs.theme?: ThemeId`; `setThemePref(theme: ThemeId): void`; `hello.theme?: ThemeId`;
  POST `/system/prefs` accepts `{ theme }`.

- [ ] **Step 1: Write the failing tests**, mirroring the `uiScale` ones:
  - `prefs.test.ts` `theme: kept when known, dropped when not`: file `{ theme: 'plannotator' }` → `readPrefs().theme ===
    'plannotator'`; file `{ theme: 'neon' }` → `'theme' in readPrefs()` is false.
  - `system.test.ts` `theme: saved for every window, unknown ids refused`: no choice → `'theme' in hello` false; POST
    `{ theme: 'neon' }` → 400; POST `{ theme: 'plannotator' }` → 200 and `readPrefs().theme === 'plannotator'`; a second
    server's hello has `theme: 'plannotator'`.
- [ ] **Step 2: Run** `npx vitest run server/src/prefs.test.ts server/src/system.test.ts` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** the shared exports, `readPrefs` (`if (isThemeId(theme)) out.theme = theme`), `setThemePref`
  (like `setUiScalePref`), the POST branch (400 `bad theme`, echo `{ theme }`), and `...(theme ? { theme } : {})` in hello.
- [ ] **Step 4: Run** the same command plus `npx tsc -b` — PASS, no type errors.
- [ ] **Step 5: Commit** `gh-70: the theme preference: prefs.json, POST /system/prefs and hello`.

### Task 2: The theme store in the browser

**Files:**
- Create: `web/src/shell/theme.ts`, `web/src/shell/theme.test.ts`
- Modify: `web/src/store/store.ts:173-175` (adopt on hello), `web/src/main.tsx` (import `./shell/theme.ts` before
  `./theme.css` and before render)

**Interfaces:**
- Consumes: Task 1's shared exports.
- Produces: `theme = { get(): ThemeId; kind(): 'dark' | 'light'; choose(v: ThemeId): void; adopt(server: unknown): void;
  subscribe(f: () => void): () => void; reload(): void }` and `useTheme(): ThemeId`. localStorage key `nb.theme`.
  The store sets `document.documentElement.dataset.theme` to the id, always (Darcula included), at module load and on
  every change.

- [ ] **Step 1: Write the failing tests** in `theme.test.ts`, copying the shape of `uiScale.test.ts`:
  - `defaults to darcula`: empty storage → `get() === 'darcula'`, `<html data-theme="darcula">`.
  - `choose saves locally and posts`: `choose('plannotator')` → storage `'plannotator'`, POST body
    `{ theme: 'plannotator' }`, `data-theme="plannotator"`, `kind() === 'dark'`.
  - `applies the cached theme at import`: storage `'plannotator'`, `reload()` → `data-theme="plannotator"` before any
    subscriber runs.
  - `unknown ids fall back`: storage `'neon'` → `'darcula'`; `adopt('bogus')` leaves the current one.
  - `an older hello does not undo an unconfirmed choice`: `choose('plannotator')`, `adopt('darcula')` → still
    `'plannotator'`.
- [ ] **Step 2: Run** `npx vitest run web/src/shell/theme.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `theme.ts` as a copy of `uiScale.ts`'s pattern (`read`, `apply`, `setLocal`, `persist` with
  `unsynced`); `apply` writes `dataset.theme`. Wire `theme.adopt(ev.theme)` next to `uiScale.adopt` in `store.ts`.
- [ ] **Step 4: Run** the test file and `npx tsc -b` — PASS.
- [ ] **Step 5: Commit** `gh-70: a theme store, applied before the first render`.

### Task 3: Tokens, the Plannotator block, and no colour outside them

The visible result of this task is **no change at all** with `data-theme="plannotator"`: every literal moves into a token
whose Plannotator value is the literal it replaces. Darcula values come in Task 4; until then the `darcula` block may
repeat Plannotator's.

**Files:**
- Modify: `web/src/theme.css` (token blocks, `@theme inline` mappings, `.grid-pane`, focus ring, flash)
- Create: `web/src/feed/hljs.css` (highlight.js classes on `--syn-*` tokens); Modify `web/src/feed/Markdown.tsx:3`
  (import it instead of `highlight.js/styles/github-dark.min.css`)
- Modify every file that holds a colour literal or a Tailwind palette class. The full list, from
  `grep -rnoE "#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\("` and the palette-class grep: `feed/markdown.css`, `vcs/graph.ts`,
  `files/FileIcon.tsx`, `controls/ModePill.tsx`, `comments/HighlightLayer.tsx`, `composer/Composer.tsx`,
  `model/viewer.ts`, `tasks/TasksDrawer.tsx`, `tasks/CardMenu.tsx`, `shell/Toasts.tsx`, `feed/PlanCard.tsx`,
  `feed/DoneLine.tsx`, `diagram/DiagramView.tsx`, `controls/ModelPill.tsx`, `controls/CompactClear.tsx`,
  `composer/SlashPicker.tsx`, `composer/MentionPicker.tsx`, `components/ui/tooltip.tsx`, `components/ui/dialog.tsx`,
  `components/ui/button.tsx`, `comments/ShortcodePicker.tsx`, `comments/SelectionButton.tsx`, `comments/EmojiMenu.tsx`,
  `comments/CommentPopup.tsx`, `comments/card/CommentCardPopover.tsx`, `media/PlayerControls.tsx`, `media/Timeline.tsx`,
  `media/PlayerBar.tsx`, `files/view/HtmlBody.tsx`, `files/RecentFiles.tsx`, `attachments/Attachments.tsx`. All paths under
  `web/src/`.
- Test: create `web/src/theme.test.ts`

**Interfaces:**
- Produces these token names (CSS variables in each theme block; Tailwind names in `@theme inline` where components use
  them as classes). Later tasks and part 2 rely on the names:
  - existing: `--background --foreground --card --popover --primary --primary-fg --muted --muted-fg --nb-accent
    --destructive --success --border --border-soft --code-bg --side --chrome`
  - `--separator` (menu separators), `--link`
  - `--pane-image`, `--pane-size` (the `.grid-pane` texture: `background-image` and `background-size`)
  - `--tab-on-bg --tab-on-fg --tab-line` (active tab)
  - `--tool-on --tool-on-idle --tool-on-fg` (pressed tool button: panel focused, unfocused, icon colour)
  - `--accent-sessions --accent-agent --accent-model --accent-usage`
  - `--code-inline-bg --code-inline-fg`
  - `--syn-keyword --syn-string --syn-function --syn-number --syn-comment --syn-type --syn-variable --syn-property`
  - `--focus-border --focus-ring`
  - `--flash` (the jump-to-source highlight), `--diagram-bg`
  - Colours that differ per item but not per theme's role (file-type letters in `FileIcon`, git-graph lanes, mode pill
    colours) become a numbered set `--hue-1 … --hue-8`, so a light theme can darken them all at once.
- Plannotator's values for the new tokens are today's literals; for `--tab-*` and `--tool-*` they reproduce today's
  `bg-primary/15 text-primary` (as `color-mix(in oklch, var(--primary) 15%, transparent)` and `var(--primary)`), with
  `--tool-on-idle` equal to `--tool-on`, so Plannotator keeps a single pressed look. Its `--syn-*` values are those of
  `github-dark.min.css`.

- [ ] **Step 1: Write the failing test** `theme.test.ts` → `no colour literal outside the theme files`: walks
  `web/src/**/*.{ts,tsx,css}` except `*.test.*`, `theme.css`, `hljs.css`, `fonts.css`, and fails listing `file:line` for
  any `#hex`, `oklch(`, `rgb(`/`rgba(`, `hsl(`, or Tailwind class `(bg|text|border|ring|fill|stroke|from|to|outline|shadow|
  decoration|accent|caret)-(white|black|<palette>-<n>)`. The allow-list is explicit, by file and literal:
  the five markup colours (`media/markup/` colour table), `text-white` on primary buttons, `shell/Favicon.ts`, the
  `#202020` canvas fallback in `model/viewer.ts`, `#000` behind fullscreen media. A second test `every theme defines
  every token`: parse `theme.css`, collect the variable names of the `plannotator` block, assert the `darcula` block has
  exactly the same set.
- [ ] **Step 2: Run** `npx vitest run web/src/theme.test.ts` — FAIL with the current list of literals.
- [ ] **Step 3: Restructure `theme.css`:** `:root` keeps only fonts and radii; `:root, :root[data-theme="darcula"]` and
  `:root[data-theme="plannotator"]` blocks hold the colours. `.grid-pane` uses `var(--pane-image)`/`var(--pane-size)`.
  The focus ring uses `--focus-ring`; `nb-flash` uses `--flash`.
- [ ] **Step 4: Move each literal** in the files above to a token or a `color-mix()` of tokens, keeping its Plannotator
  value. `hljs.css` maps hljs classes: `keyword selector-tag built_in` → keyword, `string attr-value regexp` → string,
  `title function_ title.class_` → function, `number literal` → number, `comment quote` → comment, `type` → type,
  `variable template-variable` → variable, `attr property params` → property.
- [ ] **Step 5: Run** `npx vitest run web/src/theme.test.ts` and `npm test` — PASS.
- [ ] **Step 6: Check the look is unchanged:** `npm run build -w web`, start a test window on 4790 with a temp
  `NOTA_BENE_HOME`/`CLAUDE_JOURNAL_VAULT`, set Plannotator, screenshot chat with a code block and a mermaid diagram, the
  file tree, a menu and Settings; compare with the same shots from `main`. Expected: no visible difference.
- [ ] **Step 7: Commit** `gh-70: every colour through theme tokens; Plannotator holds today's values`.

### Task 4: Darcula values, its texture and states

**Files:**
- Modify: `web/src/theme.css` (the `darcula` block), `web/src/tabs/TabStrip.tsx:110`, `web/src/shell/ToolStrip.tsx:12-31`,
  header controls (`controls/SessionPicker.tsx`, `shell/RestartMenu.tsx`, `controls/ModelPill.tsx`, `shell/Header.tsx`
  usage button), input styles in popovers (`components/ui/input.tsx` if present, else the filter inputs in
  `SessionPicker.tsx` and `files/RecentFiles.tsx`)
- Create: `web/src/shell/focusWithin.ts`
- Test: `web/src/shell/ToolStrip.test.tsx` (create if absent), `web/src/theme.test.ts`

**Interfaces:**
- Consumes: Task 3's tokens.
- Produces: `useFocusWithin(el: () => Element | null): boolean`, true while `document.activeElement` is inside the
  element, updated on `focusin`/`focusout`. ToolButton takes `focused: boolean`.

Darcula values (spec table, verbatim): background `#2b2b2b`; foreground `#c9ced6`; card `#323435`; side `#2f3031`; chrome
`rgb(47 48 49 / .6)`; popover `#3c3f41`; separator `#505050`; muted `#3a3c3e`; muted-fg `#8f959c`; border `#45484b`;
border-soft `rgb(255 255 255 / .07)`; primary `#4a78c2`, primary-fg `#ffffff`; link `#589df6`; tab-line `#4a88c7`;
nb-accent (warning, comment marks) `#ffc66d`; success `#66bf31`; destructive `#e06c64`; code-inline-bg `#2e2e2e`,
code-inline-fg `#4f86cd`; focus-border `#466d94`, focus-ring `#3d6185` (2px); tab-on-bg `#45484b`, tab-on-fg `#ffffff`;
tool-on `#4a78c2`, tool-on-idle `#4b4e51`, tool-on-fg `#ffffff`; accent-sessions `#589df6`, accent-agent `#66bf31`,
accent-model `#ae8abe`, accent-usage `#ffc66d` (the gear stays neutral). Syntax: keyword `#cc7832`, string `#66bf31`,
function and type `#ffc66d`, number `#6897bb`, comment `#808080`, variable `#f99e71`, property `#9876aa`.
Texture: millimetre paper in CSS `mm`: white hairlines every 1mm at `.018`, 5mm at `.035`, 10mm at `.06` opacity
(three pairs of linear gradients; `--pane-size` `10mm 10mm` with the finer lines repeating inside).

- [ ] **Step 1: Write the failing tests:**
  - `ToolStrip.test.tsx` `pressed button is grey until its panel has focus`: tree open, focus on `body` → `#toggleTree`
    has `data-focused="false"`; focus a row inside `#tree-sheet` → `data-focused="true"`; focus the composer → `"false"`.
    (The class reads the token; the test asserts the attribute.)
  - `theme.test.ts` `Darcula passes AA`: from the parsed `darcula` block, contrast(foreground, background) ≥ 4.5,
    (foreground, card) ≥ 4.5, (muted-fg, card) ≥ 4.5, (muted-fg, muted) ≥ 4.5, (primary-fg, primary) ≥ 4.5,
    (tab-on-fg, tab-on-bg) ≥ 4.5, (link, card) ≥ 4.5, (code-inline-fg, code-inline-bg) ≥ 4.5, (border, card) ≥ 1.5.
    A small WCAG relative-luminance helper lives in the test file; the parser resolves hex and `rgb()` only (Darcula has
    no oklch).
- [ ] **Step 2: Run** `npx vitest run web/src/shell/ToolStrip.test.tsx web/src/theme.test.ts` — FAIL.
- [ ] **Step 3: Fill the `darcula` block** with the values above. Where the AA test fails (muted-fg on muted is about 4:1),
  raise that value's lightness only, keeping its hue, until it passes; note the final value in a comment.
- [ ] **Step 4: States:** active tab → `bg-tab-on-bg text-tab-on-fg` plus a 2px `--tab-line` underline (inset box-shadow,
  so the height does not change); ToolButton pressed → `--tool-on` when `focused`, else `--tool-on-idle`, icon
  `--tool-on-fg`, with `data-focused`; panels: Files `#tree-sheet`, Changes `#changes-sheet`, Comments `#comments`, the
  log the active tab's pane. Header triggers colour their icon with their `--accent-*` token. Inputs: border
  `--focus-border` and a 2px `--focus-ring` on `:focus-visible`; inside popovers `bg-transparent`.
- [ ] **Step 5: Run** the two test files and `npm test` — PASS.
- [ ] **Step 6: Look:** rebuild, test window on 4790, Darcula; screenshot the same views as Task 3 and check them
  against the spec's description (card visibly apart from the background, millimetre lines faint, blue only on primary
  and focus).
- [ ] **Step 7: Commit** `gh-70: Darcula: the IntelliJ palette, millimetre paper, tab and tool-button states`.

### Task 5: Choosing the theme; header and file-bar icons; keys in tooltips

**Files:**
- Modify: `web/src/shell/Header.tsx` (Theme row above the scale row), `web/src/settings/SettingsView.tsx` (a `Themes`
  section after `setDefaults`), `web/src/controls/SessionPicker.tsx:147-157`, `web/src/shell/RestartMenu.tsx:49-51`,
  `web/src/files/FileView.tsx:163`, `web/src/shell/ToolStrip.tsx` (Files and Comments labels),
  `web/src/shell/keymap.ts` (helper), `web/src/tabs/TabStrip.tsx` (`ICONS`: `history`, `restart`, `external`, `palette`),
  all six `web/src/i18n/*.ts`, `AGENTS.md`
- Test: `web/src/shell/Header.test.tsx`, `web/src/settings/SettingsView.test.tsx`, `web/src/controls/SessionPicker.test.tsx`,
  `web/src/shell/RestartMenu.test.tsx`, `web/src/shell/keymap.test.tsx`

**Interfaces:**
- Consumes: `theme`, `useTheme` (Task 2); `THEMES` (Task 1).
- Produces: `withKey(label: string, id: Binding['id']): string` in `keymap.ts` → `` `${label} (${keysLabel(b)})` ``.
  `THEME_NAMES: Record<ThemeId, string>` = `{ darcula: 'Darcula', plannotator: 'Plannotator' }` in `theme.ts`.
  New i18n keys: `theme` (row label and section title), `themeTip`, `openRawTip` (tooltip for the icon; reuse `openRaw`
  for `aria-label`).

- [ ] **Step 1: Write the failing tests:**
  - `Header.test.tsx` `the Theme row lists the themes and picks one`: open `#settingsBtn`, hover `#themeMenu` → items
    `Darcula`, `Plannotator`, the current one `font-semibold`; select Plannotator → `theme.get() === 'plannotator'`.
  - `SettingsView.test.tsx` `a Themes section after Defaults`: section headings in order include `…Defaults, Themes,
    About`; a `radiogroup` named `Themes` with two radios, `Darcula` checked; clicking `Plannotator` checks it and calls
    `theme.choose`. Each radio shows a swatch of three spans whose inline style reads the theme's background, card and
    primary (read from a `data-theme` wrapper, so the swatch shows that theme's tokens, not the current one).
  - `SessionPicker.test.tsx`: the button found by role and name `Sessions` has no visible text (`textContent === ''`
    apart from the icons) and `title` starting with the existing tooltip.
  - `RestartMenu.test.tsx`: the button found by name `Restart the agent` (the `restartAgent` string as `aria-label`);
    update line 49's lookup.
  - `keymap.test.tsx` `withKey names the key`: `withKey('Files', 'hk_files')` on mac → `'Files (⌘⇧F)'`.
  - `ToolStrip.test.tsx`: `#toggleTree` tooltip text `Files (⌘⇧F)`, `#toggleComments` `Comments (⌘⇧C)`.
- [ ] **Step 2: Run** those five test files — FAIL.
- [ ] **Step 3: Implement.** Theme row: `DropdownMenuSub` like the language row, `id="themeMenu"`, `ICONS.palette`, value
  = current name, items `data-theme-id`. Settings section: `Section title={t('theme')}`, a `role="radiogroup"` of buttons,
  dark themes first (all of them today), swatch inside a `<span data-theme={id}>` so its `var()`s resolve to that theme.
  Sessions: `ICONS.history` + the chevron, `aria-label={t('sessions')}`, existing `title`. Agent: `ICONS.restart`,
  `aria-label={t('restartAgent')}`, `title={t('restartTip')}`. Open raw: `ICONS.external` at 14px,
  `aria-label={t('openRaw')}`, `title={t('openRawTip')}`. Icons drawn in the 24×24 stroke style of `ICONS`. Translate the
  new keys in all six languages.
- [ ] **Step 4: Run** the five files, `npm test`, `npx tsc -b`, and check `rtk proxy grep -rn "t('restart')" web/src`
  — no use left in the header (remove the key only if nothing else uses it).
- [ ] **Step 5: AGENTS.md:** under Development constraints add one line: "A control with a shortcut names it in its
  tooltip (`withKey` in `web/src/shell/keymap.ts`), new controls included."
- [ ] **Step 6: Commit** `gh-70: theme in the gear menu and Settings; icon buttons; keys in tooltips`.

### Task 6: Diagrams follow the theme; e2e; docs

**Files:**
- Modify: `web/src/diagram/render.ts:17-30`, `web/src/feed/Markdown.tsx:105-120`, `web/src/diagram/DiagramView.tsx:20-30`
- Modify: `e2e/workspace.spec.ts` (new test next to the scale test), `docs/guide.md`, `CHANGELOG.md` (`## Unreleased`)
- Test: `web/src/feed/Markdown.test.tsx`, `e2e/workspace.spec.ts`

**Interfaces:**
- Consumes: `theme.kind()`, `theme.subscribe`, `useTheme` (Task 2); `--diagram-bg` (Task 3).

- [ ] **Step 1: Write the failing tests:**
  - `Markdown.test.tsx` `a theme switch re-renders mermaid`: render a message with a mermaid block; `mermaid.render`
    called once with `initialize` theme `'dark'`; `theme.choose('plannotator')` → no second render (same kind). A test
    double `THEME_KIND` entry of kind `light` (mock `@nota-bene/shared`'s `THEME_KIND` or call an exported
    `setKindForTest`) → `initialize` called with `'default'` and `render` called again for the same block.
  - e2e `themes: the gear menu and Settings pick one, a reload keeps it, nothing keeps the old colours @files`: start;
    `html[data-theme]` is `darcula`; `getComputedStyle(body).backgroundColor === 'rgb(43, 43, 43)'`; pick Plannotator in
    the gear menu → `data-theme` `plannotator` and the body colour is Plannotator's; for both themes sample
    `.nb-card`, a `pre code .hljs-keyword`, `.mermaid-out`, the composer field and `#sessBtn` svg — each differs between
    the two themes; reload → still Plannotator; `finally` picks Darcula back in Settings → Themes (the fixture's prefs
    are shared).
- [ ] **Step 2: Run** `npx vitest run web/src/feed/Markdown.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** `loadMermaid` initializes with `theme: kind === 'light' ? 'default' : 'dark'`; before each
  render, re-initialize when the kind changed since the last one. Markdown keeps each `.mermaid-out`'s source in a
  module `WeakMap<HTMLElement, string>` and, on a `theme.subscribe` notification, re-renders the blocks it owns whose
  kind changed. DiagramView adds `useTheme()` to its render effect's deps.
- [ ] **Step 4: Run** the unit file, `npm test`, `npm run build -w web`, then `npm run e2e -- workspace.spec.ts` — PASS
  (exit code 0).
- [ ] **Step 5: Docs.** `docs/guide.md`: the gear menu's Theme row; Settings → Themes; header icons with tooltips; the
  rule that tooltips name the key. `CHANGELOG.md` Unreleased: "Themes: Darcula, the new default, with IntelliJ's colours on
  millimetre paper, and Plannotator, the previous look; pick one in the gear menu or Settings → Themes. To get the old
  look back, choose Plannotator." and "Sessions, ↻ Agent and Open raw are icons now; their names and keys are in the
  tooltips."
- [ ] **Step 6: Commit** `gh-70: diagrams follow the theme; e2e and docs`.

### Task 7: The whole change, end to end

- [ ] **Step 1:** `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e` (sequential; exit code 0 each).
- [ ] **Step 2:** Manual smoke on 4790 with temp homes: switch themes in one window, reload a second window on the same
  server, confirm it shows the chosen theme; check a code block, a mermaid diagram, the shell tab, Settings, the
  sessions popover and a comment popup in both themes. Stop the test server afterwards.
- [ ] **Step 3:** Open the PR `gh-70: themes: Darcula by default and Plannotator`, body with `Closes #70`,
  the screenshots, and the generated-with line.
