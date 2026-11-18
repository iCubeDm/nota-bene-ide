# Media comments Implementation Plan

**Goal:** In an image tab, or a video tab paused on a frame, the user draws shapes and writes a comment that joins the batch. The agent gets the file, relative and pixel coordinates, the timecode, and two files in the project: the frame with the marks, and the marks alone on a transparent layer.

**Architecture:**
- Data: a media comment is a `Comment` whose `anchor` is a new `MediaAnchor` (`kind: 'media'`); shapes are stored in relative coordinates.
- Drawing: an SVG overlay with `viewBox="0 0 1 1"` laid exactly over the media's content box, so relative coordinates are native for drawing and for showing marks.
- Rendering: on "add" the browser renders the composite and the layer on a canvas at the natural size, uploads both at full size to a new server route (written under `<root>/.nota-bene/marks/<commentId>/`), and uploads downscaled copies through the existing `/attach` so the agent sees them.
- Deletion: when a comment disappears from its session's set, the server deletes its folder.

**Stack:** React 19 + Redux Toolkit, Node TS, vitest, Playwright (Chrome, ffmpeg fixtures). No new dependencies. **Spec:** `docs/superpowers/specs/2026-10-26-media-comments-design.md`.

## Decisions and constraints

- Tools: rectangle, ellipse, freehand pen, arrow, colour, undo.
- Video: a still frame only; entering the markup mode pauses it. No time ranges.
- Coordinates: fractions of the media's natural width and height from the top-left, rounded to 4 decimals; pixels given at natural size.
- Files: `<root>/.nota-bene/marks/<commentId>/frame.jpg` and `layer.png`; `<root>/.nota-bene/.gitignore` containing exactly `*\n`; the user's `.gitignore` is never touched.
- Layer resolution: `layer.png` at natural size; only if the PNG exceeds `MARK_MAX_BYTES` (25 MB) it is downscaled and the batch states the scale. `frame.jpg` is JPEG quality 0.9, natural size up to the same cap.
- Deleting a comment (pending or sent) deletes its folder in the same step. Sent comments keep their files.
- The server writes into the project only under `.nota-bene/marks/`, only server-generated names, comment id must match `/^[0-9a-f-]{36}$/` (`crypto.randomUUID`), and it refuses a symlinked `.nota-bene` or `marks`. This code gets an independent review.
- Gating: `PROTOCOL` becomes 4; markup is offered only when `controls.protocol >= 4`.
- Video marks are drawn only while the video is paused within `max(0.5 / fps, 0.04)` s of their time (fps unknown: 0.04 s). Opening the comment seeks there and pauses.
- Unfinished drawing: in memory per tab, kept across tab switches; Esc, leaving the mode or closing the tab asks before discarding a drawing that has shapes.
- Performance: drawing follows the pointer at display rate on a 4K image; no React re-render of the whole pane per pointer move, the live stroke is updated in place.
- Tests only on ports 4790-4795; never touch a live window; run `npx tsc -b`, `npm test`, `npm run e2e`.

## Review focus (each has a test)

1. Letterboxed media (`object-fit: contain`, pane wider or taller than the image): shapes land on the pixels drawn on, not offset by the letterbox (Task 2 unit, Task 9 e2e).
2. Natural-size mode scrolled to the bottom-right: same mapping (Task 2, Task 9).
3. The media file overwritten by a regeneration while a comment is pending: the mark stays and says "file changed"; the batch says it was marked on an earlier version (Tasks 4, 7, 8).
4. A turn ending while the markup mode is open: the media must not reload under the drawing (Task 5).
5. The user cancels the popup after the files were uploaded: no orphan folder is left (Task 6).

## Contracts

