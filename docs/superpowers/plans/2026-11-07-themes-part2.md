# Themes part 2: light themes — Implementation Plan

**Goal:** Ship IntelliJ Light, GitHub Light and Solarized Light on the token set part 1 built, each passing WCAG AA, plus the part-1 leftovers.

**Approach:** A theme is one block of token values in `web/src/theme.css`; its id joins `THEMES` and `THEME_KIND` in `shared/src/lang.ts` and the name map in `web/src/shell/theme.ts`; the gear menu, Settings → Themes, prefs, hello, mermaid and hljs already follow. `web/src/theme.test.ts` moves from "Darcula and Plannotator" to "every theme in `THEMES`", so each new block is pinned by the same token-set and AA checks as soon as its id is added.

**Spec:** `docs/superpowers/specs/2026-11-06-themes-design.md` (section 2 and "Decided by the builder"). Branch `gh-74-themes` (issue #74), which already holds the Darcula tuning of #72 (panels `#3c3f41`, paper `--pane-bg`, card `#313131`, footer meters `--meter-*`). One PR closes #72 and #74.

## Constraints

- Ids and names: `intellij-light` "IntelliJ Light", `github-light` "GitHub Light", `solarized-light` "Solarized Light". Order in `THEMES`: `darcula`, `plannotator`, then the three light ones. Names are not translated.
- Every light block sets `color-scheme: light`; dark blocks get none (Plannotator must not change).
- WCAG AA in every theme (4.5:1 text, 3:1 control outline). A failing value moves in OKLCH lightness only, never hue; the published value stays in a comment (`/* #268bd2: 3.41 on card */`). For Solarized, "the closest tone that passes" means the same hue at the nearest passing lightness, not another palette entry.
- Texture: Darcula's millimetre paper with black hairlines at the same composited opacities (1 mm .018, 5 mm .035, 10 mm .06): `--pane-image` keeps Darcula's alphas with `rgb(0 0 0 / …)`.
- Surfaces step like Darcula's: paper (`--pane-bg`) a step below the card, side panels and chrome their own colour; in a light theme the card is the brightest surface.
- The five markup colours stay literal and identical in every theme. Plannotator and Darcula render exactly as before.

## Review focus

1. A light theme on a dark OS: Tailwind `dark:` variants and Plannotator's `prefers-color-scheme: dark` rule must not reach a light theme (CSS check; e2e with `colorScheme: 'dark'`).
2. The inline script in `web/index.html` lists ids by hand; a missing light id flashes Darcula on reload (test: list equals `THEMES`).
3. Dark to light with a diagram and code open: mermaid re-initializes for the new kind and redraws (unit, real `THEME_KIND`).
4. Settings → Themes swatches on a dark page show each light theme's own colours (e2e reads a swatch's computed colour).
5. Pressed tool button with an unfocused panel: a light grey fill with a white icon fails AA, hence `--tool-on-idle-fg` with its AA pair.

## Plumbing (task 1)

