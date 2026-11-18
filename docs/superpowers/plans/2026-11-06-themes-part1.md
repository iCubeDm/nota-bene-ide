# Themes, part 1: theme system, Darcula, Plannotator, icons — Implementation Plan

**Goal:** Every colour goes through theme tokens; two dark themes ship (Darcula, the new default, and Plannotator, today's look), chosen in the gear menu and in a Themes section of Settings. The header's Sessions and ↻ Agent and the file bar's "Open raw" become icons; every control with a shortcut names it in its tooltip.

**Approach:** A theme is a block of CSS variables on `:root[data-theme="<id>"]` in `web/src/theme.css`. The choice is a global preference handled exactly like `uiScale`: `prefs.json` on the server, `hello.theme`, a localStorage cache applied before React renders, a small store in `web/src/shell/theme.ts`. Code highlighting and mermaid read the tokens and the theme kind (dark or light).

**Spec:** `docs/superpowers/specs/2026-11-06-themes-design.md` (section 1 and "Decided by the builder"). Light themes and the markup palette are part 2.

## Constraints

- Theme ids in order: `darcula` (default), `plannotator`, `intellij-light`, `github-light`, `solarized-light`. This part ships the first two; the type holds all five only when part 2 adds them. Names are not translated.
- Unknown or missing id falls back to `darcula`. `hello.theme` is optional like `uiScale`: no protocol bump.
- Plannotator keeps today's values exactly, the 24px grid included.
- Layout, tabs, panels, controls, features and shortcuts do not change; shadcn/ui shapes stay.
- WCAG AA (4.5:1 body text, 3:1 controls and large text) in every theme; a failing value moves in lightness, never hue.
- All strings through `web/src/i18n`, translated in all six languages.
- Branch `gh-70-themes`, one squashed PR.

## Rulings made while planning

- **Cross-window sharing works like the scale:** another window picks the theme up on its next `hello`, not live. A live broadcast would be a new server event for one preference.
- **Favicon colours stay literal** (allow-listed): the tab is not themed and status colours must stay recognisable.
- **The 3D viewer background** reads `--card` at runtime; its `#202020` canvas fallback is allow-listed.
- **TextBody's inline "Open raw"** ("Too large · Open raw") keeps its text: a sentence, not a toolbar.

## Review focus

1. First paint after reload with Plannotator saved: no Darcula flash.
2. A stale `hello` after a local choice must not undo it (same race as the scale).
3. No part left in old colours after a switch: code blocks, diagrams, composer, popovers, focus ring, flashes.
4. The pressed tool button when nothing has focus shows the unfocused grey, not blue.
5. Header buttons stay findable by name: `aria-label`s keep the names.

## Design

**Server.** Shared exports in `shared/src/lang.ts`: `THEMES`, `ThemeId`, `isThemeId`, `DEFAULT_THEME = 'darcula'`, `THEME_KIND: Record<ThemeId, 'dark'|'light'>`. `Prefs.theme?`, `setThemePref`, `hello.theme?`; POST `/system/prefs` accepts `{ theme }` (400 `bad theme` on unknown). Files: `shared/src/protocol.ts`, `server/src/prefs.ts`, `system.ts`, `server.ts`.

**Browser store.** `web/src/shell/theme.ts`, a copy of `uiScale.ts`'s pattern: `theme = { get, kind, choose, adopt, subscribe, reload }`, `useTheme()`, localStorage key `nb.theme`. It always sets `documentElement.dataset.theme` (Darcula included) at module load and on every change; imported before `theme.css` and render. `adopt` ignores unknown ids; an older hello does not undo an unconfirmed local choice. `theme.adopt(ev.theme)` sits next to `uiScale.adopt` in `store.ts`. `THEME_NAMES` = `{ darcula: 'Darcula', plannotator: 'Plannotator' }`.

**Tokens.** `:root` keeps fonts and radii; `:root, :root[data-theme="darcula"]` and `:root[data-theme="plannotator"]` hold colours. With Plannotator the result is visibly unchanged: every literal moves into a token whose Plannotator value is the literal it replaces. Token names (later work relies on them):
- existing: `--background --foreground --card --popover --primary --primary-fg --muted --muted-fg --nb-accent --destructive --success --border --border-soft --code-bg --side --chrome`
- new: `--separator --link --pane-image --pane-size` (the `.grid-pane` texture), `--tab-on-bg --tab-on-fg --tab-line`, `--tool-on --tool-on-idle --tool-on-fg` (pressed tool button: panel focused, unfocused, icon), `--accent-sessions --accent-agent --accent-model --accent-usage`, `--code-inline-bg --code-inline-fg`, `--syn-keyword --syn-string --syn-function --syn-number --syn-comment --syn-type --syn-variable --syn-property`, `--focus-border --focus-ring`, `--flash`, `--diagram-bg`
- `--hue-1 … --hue-8`: per-item colours (file-type letters, git-graph lanes, mode pills), so a light theme can darken them all at once.
- Plannotator: `--tab-*`/`--tool-*` reproduce `bg-primary/15 text-primary` via `color-mix(in oklch, var(--primary) 15%, transparent)`; `--tool-on-idle` equals `--tool-on`; `--syn-*` are those of `github-dark.min.css`.
- `web/src/feed/hljs.css` maps highlight.js classes onto `--syn-*` (replaces the `github-dark` import in `Markdown.tsx`).

**Guard tests** (`web/src/theme.test.ts`): no colour literal (hex, `oklch(`, `rgb(`, `hsl(`, Tailwind palette classes) outside `theme.css`, `hljs.css`, `fonts.css`, with an explicit allow-list (the five markup colours, `text-white` on primary buttons, `Favicon.ts`, the `#202020` viewer fallback, `#000` behind fullscreen media); every theme defines exactly the same token set; Darcula passes AA for the key pairs (foreground/background, foreground/card, muted-fg/card and /muted, primary-fg/primary, tab-on-fg/tab-on-bg, link/card, code-inline pair; border/card at least 1.5).

**Darcula values.** background `#2b2b2b`; foreground `#c9ced6`; card `#323435`; side `#2f3031`; chrome `rgb(47 48 49 / .6)`; popover `#3c3f41`; separator `#505050`; muted `#3a3c3e`; muted-fg `#8f959c`; border `#45484b`; border-soft `rgb(255 255 255 / .07)`; primary `#4a78c2` / primary-fg `#ffffff`; link `#589df6`; tab-line `#4a88c7`; nb-accent `#ffc66d`; success `#66bf31`; destructive `#e06c64`; code-inline `#2e2e2e` / `#4f86cd`; focus-border `#466d94`, focus-ring `#3d6185` (2px); tab-on `#45484b` / `#ffffff`; tool-on `#4a78c2`, tool-on-idle `#4b4e51`, tool-on-fg `#ffffff`; accents: sessions `#589df6`, agent `#66bf31`, model `#ae8abe`, usage `#ffc66d` (gear stays neutral). Syntax: keyword `#cc7832`, string `#66bf31`, function and type `#ffc66d`, number `#6897bb`, comment `#808080`, variable `#f99e71`, property `#9876aa`. Texture: millimetre paper, white hairlines every 1mm at .018, 5mm at .035, 10mm at .06 opacity; `--pane-size: 10mm 10mm`. Where AA fails (muted-fg on muted was about 4:1), raise lightness only and note the value in a comment.

**States.** Active tab: `bg-tab-on-bg text-tab-on-fg` plus a 2px `--tab-line` inset-shadow underline (height unchanged). Pressed ToolButton: `--tool-on` when its panel has focus, else `--tool-on-idle`, via `useFocusWithin` (`web/src/shell/focusWithin.ts`) and `data-focused`; panels are Files `#tree-sheet`, Changes `#changes-sheet`, Comments `#comments`, the log the active tab's pane. Header triggers colour their icon with `--accent-*`. Inputs: `--focus-border` plus 2px `--focus-ring` on `:focus-visible`; `bg-transparent` inside popovers.

**Choosing and icons.** Gear menu gets a Theme row (`DropdownMenuSub`, `id="themeMenu"`, palette icon) above the scale row. Settings gets a `Themes` section after Defaults: a `radiogroup` of buttons, each with a three-span swatch (background, card, primary) inside a `<span data-theme={id}>` so the swatch shows that theme's tokens. Sessions: history icon plus chevron, `aria-label={t('sessions')}`. Agent: restart icon, `aria-label={t('restartAgent')}`, `title={t('restartTip')}`. Open raw: external icon at 14px, `aria-label={t('openRaw')}`, `title={t('openRawTip')}`. New icons in the 24x24 stroke style of `ICONS`. New keys: `theme`, `themeTip`, `openRawTip`. `withKey(label, id)` in `keymap.ts` returns `` `${label} (${keysLabel(b)})` ``; Files and Comments tool buttons use it. One line added to `AGENTS.md` stating the tooltip-key rule.

**Diagrams.** `loadMermaid` initializes with `theme: kind === 'light' ? 'default' : 'dark'` and re-initializes when the kind changed. `Markdown.tsx` keeps each `.mermaid-out`'s source in a module `WeakMap` and re-renders owned blocks whose kind changed on `theme.subscribe`; no re-render for a switch within the same kind. `DiagramView` adds `useTheme()` to its effect deps.

## Tests

Server: prefs keep a known theme and drop an unknown one; POST refuses unknown ids and a second server's hello carries the choice. Store: default, choose saves and posts, cached theme applied at import, unknown ids fall back, stale hello. UI: Theme row, Themes radiogroup, icon buttons found by role and name, `withKey` on mac gives `Files (⌘⇧F)`, pressed button grey until its panel has focus, mermaid re-render only on kind change. E2E (`e2e/workspace.spec.ts`): default Darcula body `rgb(43, 43, 43)`; pick Plannotator in the gear menu; five sampled elements (`.nb-card`, hljs keyword, `.mermaid-out`, composer field, `#sessBtn` svg) differ between themes; reload keeps it; the test restores Darcula (fixture prefs are shared).

## Docs and finish

`docs/guide.md` (Theme row, Settings Themes, icons with tooltips, tooltip-key rule) and `CHANGELOG.md` Unreleased (Darcula new default, Plannotator is the old look; Sessions, ↻ Agent and Open raw are icons). Final checks: `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e` sequentially; manual smoke on 4790 with temp homes; PR `gh-70: themes: Darcula by default and Plannotator`, `Closes #70`.
