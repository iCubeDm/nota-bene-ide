# Images and video with markup in the app (#90) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the phone, open an image or a video of the project from the chat, draw on it (rectangle, ellipse,
arrow, pen; the desktop's five colours), comment, and send: the agent gets the same batch and the same frame image
the desktop would send. A video plays from the host through the channel with Range.

**Architecture:** The media anchor and its files are the desktop's (`web/src/media/markup`): shapes relative to the
natural size, `frame.jpg` + `layer.png` written to `/marks/<comment id>/`, the downscaled frame posted to `/attach`
and kept as the comment's only generated image (`genImages: 1`). The batch text gains the desktop's media branch
(`composeBatch`, `whereOf`), with its strings generated from `web/src/i18n` as templates. Comments with images
(media ones, and text ones with pasted images) are now sent from the phone too: the send carries their image refs,
labelled as the desktop labels them; the server takes each image's type from its own store. A video plays in
`video_player` from a loopback HTTP proxy that forwards each request, Range included, as a streamed `http` stream of
the channel; the frame to mark is taken by Android's `MediaMetadataRetriever` from the same proxy at the paused time.

**Tech Stack:** Flutter (`mobile/app`), `video_player`, `image` (JPEG encoding in an isolate), a Kotlin method channel
(`MainActivity`), `dart:io` `HttpServer` on 127.0.0.1, `nb_channel` (`mobile/channel`), Vitest for desktop fixtures.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` (Intent: media work; What goes through the
channel: `/file` with Range, the loopback endpoint for video; The app: comments accumulate, media anchors). Issue #90.

## Global Constraints

- Branch `gh-90-media` from `remote`; PR into `remote`; squash; title and commits `gh-90: …`.
- Every user-visible app string in all six ARB files (en, ru, zh, es, pt, de) with a real translation.
- No protocol change and no server change. A comment the phone makes passes `isComment` in `shared`.
- The batch text is the desktop's, character for character, for the cases the phone produces (checked against a
  fixture the desktop writes). Several comments on one frame are not combined into one composite image on the phone:
  each sends its own frame, which is the desktop's own fallback.
- Image files: `png jpg jpeg gif webp bmp`, at most 32 MiB. Video files: `mp4 mov webm m4v`, streamed, no cap.
- The loopback proxy listens on 127.0.0.1 only, on a random port, under a random path token; Android allows
  cleartext to 127.0.0.1 only (network security config).
- Tests only on ports 4790–4795; Flutter widget tests use the existing fakes (`test/support`).

## Review Focus

1. A shape drawn on the phone lands where the desktop draws it: relative coordinates over the image's contained
   box (letterboxing aside), the arrow head and stroke width as `drawShapes` sizes them, a pen stroke simplified
   under `PEN_MAX_VALUES`.
2. The send carries every pending comment's images with the desktop's labels and numbering (`imgLabelC`), the
   batch names them (`imgRefMedia`, `imgRef`, `filesLine`, `scaledSfx`), and a refused send leaves them pending.
3. A failure in the middle of making a media comment (frame not available, `/marks` or `/attach` refused, channel
   gone) deletes `/marks/<id>`, adds nothing, and says so; the drawing stays so the user can retry.
4. Video: a seek past the buffered part asks the proxy with Range and gets 206; leaving the screen closes the
   channel streams; a host that went away shows an error state, not a spinner forever.
5. A file too large, missing (404), outside the project (403) or not decodable shows a clear state.

---

### Task 1: Shapes in Dart, checked against the desktop

**Files:**
- Create: `mobile/app/lib/media/shapes.dart`
- Create: `mobile/app/test/shapes_test.dart`
- Create: `web/src/media/markup/mobileParity.test.ts` (writes `mobile/app/test/fixtures/media/shapes.json` with
  `UPDATE_FIXTURES=1`, else compares)
- Create: `mobile/app/test/fixtures/media/shapes.json`

**Interfaces:**
- Produces:
  - `String jsNum(num v)`: a number as JavaScript's `String(v)` writes it (`1` not `1.0`, `0.1235`, `1e-7`).
  - `String describeShape(MediaShape s, int natW, int natH)` and `String mediaTime(double t)`, as `geometry.ts`.
  - `double strokeWidth(int w, int h)` and `void paintShapes(Canvas c, List<MediaShape> shapes, double w, double h, {double? lineWidth})`: `drawShapes` (round caps and joins, arrow head 25°, `max(12, 4·lineWidth)`).
  - `List<double> simplify(List<double> points, [double eps = 0.0015])` and `List<double> penPoints(List<double> raw)` (simplified, eps doubled from 0.003 while over `penMaxValues = 20000`), as `MarkupLayer`.
  - `const markColors = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff']`, `Color colorOf(String hex)`.
  - `Rect containBox(Size box, Size natural)`, `Offset toRel(Offset p, Rect content)` (clamped to 0..1), `rectFrom(Offset a, Offset b)`.