Shared (`shared/src/protocol.ts`, Task 1):
```ts
type FileSource = Extract<AnchorSource, { kind: 'file' }>;
type MarkColor = '#ff3b30' | '#ffcc00' | '#34c759' | '#0a84ff' | '#ffffff';   // MARK_COLORS
type MediaShape =
  | { kind: 'rect' | 'ellipse'; color; x; y; w; h }          // relative bbox
  | { kind: 'arrow'; color; x1; y1; x2; y2 }
  | { kind: 'pen'; color; points: number[] };                 // flat [x0,y0,x1,y1,...], relative
type MediaAnchor = { kind: 'media'; source: FileSource; width; height /* natural px */;
  time?: number /* video, seconds, ms precision */; version?: string /* /file ETag when drawn */; shapes: MediaShape[] };
type TextAnchor = { source; start; end; quote; prefix; suffix };  type Anchor = TextAnchor | MediaAnchor
isMediaAnchor(a); PROTOCOL = 4   // doc line "4: media anchors and /marks"
```
- Validation rejects: coordinate outside [0,1] or not finite (arrow and pen too), pen with an odd number of values or over 20000 values, unknown colour, empty shapes, `width <= 0`, `source.kind !== 'file'`; rect/ellipse need `w, h > 0`. `toAnchor` copies deeply. Existing uses of `quote/start/end` narrow with `isMediaAnchor`; text-only code (HighlightLayer, resolve, SelectionButton, fileComments) filters media comments out; no behaviour change for text anchors.

Geometry (`web/src/media/markup/geometry.ts`, Task 2): `contentBox(elRect, natW, natH, 'contain'|'natural')` (contain letterboxes inside the element box; natural uses the element box as is, so a scrolled element has a negative x); `toRel(clientX, clientY, box)` (clamped, 4 decimals); `round4`; `simplify(points, eps = 0.0015)` (drops near duplicates, keeps first and last, never empties a 2-point stroke); `rectFrom(a, b)` (any drag direction); `describeShape(s, natW, natH)` gives one batch line per shape, pixels `Math.round(rel * natural)`:
- `rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)` on 1920x1080
- `pen 38 pts, bbox x=... (px ...)`, `ellipse cx=... cy=... rx=... ry=... (px ...)`, `arrow (0.3,0.55)→(0.41,0.5) (px ...→...)`

Rendering (`render.ts`, Task 3): `drawShapes(ctx, shapes, w, h)` with stroke width `max(3, round(min(w,h)/250))` px (4 on 1920x1080); `renderMarks(source, w, h, shapes)` returns `{frame: Blob (jpeg q0.9, source drawn first), layer: Blob (png, shapes only, transparent), scale}`, natural size, `scale < 1` only when a file exceeded the cap (retry at scale x 0.75 until it fits); `OffscreenCanvas` when available, else a canvas element. Only `drawShapes` is unit-tested (recording fake ctx; jsdom has no canvas); `renderMarks` is covered by e2e.

Server (`server/src/marks.ts`, Task 4):
- `MARK_ID = /^[0-9a-f-]{36}$/`; `MarkFiles({root: () => string})`: `write(id, 'frame.jpg'|'layer.png', bytes)` (creates `.nota-bene/.gitignore` if missing; throws on a bad id, name or type, a symlinked dir, or bytes over `MARK_MAX_BYTES`; `lstatSync` check that `.nota-bene` and `marks` are real dirs; tmp + rename), `remove(id)` (idempotent, missing folder fine), `sync(prev, next)` (media comments present in prev and absent from next lose their folder; text comments and still-present ones are kept).
- Routes with the same host/origin checks as `/attach`: `POST /marks/<id>/<frame.jpg|layer.png>` (Content-Type `image/jpeg` | `image/png`) gives 204; `DELETE /marks/<id>` gives 204. `/file` responses gain `ETag: W/"<size>-<mtimeMs>"` (absent for branch sources is fine). In the `comments` case of `server.ts`, `marks.sync(store.get(id), merged)` runs after `store.merge` succeeds; errors are reported, never fail the merge.

Markup mode (web, Task 5): slice `markup` per tab id, in memory only: `Draft = {on, tool: 'rect'|'ellipse'|'pen'|'arrow', color, shapes}`; actions `setMode`, `setTool`, `setColor`, `addShape`, `undo`, `clear`; `selectDraft`; `MarkupLayer({tabId, media, fit, onAdd})`.
- UI: a "Mark up" toggle top-right of the media tab; the toolbar has tools, 5 colours, undo, "Comment", close. Keys: R, E (ellipse), P, A, 1-5 colours, Cmd/Ctrl+Z undo, Enter = Comment, Esc = leave; leaving with shapes uses the existing `ConfirmDialog`.
- Implementation: the SVG overlay sits at `contentBox(...)`, recomputed via `ResizeObserver` plus the pane's scroll event; shapes use `vector-effect: non-scaling-stroke`; the live pen stroke is a ref'd `<polyline>` whose `points` attribute is set directly, and the slice is dispatched once on pointerup (simplified). While the mode is on, `FileView` skips click-to-zoom and the after-turn media reload. Entering pauses a playing video.

