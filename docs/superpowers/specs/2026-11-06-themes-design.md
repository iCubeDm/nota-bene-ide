# Themes and a new default look

Nota Bene has one dark theme whose palette came from Plannotator, grid included. Testers want a choice, and the
author wants the window to feel like their IDE (IntelliJ IDEA, Darcula, Classic UI) without turning into an IDE.
A theme is colour, background texture and a few states; the layout, tabs, panels, controls and every feature
stay as they are.

Goals: five themes, two dark and three light; a new default dark theme, Darcula; the current look kept as a
theme named Plannotator; every colour through theme tokens; a markup palette that is always at hand.

Non-goals: layout changes; a theme editor or user-defined themes; following the OS light/dark setting (later, if
asked); importing IDE scheme files.

Anti-goals: an IDE look (solid grey tool-window slabs, square corners, a status bar): the shadcn/ui shapes stay.
A feature, tab, button or shortcut lost or moved by a theme. A theme in which some part keeps the old colours.

The work is three changes, in this order, each with its own issue and PR:

1. Theme system, Darcula, Plannotator, header icons and the "Open raw" icon.
2. The three light themes.
3. The always-visible markup palette and its keys.

## 1. Theme system

**Tokens.** Every colour goes through a CSS variable in `web/src/theme.css`. Today about 139 colour literals sit
in 16 files outside the tokens (oklch, hex and rgb in components, the composer field, code highlighting, the
diagram canvas, the focus ring, flashes). Each becomes a token or a mix of tokens. New tokens cover what themes
differ in beyond the shadcn set:

- the pane background and its texture (`.grid-pane`);
- the active tab (background, text, underline);
- a pressed tool-window button, in a focused panel and in an unfocused one;
- function accents in the header (sessions, agent restart, model, usage);
- inline code (background, text) and the syntax colours of code blocks (keyword, string, function, number,
  comment, type, variable, property);
- the focus ring of inputs;
- popover and separator colours.

A theme is a block of token values on `:root[data-theme="<id>"]`. Each theme also sets `color-scheme` to its kind (`light` or `dark`), so scrollbars and native controls follow the theme, not the OS.
Diagrams (mermaid) and the SVG canvas take a light or dark base from the theme's kind.

**Choosing.** A Theme row in the gear menu, above the scale, with a submenu of the five names, and a section of
its own in Settings, Themes, after Defaults: the five themes, dark ones first, each with its name and a small
swatch of its background, card and primary, the current one marked. Like the language and the scale it is one global preference: kept in the server's
`prefs.json` (`theme`), sent in `hello`, cached in localStorage so the first paint has the right colours, and
shared by every window. An unknown or missing id falls back to Darcula; the field is optional in `hello`, as `uiScale` is, so no protocol bump. The cached id is applied before React renders, so a reload never flashes another theme. A switch re-renders open diagrams in every window. Ids: `darcula` (default), `plannotator`, `intellij-light`, `github-light`,
`solarized-light`. Names are not translated; the row label and tooltips are, in all six languages.

**Plannotator.** Today's values, unchanged, with the 24px grid. Everyone, upgraders included, gets Darcula until they pick Plannotator; the changelog says how to get the old look back. No in-app notice.

**Contrast.** Every theme passes WCAG AA for body text and controls. The values below are the intent; where one fails (muted text on muted fill, say), the builder moves its lightness, never its hue.

**Darcula.** Neutrals and accents from the author's Darcula scheme, today's shadcn/ui shapes:

| Token | Value |
|---|---|
| background | `#2b2b2b` |
| foreground | `#c9ced6` |
| card | `#313131`, a step above the paper around it (`#2a2b2c`); code blocks stay on `#2b2b2b`, a step below |
| side panels | `#3c3f41`, Darcula's panel; header and strips `rgb(60 63 65 / .9)` |
| popover (menus, search) | `#3c3f41`, separators `#505050` |
| muted / muted text | `#3a3c3e` / `#8f959c` |
| border / soft border | `#45484b` / `rgb(255 255 255 / .07)` |
| primary (buttons, Send) | `#4a78c2`, white text |
| link and line blue | `#589df6`; active-tab underline `#4a88c7` |
| warning, comment marks | `#ffc66d` |
| success | `#66bf31` |
| destructive | `#e06c64` |
| inline code | `#2e2e2e` background, `#4f86cd` text |
| input focus | border `#466d94`, a 2px ring `#3d6185`; inputs in popovers have no fill of their own |