- [ ] **Step 1:** the Vitest test writes, for a fixed list of shapes (each kind, edge values, 0.5, 1, a long pen), `describeShape` at 1920×1080 and 7×3, `mediaTime` of 0, 0.0004, 61.5, 3599.999, `simplify` of three pen inputs, and `round4`-ed `rectFrom` results. Run with `UPDATE_FIXTURES=1`, commit the JSON.
- [ ] **Step 2:** `shapes_test.dart` reads the JSON and expects each Dart result to equal it; plus `jsNum` cases (`1`, `0.5`, `-0`, `1e21`, `0.000001`, `1e-7`) and a `paintShapes` smoke test (records into a `PictureRecorder`, no throw, a pen with 2 values draws nothing). Run: `flutter test test/shapes_test.dart`. Expected: FAIL (no `shapes.dart`).
- [ ] **Step 3:** implement `shapes.dart`. Run the test. Expected: PASS.
- [ ] **Step 4:** commit `gh-90: shapes, their text and painting as the desktop's`.

### Task 2: The batch for media comments and images in the send

**Files:**
- Modify: `scripts/protocol/mobileStrings.ts` (templates), regenerate `mobile/app/lib/comments/strings.g.dart`
- Modify: `mobile/app/lib/comments/comments.dart` (`composeBatch`, `whereOf`, `sendable`, `add`)
- Modify: `mobile/app/lib/chat/composer.dart` (send `images`)
- Create: `web/src/comments/mobileBatch.test.ts` (writes `mobile/app/test/fixtures/batch/media.json`)
- Modify: `mobile/app/test/comments_test.dart`, `mobile/app/test/strings_test.dart`

**Interfaces:**
- Consumes: `describeShape`, `mediaTime`, `jsNum` (Task 1).
- Produces:
  - `String batchTemplate(String key, String lang, List<String> args)`: fills `{0}`, `{1}` of a template generated by calling the web's function with those placeholders (`imgLabel`, `imgLabelC`, `imgRef`, `imgRefMedia`, `filesLine`, `scaledSfx`) or a plain string (`markStale`, `batchHead`, `srcChat`). A list argument is passed joined with `, ` (the web joins every list so).
  - `({String text, List<ImageRef> images}) composeSend(String general, List<Comment> items, String lang, {bool Function(Comment)? staleOf})`: numbers images across the message as `sendNow` does (no composer images on the phone; each comment's own images: a media comment's frame, then pasted ones), labels `imgLabelC(k, i+1)`, `mediaType: image/png` (the server takes the stored type). The old `composeBatch` stays for text-only callers or is folded in.
  - `Comments.sendable`: every pending comment not being sent (the images exclusion goes).
  - `Comment Comments.add(Anchor anchor, String text, QuickLabelId? label, {String? id, List<String>? images, int? genImages})`.
  - `WindowTab.fileVersions`: `Map<String, String>` path → the ETag last read, for `staleOf`.