- Add each id to `THEMES`, `THEME_KIND`, `THEME_NAMES` and the single array literal in the `index.html` inline script.
- New token `--tool-on-idle-fg` in every block and `@theme` (Darcula and Plannotator: `var(--tool-on-fg)`, unchanged); `ToolStrip.tsx` uses `text-tool-on-idle-fg` when pressed and unfocused.
- After `@import 'tailwindcss'`, a `@custom-variant dark` that applies `@media (prefers-color-scheme: dark)` only inside `:root:not([data-theme$="-light"])`. Plannotator's existing media rule names Plannotator and needs no change.
- Tests: token-set equality and AA run over every theme in `THEMES` (`themeSelector(id)` helper returns the block selector; `AA_PAIRS` is Darcula's list plus `--tool-on-idle-fg`/`--tool-on-idle` and `--meter-fg`/`--chrome`; plus border and `--meter-line >= 3`); light blocks contain `color-scheme: light`, dark ones none; the `dark` variant excludes `-light`; the inline script's ids equal `THEMES`. Server: `setThemePref('intellij-light')` round-trips through `prefs.json`.
- The rest of each block follows Darcula's pattern: fills as `var(--destructive)`, `--input-*` from `--focus-*`, `--hue-*` from the accents, diff add/del light green/red; `--shade`, `--scrim` `#000`, `--on-scrim` `#fff`.

## Palettes

**IntelliJ Light** (from the IntelliJ Light theme and editor scheme): card, popover, background, page-bg, svg-bg `#ffffff`; pane-bg, code-bg, syn-bg, diagram-bg `#f7f8fa`; side `#f2f2f2`; chrome `rgb(242 242 242 / .9)`; foreground `#080808`; muted-fg `#6c707e`; muted, separator `#ebecf0`; border `#c9ccd6`; border-soft `rgb(0 0 0 / .08)`; primary, tool-on, tab-line `#3574f0`; tool-on-idle `#dfe1e5` with fg `#080808`; tab-on `#ffffff`/`#080808`; link `#2470b3`; success `#067d17`; nb-accent `#e0a800`; destructive `#c7222d`; inline code `#ebecf0`/`#0033b3`; syntax text `#080808`, keyword `#0033b3`, string `#067d17`, function `#00627a`, number `#1750eb`, comment `#8c8c8c`, type `#000000`, variable `#080808`, property `#871094`; accents sessions `#3574f0`, agent `#067d17`, model `#871094`, usage `#9e880d`; meter-fg `#6c707e`, track `transparent`, line `#a8adbd`. White-on-`#3574f0` and `#8c8c8c` are expected to need a lightness shift.

**GitHub Light** (Primer light primitives, prettylights syntax): card, popover, background, page-bg `#ffffff`; pane-bg `#f3f5f7`; side `#f6f8fa`; chrome `rgb(246 248 250 / .9)`; foreground `#1f2328`; muted-fg `#59636e`; muted `#eff2f5`; border `#d1d9e0`; border-soft `rgb(31 35 40 / .08)`; primary (GitHub's button) `#1f883d` with white text (4.52 alone: re-check after compositing); tool-on `#0969da`; tool-on-idle `#e6eaef` with fg `#1f2328`; tab-line (Primer underline nav) `#fd8c73`; tab-on `#ffffff`/`#1f2328`; link `#0969da`; success `#1a7f37`; nb-accent `#d4a72c`; destructive `#d1242f`; code-bg, syn-bg, diagram-bg `#f6f8fa`; inline code `#eff2f5`/`#1f2328`; syntax keyword `#cf222e`, string `#0a3069`, function `#6639ba`, number `#0550ae`, comment `#59636e`, type and variable `#953800`, property `#0550ae`, tag `#116329`; diff add `#116329` on `#dafbe1`, del `#82071e` on `#ffebe9`; accents sessions `#0969da`, agent `#1a7f37`, model `#8250df`, usage `#9a6700`; meter-fg `#59636e`, line `#8c959f`; `--hue-*` from Primer's scale.

**Solarized Light** (Schoonover: base3 `#fdf6e3`, base2 `#eee8d5`, base1 `#93a1a1`, base00 `#657b83`, base01 `#586e75`; yellow `#b58900`, orange `#cb4b16`, red `#dc322f`, magenta `#d33682`, violet `#6c71c4`, blue `#268bd2`, cyan `#2aa198`, green `#859900`): card, popover, background, code-bg, syn-bg, diagram-bg, svg-bg base3; page-bg `#ffffff`; pane-bg `#f5eedb`; side, muted, inline-code bg base2; chrome `rgb(238 232 213 / .9)`; foreground base01; muted-fg base00; border base1; border-soft `rgb(7 54 66 / .1)`; primary, tool-on, tab-line, link blue; tool-on-idle `#e4ddc8` with fg base01; success green; nb-accent yellow; destructive red; inline-code fg magenta; syntax (Solarized's own): text base01, keyword green, string cyan, function blue, number magenta, comment base1, type yellow, variable blue, property violet; accents sessions blue, agent green, model violet, usage orange; meter-fg base00, line base1. Nearly every accent fails AA on base3 (blue 3.41, cyan 2.93, green 2.97, yellow 2.98) and base00 fails as muted text (4.13): each is lightened or darkened in lightness only, with the published value in a comment; white on blue as primary also fails, so `--primary`/`--tool-on` are darkened the same way.

## Leftovers, tests, docs (task 4)

- `markdown.css` read an undefined `var(--muted-foreground)` for line numbers and the copy button, so they inherited the text colour. Replaced by new token `--md-aux`: Plannotator `currentColor` (unchanged), every other theme `var(--muted-fg)`.
- Redraw test uses the real `THEME_KIND`: mermaid block under `darcula`, adopt `github-light` gives `theme: 'default'` and a redraw; back gives `'dark'`.
- E2E: after Plannotator pick `solarized-light` in Settings → Themes; assert `colorScheme === 'light'`, card, keyword, diagram, composer and sessions colours differ from Darcula, and the Solarized swatch reads `rgb(253, 246, 227)` while the page is Darcula. New test: a light theme on an emulated dark OS (`intellij-light`) keeps light colours (an outline button's hover is not the dark variant's `bg-input/50`; destructive fill solid). Both reset to Darcula in `finally`.
- Docs: guide names five themes (Darcula default and Plannotator dark; the three light ones), plus the Settings line; CHANGELOG line for the light themes and the Darcula tuning (lighter panels, readable footer meters).
- Final: `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e` sequentially.
