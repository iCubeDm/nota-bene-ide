# Media comments: mark up an image or a paused video frame — design

Date: 2026-10-26. Status: draft for review.

## Why

The user works on media with the agent (regenerating images, generating video). To point at a place in a frame they had to leave Nota Bene, draw in macOS Markup and paste the result. A real case: a drawing placed on top of the image made the generator copy the old pose from it; it worked once the agent moved the lines onto an empty layer and passed that as a separate reference.

The feature brings the loop into Nota Bene: on an image tab, or a video tab paused on a frame, the user draws shapes and writes a comment like a text comment. The agent gets the file, relative coordinates, timecode, the frame with the drawing, and the drawing alone on a transparent layer. Success: the user never opens Markup again and the agent gets the place right the first time.

## Goals

- Markup mode in image and video tabs: rectangle, ellipse, freehand pen, arrow, colour, undo (the user wanted "a real drawing tool").
- Video: entering the mode pauses; the markup belongs to that one still frame.
- One comment = one markup (any number of shapes) + text, optional quick label; joins the pending batch.
- Shapes stay drawn as a pending mark; click opens the comment; dim after sending.
- Sent to the agent: text; file path (`@ ref` for another source); video timecode; shapes in relative coordinates (fractions of width/height from the top-left, so the drawing zoom does not matter) and in natural-size pixels; two images (frame with shapes; shapes alone, transparent, frame-sized).
- The panel card shows a small thumbnail of the frame with shapes.

## Non-goals (v1)

Video time ranges; several frames per comment; audio; diffing media revisions (anchor records `ref` like text files); editing shapes after creation (delete and redraw; text stays editable).

## Anti-goals (what makes it a failure)

1. Lag: drawing must follow the pointer at display rate on 4K; entering/leaving the mode, adding a comment and opening a tab with many marks must not stutter.
2. Skewed coordinates: numbers must describe exactly where the user drew. Traps: `object-fit: contain` letterboxing (drawable area is the media content box), fit/natural zoom toggle, scrolling, device pixel ratio, intrinsic vs display size. Tests use known shapes on a known image.
3. Awkward use: few clicks, keyboard-friendly, no fight with click-to-zoom or video controls; leaving is obvious (Esc, toggle) and never silently loses a drawing.

## Constraints

- Reuse, not parallel: comments (`Comment`/`Anchor` in `shared/src/protocol.ts`, `comments/slice.ts`, server store, `composeBatch`, `sendBatch`); attachments (`/attach`, content-addressed, `MAX_ATTACHMENT_BYTES` 3.75 MB; comment `images` are attachment ids numbered by `sendBatch`); the media tab (`files/FileView.tsx`, `nb-fit`/`nb-natural`, media controller pause/PiP rules); `HighlightLayer`-style painting.
- The media anchor is a distinct kind in a discriminated union so text paths cannot misread it; server `isAnchor`/`toAnchor` accept it.
- Protocol gating: bump `PROTOCOL` to 4 (3 is the 🔥 label); offer markup only when the server announced >= 4 (an older server would reject the anchor).
- API downscales images anyway; both attachment images must fit the cap, so no huge 4K PNGs. Coordinates carry the precision.
- No heavy dependencies; canvas/SVG is enough.
- Tests: unit for coordinate mapping and anchor/batch format; e2e (real browser, ffmpeg fixtures) for image, paused video and send.

## Decided

| Topic | Decision | By |
|---|---|---|
| Tools | rectangle, circle, freehand, arrow, colour, undo | user (shapes, "full drawing"); arrow/colour my call |
| Video | pause, one frame, no ranges | user |
| Coordinates | relative fractions plus pixels | user (relative); pixels my call, for scripts |
| Layer | drawing alone on a transparent layer goes to the agent | user |
| Artifacts | frame and layer are FILES in `.nota-bene/marks/<commentId>/`, named in the batch | user |
| Deletion | deleting a comment deletes its folder at once; no later cache cleaning | user |
| Mark on media | stays; click opens the comment | user |
| Composite | frame with drawing also goes (what the user did by hand) | my call |
| Order | before the rest of M6 package B | my call |