- [ ] **Step 1:** the generator emits templates for the six function keys and `markStale`; `strings_test.dart` checks `batchTemplate('imgLabelC','ru',['3','2'])` is `[изображение 3 · к комментарию 2]` and that every key exists in all six languages. Run `npm run gen:protocol` then `flutter test test/strings_test.dart`. Expected: FAIL before the generator change, PASS after.
- [ ] **Step 2:** the Vitest test writes, in each of the six languages, the desktop's `composeBatch` text and the `images` the desktop's `sendNow` would send (labels and ids) for: a text comment; a text comment with two pasted images; a media comment on an image (`rect`, `arrow`); a media comment on a video with `time`, `scale`, a pasted image and a stale version; all four together after a general text. (Built with the desktop's own functions; the composite path off.)
- [ ] **Step 3:** `comments_test.dart`: `composeSend` equals the fixture for each case and language; `sendable` now includes a media comment and a text one with images; a widget test sends a media comment and the `send` message carries `images` with the fixture's labels. Expected: FAIL.
- [ ] **Step 4:** implement. Expected: PASS; the existing composer tests stay green (the test that kept image comments for the desktop is rewritten: they are sent now).
- [ ] **Step 5:** commit `gh-90: media comments and comment images in the phone's batch`.

### Task 3: Streamed HTTP over the channel and the loopback proxy

**Files:**
- Modify: `mobile/channel/lib/src/channel.dart` (`httpStream`), test in `mobile/channel/test/`
- Create: `mobile/app/lib/media/proxy.dart`, `mobile/app/test/proxy_test.dart`
- Create: `mobile/app/android/app/src/main/res/xml/network_security_config.xml`; Modify: `AndroidManifest.xml`

**Interfaces:**
- Produces:
  - `Future<HttpStreamAnswer> Channel.httpStream(int port, String method, String path, {Map<String,String>? headers})` with `HttpStreamAnswer = ({int status, Map<String,String> headers, Stream<Uint8List> body, void Function() cancel})`; the body stream pauses the mux stream (no credit) while its listener pauses; `cancel` closes the stream (`CLOSE` 1000). `http` is rebuilt on it.
  - `class MediaProxy { static Future<MediaProxy> start(Future<HttpStreamAnswer> Function(String method, Map<String,String> headers) open); Uri get uri; Future<void> close(); }`: one file per proxy; `GET`/`HEAD` on `uri` forward `range`, `if-range`, `if-none-match`, `accept`; status and `content-type`, `content-length`, `content-range`, `accept-ranges`, `etag`, `last-modified` come back; any other path → 404; a client that disconnects cancels the channel stream.

- [ ] **Step 1:** channel test (existing in-process fake host of `mobile/channel/test`): a 1 MiB body arrives as several chunks of `httpStream` in order; pausing the listener stops credit after one window; `cancel` closes the stream on the host side. Expected: FAIL.
- [ ] **Step 2:** implement `httpStream`, `http` on top of it. Expected: PASS, the channel's other tests green.
- [ ] **Step 3:** `proxy_test.dart` with a fake `open` returning canned answers: a `Range: bytes=10-19` request reaches `open` and its 206 with `content-range` comes back byte for byte; a wrong token path is 404 and never calls `open`; closing the client mid-body calls `cancel`; the server is bound to the loopback address. Expected: FAIL, then implement, PASS.
- [ ] **Step 4:** network security config: cleartext permitted for `127.0.0.1` only, base config cleartext off. Check with `flutter build apk --debug` (manifest merges).
- [ ] **Step 5:** commit `gh-90: streamed requests over the channel and a loopback proxy for the player`.

### Task 4: The image screen: view, mark up, comment

**Files:**
- Create: `mobile/app/lib/media/markup.dart` (the drawing layer and toolbar, shared with video)
- Create: `mobile/app/lib/media/render.dart` (frame.jpg, layer.png, the agent image)
- Create: `mobile/app/lib/media/media_comment.dart` (`/marks`, `/attach`, the anchor)
- Create: `mobile/app/lib/files/image_screen.dart`
- Modify: `mobile/app/lib/chat/files.dart` (`projectFile` with kinds; icons), `file_screen.dart` (dispatch by kind)
- Modify: six ARB files; Test: `mobile/app/test/image_screen_test.dart`, `render_test.dart`

**Interfaces:**
- Consumes: Task 1 (`paintShapes`, `penPoints`, `containBox`, `toRel`), Task 2 (`Comments.add`, `fileVersions`).
- Produces:
  - `enum FileKind { markdown, image, video }`, `FileKind? fileKindOf(String path)`; `String? projectFile(String root, String path)` (replaces `projectMarkdown`).
  - `class MarkupLayer extends StatefulWidget { Size natural; List<Comment> shown; bool marking; ValueChanged<List<MediaShape>> onChanged; }` and `MarkupToolbar` (four tools, five colours, undo, Comment, close).
  - `Future<({Uint8List frame, Uint8List layer, double scale})> renderMarks(ui.Image source, int w, int h, List<MediaShape> shapes)` (white under the source, JPEG q 90 via `image` in `compute`, PNG layer; ×0.75 until both ≤ `markMaxBytes = 25 MiB`).
  - `Future<Uint8List> agentImage(Uint8List jpeg, int w, int h)`: longest edge ≤ 1568; PNG unless over 3.5 MB, then JPEG 0.9.
  - `Future<({List<String> images, double? scale})> prepareMediaComment(Channel ch, int port, String id, ui.Image source, MediaAnchor anchor)`: `POST /marks/<id>/frame.jpg`, `POST /marks/<id>/layer.png`, `POST /attach`; on any failure `DELETE /marks/<id>` and rethrow.

- [ ] **Step 1:** `render_test.dart`: a 40×20 red source with a white rect: `frame` starts with `ff d8 ff` and decodes to 40×20 with the rect's pixels white; `layer` is a PNG, transparent away from the shape; a source over the cap scales (cap injected small) and reports the scale; `agentImage` of 4000×1000 gives 1568×392. Expected: FAIL, implement, PASS.
- [ ] **Step 2:** `image_screen_test.dart` (fake channel answering `/file`, `/marks`, `/attach`): the image shows; Mark up → drag a rectangle → Comment → the sheet → Save: `/marks/<id>/frame.jpg` and `layer.png` were posted with the id that the `comments` message's new comment carries, `/attach` was posted, the comment has a media anchor with the drag's relative box (contained-box maths: the image letterboxed in a tall screen), `images: [attach id]`, `genImages: 1`, `version` = the `/file` ETag; a refused `/attach` deletes `/marks/<id>` and adds nothing; 404, 403, an over-cap file and undecodable bytes each show their state; the existing comments of the file are drawn with their number. Expected: FAIL.
- [ ] **Step 3:** implement; tool lines and the Files menu list images (and videos, opening Task 5's screen); strings in six ARB files. Expected: PASS, the Markdown screen's tests green.
- [ ] **Step 4:** commit `gh-90: images: view, mark up and comment`.

### Task 5: The video screen: play through the proxy, mark a paused frame

**Files:**
- Create: `mobile/app/lib/files/video_screen.dart`, `mobile/app/lib/media/frame.dart` (method channel `nb/frame`)
- Modify: `mobile/app/android/app/src/main/kotlin/dev/notabene/nb_app/MainActivity.kt`
- Modify: `mobile/app/pubspec.yaml` (`video_player`; dev: `video_player_platform_interface`)
- Modify: six ARB files; Test: `mobile/app/test/video_screen_test.dart`

**Interfaces:**
- Consumes: Task 3 (`MediaProxy`, `httpStream`), Task 4 (`MarkupLayer`, `prepareMediaComment`).
- Produces:
  - `Future<({Uint8List png, int width, int height})> frameAt(Uri url, Duration at)`: Kotlin `MediaMetadataRetriever.setDataSource(url, {})`, `getFrameAtTime(µs, OPTION_CLOSEST)`, PNG; errors as `PlatformException`.
  - `VideoScreen`: play/pause, a scrubber with a tick per comment of this file (tap: seek there and pause, its shapes shown), Mark up pauses and takes the frame at the paused position; the anchor's `time` is that position in seconds (ms precision), `width`/`height` the frame's.

- [ ] **Step 1:** `video_screen_test.dart` with a fake `VideoPlayerPlatform` and a mocked `nb/frame` channel: the player is created with the proxy's URI; Mark up pauses; a drawn arrow and Save make a comment with `time` = the paused position, the frame's size, the shapes; a comment tick seeks to its time; a `frameAt` failure says so and adds nothing; leaving the screen closes the proxy (its `open` cancels). Expected: FAIL.
- [ ] **Step 2:** implement Dart and Kotlin. Expected: PASS. `flutter build apk --debug` succeeds.
- [ ] **Step 3:** commit `gh-90: video: play through the channel and mark a paused frame`.

### Task 6: Finish

- [ ] `mobile/README.md`: images and video (what opens, the proxy, the frame grab).
- [ ] `flutter analyze`, `dart format --set-exit-if-changed`, `flutter test` (app and channel), `npm test`, `npm run gen:protocol -- --check`; each gated on its exit code, one at a time.
- [ ] Commit `gh-90: docs for media on the phone`; push; draft PR into `remote`.
