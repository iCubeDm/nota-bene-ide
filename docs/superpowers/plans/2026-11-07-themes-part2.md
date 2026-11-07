# Themes part 2: light themes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship IntelliJ Light, GitHub Light and Solarized Light on the token set part 1 built, each passing WCAG AA, plus the part-1 leftovers.

**Architecture:** A theme is one block of token values in `web/src/theme.css`; its id joins `THEMES` and `THEME_KIND` in `shared/src/lang.ts` and the name map in `web/src/shell/theme.ts`, and everything else (gear menu, Settings → Themes, prefs, hello, mermaid, hljs) already follows. The tests in `web/src/theme.test.ts` move from "Darcula and Plannotator" to "every theme in `THEMES`", so each new block is pinned by the same token-set and AA checks the moment its id is added.

**Tech Stack:** CSS custom properties, Tailwind v4 (`@theme`, `@custom-variant`), React, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-themes-design.md` (section 2 and "Decided by the builder").

Branch `gh-74-themes` (issue #74), which already holds the Darcula tuning of #72 (panels `#3c3f41`, paper `--pane-bg`, card `#313131`, footer meters `--meter-*`). One PR to `main` at the end closes #72 and #74.

## Global Constraints

- Ids and names, verbatim: `intellij-light` "IntelliJ Light", `github-light` "GitHub Light", `solarized-light` "Solarized Light". Order in `THEMES`: `darcula`, `plannotator`, then the three light ones (dark ones first).
- Names are not translated; no new UI strings are expected. If one appears, it goes through `web/src/i18n` with a real translation in all six languages.
- Every light block sets `color-scheme: light`. Dark blocks do not get a `color-scheme` (part 1 did not set one; Plannotator must not change).
- Every theme passes WCAG AA for body text and controls (4.5:1 text, 3:1 for a control's outline). A value that fails moves in OKLCH lightness only, never hue; the published value stays in a comment beside it, in the Darcula block's form (`/* #268bd2: 3.41 on card */`).
- Solarized: "the closest Solarized tone that does is used" means the same Solarized hue at the nearest lightness that passes (the rule above), not a different palette entry.
- The texture is the millimetre paper of Darcula with black hairlines at the same composited opacities (1 mm .018, 5 mm .035, 10 mm .06), so `--pane-image` keeps Darcula's layer alphas with `rgb(0 0 0 / …)`.
- Surfaces step like Darcula's after #72: paper (`--pane-bg`) a step below the card, side panels and chrome their own panel colour. In a light theme the card is the brightest surface.
- The five markup colours stay literal and the same in every theme (spec allow-list).
- Plannotator and Darcula render exactly as they do on `gh-74-themes` now. The e2e theme test and `theme.test.ts` hold that.
- Public repo: neutral fixtures, nothing personal in tracked files.

## Review Focus

1. A light theme on a dark OS: Tailwind's `dark:` variants (4 in `button.tsx`-style classes) and Plannotator's `prefers-color-scheme: dark` rule must not reach a light theme. Expect light hovers and rings. Pinned in Task 1 (CSS check) and Task 4 (e2e with `colorScheme: 'dark'`).
2. A cached light id before JS: the inline script in `web/index.html` lists the ids by hand; a light id missing there flashes Darcula on every reload. Pinned in Task 1 (the list equals `THEMES`).
3. Switching dark → light with a diagram and code open: mermaid re-initialises for the new kind and redraws; hljs follows tokens. Pinned in Task 4 (unit, real `THEME_KIND`).
4. The swatches in Settings → Themes on a dark page show each light theme's own colours (the span's `data-theme` re-scopes). Pinned in Task 4 (e2e reads a swatch's computed colour).
5. The pressed tool-window button when its panel has no focus: a light grey fill with a white icon fails AA. Pinned in Task 1 (`--tool-on-idle-fg` and its AA pair).

---

### Task 1: Plumbing and IntelliJ Light

**Files:**
- Modify: `shared/src/lang.ts:14-19`, `web/src/shell/theme.ts:8`, `web/index.html:12`
- Modify: `web/src/theme.css` (new block, `@custom-variant dark`, `--tool-on-idle-fg` in every block and `@theme`)
- Modify: `web/src/shell/ToolStrip.tsx:30`
- Test: `web/src/theme.test.ts`, `web/src/shell/theme.test.ts`, `server` prefs test that covers `setThemePref`

**Interfaces:**
- Produces: `THEMES` with `'intellij-light'`, `THEME_KIND['intellij-light'] = 'light'`, `THEME_NAMES['intellij-light'] = 'IntelliJ Light'`; token `--tool-on-idle-fg` (Tailwind `text-tool-on-idle-fg`); helper `themeSelector(id: ThemeId): string` in `theme.test.ts` returning the block's selector as written (`':root, [data-theme="darcula"]'` for darcula, `[data-theme="<id>"]` otherwise); `AA_PAIRS` (the current Darcula list plus `['--tool-on-idle-fg', '--tool-on-idle']`, `['--meter-fg', '--chrome']`) used by later tasks.

- [ ] **Step 1: Generalise the tests.** In `theme.test.ts`: `every theme defines every token` loops over `THEMES` (imported from `@nota-bene/shared`) and compares each block's token set to Plannotator's; `Darcula passes AA` becomes `it.each(THEMES.filter((id) => id !== 'plannotator'))('%s passes AA', …)` over `AA_PAIRS` plus the existing border and `--meter-line ≥ 3` checks. Add `it('a light theme says so to the browser')`: every light block contains `color-scheme: light`, no dark block contains `color-scheme`. Add `it('dark: variants only apply to dark themes')`: `theme.css` contains `@custom-variant dark` whose selector excludes `[data-theme$="-light"]`. Add `it('the inline script knows every theme')`: the id list in `web/index.html`'s inline script equals `THEMES`.
- [ ] **Step 2: Run** `npx vitest run web/src/theme.test.ts` — FAIL (no `intellij-light`, no variant, no `--tool-on-idle-fg`).
- [ ] **Step 3: Plumbing.** Add the id to `THEMES`/`THEME_KIND`/`THEME_NAMES`; the inline script tests against the full id list (one array literal, so the test can read it). Add `--tool-on-idle-fg` (Darcula and Plannotator: `var(--tool-on-fg)`, so they do not change); ToolStrip uses `text-tool-on-idle-fg` when pressed and unfocused. Add, after `@import 'tailwindcss'`:

```css
/* shadcn's dark: classes follow the OS, as Tailwind's default does, but never inside a light theme */
@custom-variant dark {
  @media (prefers-color-scheme: dark) {
    &:where(:root:not([data-theme$="-light"]), :root:not([data-theme$="-light"]) *) { @slot; }
  }
}
```

Plannotator's existing `@media (prefers-color-scheme: dark)` rule needs no change (it names Plannotator).
- [ ] **Step 4: The IntelliJ Light block** `[data-theme="intellij-light"]`, from JetBrains' IntelliJ Light (intellij-community `IntelliJ Light` theme and editor scheme). Anchors:

| Token | Value |
|---|---|
| card, popover, page-bg | `#ffffff` |
| pane-bg | `#f7f8fa` |
| side; chrome | `#f2f2f2`; `rgb(242 242 242 / .9)` |
| background (inputs, dialogs) | `#ffffff` |
| foreground; muted-fg | `#080808`; `#6c707e` |
| muted; separator; border; border-soft | `#ebecf0`; `#ebecf0`; `#c9ccd6`; `rgb(0 0 0 / .08)` |
| primary, tool-on; tab-line | `#3574f0`; `#3574f0` |
| tool-on-idle; tool-on-idle-fg | `#dfe1e5`; `#080808` |
| tab-on-bg; tab-on-fg | `#ffffff`; `#080808` |
| link | `#2470b3` |
| success; nb-accent; destructive | `#067d17`; `#e0a800`; `#c7222d` |
| code-bg, syn-bg, diagram-bg | `#f7f8fa` |
| code-inline bg; fg | `#ebecf0`; `#0033b3` |
| syntax: text, keyword, string, function, number, comment, type, variable, property | `#080808`, `#0033b3`, `#067d17`, `#00627a`, `#1750eb`, `#8c8c8c`, `#000000`, `#080808`, `#871094` |
| accents: sessions, agent, model, usage | `#3574f0`, `#067d17`, `#871094`, `#9e880d` |
| meter-fg; meter-track; meter-line | `#6c707e`; `transparent`; `#a8adbd` |

The rest follows the Darcula block's pattern (fills as `var(--destructive)`, `--input-*` from `--focus-*`, `--hue-*` from the accents above, diff add/del in light greens/reds); `--shade`, `--scrim` `#000`, `--on-scrim` `#fff`, `--svg-bg` `#ffffff`. Values the AA test rejects move in lightness only (`#3574f0` as white-on text and `#8c8c8c` will).
- [ ] **Step 5: Run** `npx vitest run web/src/theme.test.ts web/src/shell server/src` — PASS. Server: add a case that `setThemePref('intellij-light')` round-trips through `prefs.json`.
- [ ] **Step 6: Commit** `gh-74: IntelliJ Light; light themes keep dark: classes and say color-scheme`.

### Task 2: GitHub Light

**Files:** Modify `shared/src/lang.ts`, `web/src/shell/theme.ts`, `web/index.html`, `web/src/theme.css`.
**Interfaces:** Consumes `themeSelector`, `AA_PAIRS` (Task 1). Produces id `github-light`.

- [ ] **Step 1:** Add `github-light` to `THEMES`/`THEME_KIND`/`THEME_NAMES`/the inline list. Run `npx vitest run web/src/theme.test.ts` — FAIL (no block).
- [ ] **Step 2: The block**, from Primer's light primitives (`@primer/primitives` light) and GitHub's light syntax (prettylights):

| Token | Value |
|---|---|
| card, popover, background, page-bg | `#ffffff` |
| pane-bg | `#f3f5f7` |
| side; chrome | `#f6f8fa`; `rgb(246 248 250 / .9)` |
| foreground; muted-fg | `#1f2328`; `#59636e` |
| muted; border; border-soft | `#eff2f5`; `#d1d9e0`; `rgb(31 35 40 / .08)` |
| primary (GitHub's own button) | `#1f883d`, white text |
| tool-on; tool-on-idle; tool-on-idle-fg | `#0969da`; `#e6eaef`; `#1f2328` |
| tab-line (Primer's underline nav) | `#fd8c73` |
| tab-on-bg; tab-on-fg | `#ffffff`; `#1f2328` |
| link | `#0969da` |
| success; nb-accent; destructive | `#1a7f37`; `#d4a72c`; `#d1242f` |
| code-bg, syn-bg, diagram-bg; inline code bg/fg | `#f6f8fa`; `#eff2f5` / `#1f2328` |
| syntax: keyword, string, function, number, comment, type, variable, property, tag | `#cf222e`, `#0a3069`, `#6639ba`, `#0550ae`, `#59636e`, `#953800`, `#953800`, `#0550ae`, `#116329` |
| diff add fg/bg; del fg/bg | `#116329`/`#dafbe1`; `#82071e`/`#ffebe9` |
| accents: sessions, agent, model, usage | `#0969da`, `#1a7f37`, `#8250df`, `#9a6700` |
| meter-fg; meter-line | `#59636e`; `#8c959f` |

`#1f883d` with white text is 4.52 on its own; check it still passes after compositing; `--hue-*` from Primer's scale (blue, yellow, orange, red, purple, green, teal, gray).
- [ ] **Step 3: Run** the theme test — PASS. **Commit** `gh-74: GitHub Light`.

### Task 3: Solarized Light

**Files and interfaces:** as Task 2, id `solarized-light`.

- [ ] **Step 1:** Add the id everywhere; the theme test FAILs.
- [ ] **Step 2: The block**, from Ethan Schoonover's Solarized (base3 `#fdf6e3`, base2 `#eee8d5`, base1 `#93a1a1`, base00 `#657b83`, base01 `#586e75`, base02 `#073642`; yellow `#b58900`, orange `#cb4b16`, red `#dc322f`, magenta `#d33682`, violet `#6c71c4`, blue `#268bd2`, cyan `#2aa198`, green `#859900`):

| Token | Value |
|---|---|
| card, popover, background | base3 |
| pane-bg | `#f5eedb` (between base3 and base2) |
| side, muted; chrome | base2; `rgb(238 232 213 / .9)` |
| foreground; muted-fg | base01; base00 |
| border; border-soft | base1; `rgb(7 54 66 / .1)` |
| primary, tool-on, tab-line, link | blue |
| tool-on-idle; tool-on-idle-fg | `#e4ddc8`; base01 |
| success; nb-accent; destructive | green; yellow; red |
| code-bg, syn-bg, diagram-bg | base3; inline code bg base2, fg magenta |
| syntax (Solarized's own mapping): text, keyword, string, function, number, comment, type, variable, property | base01, green, cyan, blue, magenta, base1, yellow, blue, violet |
| accents: sessions, agent, model, usage | blue, green, violet, orange |
| meter-fg; meter-line | base00; base1 |
| page-bg; svg-bg | `#ffffff`; base3 |

Nearly every accent fails AA on base3 (blue 3.41, cyan 2.93, green 2.97, yellow 2.98) and base00 fails as muted text (4.13): each moves in lightness only, the published value in its comment. White on blue as primary fails; darken blue for `--primary`/`--tool-on` the same way.
- [ ] **Step 3: Run** the theme test — PASS. **Commit** `gh-74: Solarized Light`.

### Task 4: Leftovers, diagrams on a light kind, e2e and docs

**Files:**
- Modify: `web/src/feed/markdown.css:22-23`, `web/src/theme.css` (token `--md-aux` in every block)
- Test: `web/src/feed/Markdown.test.tsx` or `web/src/diagram/render.test.ts` (whichever holds the part-1 redraw test), `e2e/workspace.spec.ts`
- Modify: `docs/guide.md` (Themes, Settings), `CHANGELOG.md`

**Interfaces:** Consumes the five ids.

- [ ] **Step 1: `--muted-foreground`.** markdown.css reads an undefined `var(--muted-foreground)` for the line numbers and the copy button, so today they inherit the text colour. Replace it with a new token `--md-aux`: Plannotator `currentColor` (unchanged), every other theme `var(--muted-fg)`. The literal scan and the token-set test cover it.
- [ ] **Step 2: Redraw test on a real light kind.** Replace the part-1 test's mocked `THEME_KIND` with the real one: render a mermaid block under `darcula`, `theme.adopt('github-light')`, expect mermaid initialised with `theme: 'default'` and the block redrawn; back to `darcula`, `theme: 'dark'`. Run it — PASS.
- [ ] **Step 3: e2e.** In the themes test, after Plannotator, pick `solarized-light` in Settings → Themes and assert: `getComputedStyle(document.documentElement).colorScheme === 'light'`, the card, keyword, diagram, composer and sessions colours differ from Darcula's, and the Solarized swatch's `--card` span reads `rgb(253, 246, 227)` while the page is Darcula. Add `test('a light theme on a dark OS keeps light colours')`: `page.emulateMedia({ colorScheme: 'dark' })`, choose `intellij-light`, hover an outline button and expect its background not to equal the dark-variant colour (`bg-input/50` of the dark theme), and the destructive fill to be solid. Both reset to Darcula in `finally`.
- [ ] **Step 4: Docs.** guide: "Five colour themes ship: Darcula (default) and Plannotator, dark; IntelliJ Light, GitHub Light and Solarized Light, light." and the Settings line. CHANGELOG: one line under the unreleased themes entry naming the three light themes and the Darcula tuning (lighter panels, readable footer meters).
- [ ] **Step 5: Run** `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e` one after another; each exits 0. **Commit** `gh-74: light diagrams, line numbers, e2e and docs`.