Drawing to comment (Task 6): `prepareMediaComment(id, source, anchor)` renders, uploads natural-size files to `/marks/<id>/...`, uploads downscaled copies to `/attach` (frame first), returns `{images: [frameAttachId, layerAttachId]}`; on any failure it deletes `/marks/<id>`. `CommentPopup` takes `pending: {anchor: Anchor; rect; text?; id?; prepare?}`; with `prepare`, "Add" awaits it (spinner, disabled) then dispatches `addComment({id, anchor, text, label, images: [...prepared, ...pasted]})`; `addComment` accepts a caller-given `id` (the folder is named by it). Cancelling the popup after `prepare` ran deletes `/marks/<id>`. The draft is cleared and the mode left only after `addComment`. Video source is the paused `<video>` with `anchor.time = round(currentTime, 3)`; image source is the `<img>`; `anchor.version` is the media ETag read via `HEAD /file?...` when the mode is entered. The popup quote for a media anchor shows the file and the shape count.

Marks, card, jump (Task 7): `MediaMarks({tabId, media, fit, path, ref})` is an SVG overlay of pending (accent) and sent (dimmed) shapes for this file only; a click opens the card; video marks show only while paused within `max(0.5/fps, 0.04)` s of `anchor.time`; `pointer-events` only on shapes, never over native video controls (the bottom 48 px of a video stay free). The card shows a thumbnail (`/attach/<images[0]>`, up to 96 px high), file name, video time, and a "file changed since" flag when the current ETag differs from `anchor.version`; jump opens the tab, and for video seeks to `time` and pauses. Selector `selectMediaComments(path, ref)`.

Batch (Task 8), exact block (English; `ru` translates the words, not the format):
```
3. [media/scene_v6.png · 1920×1080]
> rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)
> pen 38 pts, bbox x=0.3 y=0.5 w=0.1 h=0.08 (px 576,540 192×86)
→ The character sits here
📎 images: 4 (frame with marks), 5 (marks only, transparent)
   files: .nota-bene/marks/<id>/frame.jpg, .nota-bene/marks/<id>/layer.png
```
- Video header: `[media/clip.mp4 @ 0:04.240 · 1280×720]`. Changed file adds `   (marked on an earlier version of the file; the frame shows it)`. A scaled layer reads `layer.png (scaled ×0.75)`. Images are numbered frame-then-layer within the global numbering. Touches `compose.ts` and `send.ts` (`whereOf`).

## Tests and wrap-up

- Unit: protocol round-trip and rejections; geometry cases (contain 1000x500 over natural 1000x1000 gives x=250, w=500; 500x1000 over 1000x500 gives y=375, h=250; `toRel` corners and clamping); `drawShapes` path calls; marks write/refuse/sync/remove and a weak ETag that changes with the file; markup layer cases (not offered below protocol 4, letterboxed drag, single dispatch per stroke, undo and Esc confirm, draft survives tab switch, no zoom toggle or reload while marking); prepare call order and cleanup on failure or cancel; marks styling and video visibility; card thumbnail and "file changed"; the three batch formats.
- e2e (`e2e/files.spec.ts`, `@files`; fixtures `docs/big.png`, the generated video, a new 1000x500 `media/wide.png`): mark up `wide.png` in a letterboxing pane, rect from 25%/25% to 75%/50% must give `rect x=0.25 y=0.25 w=0.5 h=0.25 (px 250,125 500×125)` ±0.005 in the captured websocket frame, `layer.png` exists at 1000x500 with an opaque pixel at (500,125) and a transparent one at (10,10); natural size scrolled bottom-right gives the same mapping; paused video frame puts the time in the batch and the mark shows only when paused there; deleting the comment removes its folder; a 300-point pen stroke on a 3840x2160 fixture completes with a median pointer-move handler time under 4 ms.
- Finish: independent review of Task 4 (project writes, deletion, path safety) and Task 6 (cleanup on failure); `npx tsc -b && npm test && npm run e2e` green; run the server once on 4790 with a temp project and `NOTA_BENE_HOME` and check `/info`; merge to main, `npm run build -w web`, ask the user for the server restart from the menu and verify the pid changed.