Syntax: keyword `#cc7832`, string `#66bf31`, function and class `#ffc66d`, number `#6897bb`, comment `#808080`,
local variable `#f99e71`, property and parameter `#9876aa`.

Background texture: millimetre paper in real CSS millimetres, white hairlines at 1 mm (`.018`), 5 mm (`.035`) and
10 mm (`.06`) opacity, under the centred card as today.

Active tab: light grey `#45484b`, white text, the blue underline. Pressed tool-window button: blue `#4a78c2`
with a white icon while its panel has focus, grey `#4b4e51` with a white icon when it does not.

Header accents: sessions blue `#589df6`, agent restart green `#66bf31`, model `#ae8abe`, usage `#ffc66d`, the
gear neutral.

**Header and file bar.** Sessions and ↻ Agent become icons (a history clock with the existing chevron; a
restart arrow), and "Open raw" above a file becomes an open-externally icon. Text stays where it is a value or
needs explaining: the model, the mode, Send, panel titles. The names move to tooltips and `aria-label`.

**Tooltips name the key.** Every control that has a shortcut shows it in its tooltip (for example "Files (⌘⇧F)"). This is
a rule for every new control too, and goes into `AGENTS.md`.

## 2. Light themes

IntelliJ Light, GitHub Light (Primer) and Solarized Light, each from its published palette: UI neutrals,
accents and syntax colours mapped onto the same tokens. The texture is the Darcula millimetre paper with dark
hairlines at equivalent contrast. Solarized's low contrast must still pass WCAG AA for body text and controls;
where its own values do not, the closest Solarized tone that does is used.

## 3. Markup palette

The palette (tools, colours, undo, Comment, close) moves out of the floating bar into the file bar, next to the
path. It is always there for an image. For a video it appears when the video is paused (the pause button or
Space) and goes away when it plays; an uncommented drawing is kept, as today. The "Mark up" button is gone.

The default tool is a pointer that draws nothing: a click toggles natural size and selection works as now.
Drawing starts once a tool is picked. Keys, side by side on the keyboard, active while the image or player has
focus and never in a text field:

| Key | Tool |
|---|---|
| Q | pointer |
| W | rectangle |
| E | ellipse |
| R | pen |
| T | arrow |
| 1–5 | colour: red, yellow, green, blue, white |
| Cmd/Ctrl+Z | undo |
| Enter | comment |
| Esc | back to the pointer; asks first when a drawing has no comment |

These keys replace R/E/P/A rather than adding to them: the author asked for keys side by side, and an alias would give R two meanings. The changelog and the guide say so.

The keys work in the same scope as the player keys (`inPlayerScope`). Enter and Esc are taken only while there is a drawing or a drawing tool is active; otherwise they fall through to the layers that own them today. The pressed tool in the palette shows which tool is active.

On an image, 1–5 always pick the colour and keep the tool. On a video, 0–9 seek to 0–90 % as today while the pointer is active, and 1–5 pick a colour while a drawing tool is. Pressing play with an uncommented drawing asks first, with the dialog Esc uses today; once it plays, the palette hides and the tool goes back to the pointer.

In a narrow window the path truncates from the left first; the palette keeps its width and never wraps. HTML
pages keep their Mark (N) mode: an always-on element outline would get in the way of reading.

## Decided by the builder

- Token names, and how the 139 literals map onto them.
- The icons, as long as they match the existing set in `TabStrip.tsx`.
- How a panel's focus is tracked for the pressed tool-window state.
- The light palettes' exact values, from the official sources.
- Tests: a theme switch test across windows like the scale's, a check that no colour literal is left outside
  `theme.css`, and e2e for the palette and its keys. The literal check has an allow-list: the five markup colours
  (they are what the agent sees on the frame, the same in every theme), white text on primary, and test fixtures.

Docs: `docs/guide.md` (Settings and its Themes section, the gear menu, markup and its keys, the hotkey table) and the changelog.
