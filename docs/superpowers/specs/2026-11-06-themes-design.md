# Themes and a new default look

Nota Bene has one dark theme with a Plannotator palette and grid. Testers want a choice; the author wants the window to feel like their IDE (IntelliJ Darcula) without becoming one. A theme is colour, background texture and a few states; layout, tabs, panels, controls and features stay.

Goals: five themes (two dark, three light); new default dark theme Darcula; the current look kept as Plannotator; every colour through theme tokens; an always-at-hand markup palette.

Non-goals: layout changes; theme editor or user themes; following the OS light/dark setting (later if asked); importing IDE scheme files.

Anti-goals: an IDE look (solid grey slabs, square corners, status bar: shadcn/ui shapes stay); a feature, tab, button or shortcut lost or moved by a theme; a theme where some part keeps old colours.

Three changes in order, each with its own issue and PR: (1) theme system, Darcula, Plannotator, header icons, "Open raw" icon; (2) three light themes; (3) markup palette and keys.

## 1. Theme system

**Tokens.** Every colour goes through a CSS variable in `web/src/theme.css`. About 139 colour literals in 16 files sit outside tokens today (components, composer field, code highlighting, diagram canvas, focus ring, flashes); each becomes a token or a mix. New tokens beyond shadcn's: pane background and texture (`.grid-pane`); active tab (background, text, underline); pressed tool-window button (focused and unfocused panel); header function accents (sessions, agent restart, model, usage); inline code and syntax colours (keyword, string, function, number, comment, type, variable, property); input focus ring; popover and separator.

A theme is a block of values on `:root[data-theme="<id>"]` and sets `color-scheme` to its kind so scrollbars and native controls follow the theme, not the OS. Mermaid and the SVG canvas take a light/dark base from the kind.

**Choosing.** A Theme row in the gear menu above the scale (submenu of five names) and a Settings section "Themes" after Defaults (dark first; name plus swatch of background, card, primary; current marked). One global preference like language and scale: `prefs.json` (`theme`), sent in `hello`, cached in localStorage and applied before React renders (no flash on reload), shared by every window. Unknown/missing id falls back to Darcula; optional in `hello` like `uiScale`, so no protocol bump. A switch re-renders open diagrams in every window. Ids: `darcula` (default), `plannotator`, `intellij-light`, `github-light`, `solarized-light`. Names are not translated; row label and tooltips are, in all six languages.

**Plannotator.** Today's values unchanged, with the 24px grid. Everyone, upgraders included, gets Darcula until they pick Plannotator; the changelog says how to restore the old look; no in-app notice.

**Contrast.** Every theme passes WCAG AA for body text and controls. Where a value below fails, move its lightness, never its hue.

**Darcula** (author's scheme, today's shadcn shapes):

| Token | Value |
|---|---|
| background / foreground | `#2b2b2b` / `#c9ced6` |
| card | `#313131` (a step above paper `#2a2b2c`); code blocks stay `#2b2b2b` |
| side panels; header and strips | `#3c3f41`; `rgb(60 63 65 / .9)` |
| popover; separators | `#3c3f41`; `#505050` |
| muted / muted text | `#3a3c3e` / `#8f959c` |
| border / soft border | `#45484b` / `rgb(255 255 255 / .07)` |
| primary | `#4a78c2`, white text |
| link blue; active-tab underline | `#589df6`; `#4a88c7` |
| warning, comment marks; success; destructive | `#ffc66d`; `#66bf31`; `#e06c64` |
| inline code | `#2e2e2e` bg, `#4f86cd` text |
| input focus | border `#466d94`, 2px ring `#3d6185`; inputs in popovers have no own fill |

Syntax: keyword `#cc7832`, string `#66bf31`, function/class `#ffc66d`, number `#6897bb`, comment `#808080`, local variable `#f99e71`, property/parameter `#9876aa`.

Texture: millimetre paper in real CSS mm, white hairlines at 1 mm (.018), 5 mm (.035), 10 mm (.06) opacity under the centred card. Active tab: `#45484b`, white text, blue underline. Pressed tool-window button: `#4a78c2` white icon when its panel has focus, `#4b4e51` white icon otherwise. Header accents: sessions `#589df6`, agent restart `#66bf31`, model `#ae8abe`, usage `#ffc66d`, gear neutral.

**Header and file bar.** Sessions and ↻ Agent become icons (history clock with existing chevron; restart arrow); "Open raw" becomes an open-externally icon. Text stays where it is a value or needs explaining (model, mode, Send, panel titles). Names move to tooltips and `aria-label`.

**Tooltips name the key.** Every control with a shortcut shows it in its tooltip (e.g. "Files (⌘⇧F)"); a rule for new controls too, added to `AGENTS.md`.

## 2. Light themes

IntelliJ Light, GitHub Light (Primer), Solarized Light, each from its published palette mapped onto the same tokens. Texture is the millimetre paper with dark hairlines at equivalent contrast. Solarized must still pass AA; where its values do not, use the closest Solarized tone that does.

## 3. Markup palette

The palette (tools, colours, undo, Comment, close) moves from the floating bar into the file bar next to the path. Always present for an image; for a video it appears when paused and goes away on play (an uncommented drawing is kept). The "Mark up" button is gone.

Default tool is a pointer that draws nothing (click toggles natural size, selection works as now); drawing starts once a tool is picked. Keys are side by side, active while the image/player has focus, never in a text field:

| Key | Tool |
|---|---|
| Q / W / E / R / T | pointer / rectangle / ellipse / pen / arrow |
| 1–5 | colour: red, yellow, green, blue, white |
| Cmd/Ctrl+Z | undo |
| Enter | comment |
| Esc | back to pointer; asks first when a drawing has no comment |

These replace R/E/P/A (the author asked for side-by-side keys; an alias would give R two meanings); changelog and guide say so. Keys use the player scope (`inPlayerScope`). Enter and Esc are taken only while there is a drawing or a drawing tool is active, otherwise they fall through. The pressed tool shows the active one.

On an image 1–5 always pick colour and keep the tool. On a video 0–9 seek to 0–90 % while the pointer is active; 1–5 pick a colour while a drawing tool is. Play with an uncommented drawing asks first (the dialog Esc uses); once it plays, the palette hides and the tool returns to the pointer. Narrow window: the path truncates from the left; the palette never wraps. HTML pages keep their Mark (N) mode (an always-on outline would hinder reading).

## Decided by the builder

Token names and the mapping of the 139 literals; icons (match `TabStrip.tsx`); how panel focus is tracked; light palette values from official sources. Tests: theme switch across windows like scale; a check that no colour literal is left outside `theme.css` (allow-list: the five markup colours, which the agent sees the same in every theme; white text on primary; fixtures); e2e for palette and keys. Docs: `docs/guide.md` (Settings/Themes, gear menu, markup keys, hotkey table) and changelog.