## Mark files in the project

So the agent can use the drawing (pass the layer to a generator or script), the images are project files:

- `<root>/.nota-bene/marks/<commentId>/frame.<jpg|webp>` (frame with shapes), `layer.png` (shapes only, transparent, natural size).
- `<root>/.nota-bene/.gitignore` containing `*`, written once; the user's `.gitignore` is never touched.

Rules:
- This is the server's first write into the project. It writes only under `<root>/.nota-bene/marks/`, only generated names (`<commentId>` must match the id format, fixed file names), never a client path, and refuses a symlinked `.nota-bene` or `marks`. Needs independent review.
- Two copies (revised while planning): project files at full resolution for tools; the model's view uses the existing attachments (downscaled to 1568 px, `IMG_EDGE`), which feed bubbles and replay and are covered by M6-15 "clean unreferenced attachments". Reusing that path avoids a second image pipeline. The batch names both project files by project-relative path.
- Lifecycle: folder written when the comment is added; deleting the comment (pending or sent) removes it in the same step; sent comments keep files for later turns; a missing folder is shown as such, never an error.
- M6-15 Storage section shows the size of `.nota-bene/marks/` (later).

## Batch format (to the agent)

A media comment appears in the numbered batch like a text one; its "quote" is a compact machine-readable description:

```
3. [media/scene_v6.png · 1920×1080]
> region: rect x=0.42 y=0.40 w=0.16 h=0.24 (px 806,432 307×259); pen 38 pts; arrow (0.30,0.55)→(0.41,0.50)
→ The character sits here, facing the door
📎 images: 4 (frame with marks), 5 (marks only, transparent)
   files: .nota-bene/marks/7f3c…/frame.jpg, .nota-bene/marks/7f3c…/layer.png
```

Video: `[media/clip.mp4 @ 0:04.240 · frame 1280×720]`; time is `currentTime` at pause (ms, what `ffmpeg -ss` needs); exact frame index is not promised. Freehand strokes are summarised in text (point count, bounding box); full point lists (relative, 4 decimals) stay in the stored anchor; the builder decides whether they also travel as a JSON line.

## Calls made after the builder check (user may override)

- Layer is always natural size (aligns 1:1 with the source); a mostly empty PNG fits the cap even at 4K. If not, downscale and state the factor in the batch. The composite may be downscaled freely.
- Frame and layer are rendered when the comment is added, not at send, so the agent gets exactly what was drawn.
- Media changed underneath (regeneration may overwrite the path): the anchor records natural size and the file version token (ETag/Last-Modified). The mark is still drawn from relative coordinates; on a version mismatch the card/mark say "the file has changed since" and the batch says "marked on an earlier version; the attached frame shows it". The after-turn reload of the media tab is held off while markup is open.
- Video marks are drawn only while paused at their timecode (within half a frame, or 40 ms if rate unknown). Opening or jumping to the comment seeks and pauses. Nothing is drawn over moving frames; the overlay never takes clicks on native controls.
- An unfinished drawing is kept in memory per tab across switches; Esc or closing a tab with shapes asks before discarding. A page reload loses it; server restart does not reload the page.

## Left to the builder

Canvas vs SVG and overlay tracking of zoom/scroll; pointer handling (simplify strokes, never lose a short one); frame capture via canvas `drawImage` of the paused video at intrinsic size (composite JPEG/WebP, layer PNG, downscale to cap); toolbar look and in-mode shortcuts (must not collide with M6-14's global keymap); palette; card thumbnail; dimmed marks and mark count limits.

## Known gaps after v1 (deferred in review, 2026-10-26)

- No sweep of orphan mark folders (comment dropped by a session switch, failed DELETE, or re-rooting switch leaves a git-ignored, bounded folder).
- "Folder missing" not shown on a card whose folder was deleted by hand; the batch still names the files.
- Two windows on one session (last writer wins) can delete the mark folder of a comment the other re-adds.
- "File changed" is known only while a tab has loaded the file's ETag.

## Open for later

Video time ranges and multi-frame comments; shapes editable after creation; compare-with-previous-version view.
