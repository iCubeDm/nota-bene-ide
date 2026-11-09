# Phone images (#146) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Images in the phone's chat: attach from camera, gallery or files and send them with a message; see them in the user's bubbles; see images and videos the agent produced as cards in its replies; open them in a restyled viewer with markup, comment and share.

**Architecture:** The server already takes images (`POST /attach` → `{id, mediaType}`, `send.images: ImageRef[]`) and serves them (`GET /attach/<id>`, `/tmpimage`, `/file`). The phone gains a small native picker channel (no packages), a Dart port of the desktop's image preparation (`web/src/attachments/image.ts`, with the `image` package already in pubspec), draft attachments in the composer, and image-aware feed items. The existing image and video screens (`lib/files/`) are restyled, not rewritten.

**Tech Stack:** Kotlin (MainActivity), Flutter 3.47.9, `image` 4.x (already a dependency), flutter_test.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Images and video").

## Global Constraints

- The Global Constraints of `docs/superpowers/plans/2026-11-09-phone-layout.md` apply, with `gh-146:` commits.
- No new packages. No new Android permissions: the system photo picker, camera app and document picker are used through intents. A camera capture needs a `FileProvider`; if `androidx.core` is not on the app's classpath already, use the camera intent's returned thumbnail is NOT acceptable — instead write to the app's cache through a minimal `ContentProvider` of our own; report which.
- Image types png, jpeg, gif, webp only (as `/attach` takes); others are refused with a message.
- Preparation exactly as `web/src/attachments/image.ts` (long edge, PNG→JPEG threshold, quality): read it and port its numbers and order, with its tests' cases.
- Branch `gh-146-images`, cut from `gh-145-voice`, in `/Users/icubedm/Documents/Projects/ai-ide-phone`.

## Review Focus

- A 12 MP camera photo: scaled to the desktop's long edge before upload, upload under `/attach`'s cap, no out-of-memory on a mid phone (decode in an isolate).
- Send refused (busy/switching) or the tab offline: the draft keeps its images, as it keeps its text.
- An image-only message (no text): sendable, as on the desktop.
- A `/tmp` image the agent deleted: the card says it is gone, no crash.
- Swipe down on a zoomed image: pans, does not close; at scale 1 it closes.

---

### Task 1: The picker channel

**Files:**
- Modify: `mobile/app/android/app/src/main/kotlin/dev/notabene/nb_app/MainActivity.kt` (+ manifest/xml only if the provider needs it)
- Create: `mobile/app/lib/media/picker.dart`
- Test: `mobile/app/test/picker_test.dart`

**Interfaces:**
- Native `nb/pick` method channel: `camera` → one image; `gallery` → up to 10 images (API 33+: `MediaStore.ACTION_PICK_IMAGES` with `EXTRA_PICK_IMAGES_MAX`; older: `ACTION_GET_CONTENT` image/* with `EXTRA_ALLOW_MULTIPLE`); `file` → `ACTION_OPEN_DOCUMENT` image/*. Each answers a list of `{bytes: Uint8List, mime: String, name: String}`, or an empty list when cancelled; an item over 40 MB is skipped and reported as `{skipped: name}`.
- Dart: `class PickedImage { final Uint8List bytes; final String mime; final String name; }`, `enum PickSource { camera, gallery, file }`, `Future<({List<PickedImage> images, List<String> skipped})> pickImages(PickSource s)`.

- [ ] **Step 1: Failing Dart tests** with the mocked channel: the method name per source; decoding of items; cancel → empty; skipped names surfaced.
- [ ] **Step 2: FAIL.** - [ ] **Step 3: Implement** Dart then Kotlin (`onActivityResult`, request codes, reading `contentResolver.openInputStream`). - [ ] **Step 4: PASS; `flutter build apk --debug` exit 0.**
- [ ] **Step 5: Commit** `gh-146: camera, gallery and file pickers through the system`.

### Task 2: Prepare and upload

**Files:**
- Create: `mobile/app/lib/media/attach.dart`
- Test: `mobile/app/test/attach_test.dart`

**Interfaces:**
- `Future<Prepared> prepareImage(Uint8List bytes, String mime)` returning `{bytes, mime}` per the desktop's rules, run in `Isolate.run`; throws `UnsupportedImage` for other types.
- `Future<ImageRef> uploadImage(WindowTab tab, Prepared p, String label)`: `POST /attach` through the window's http stream (`windowHttp(tab)` in `lib/files/image_screen.dart`, as `media/media_comment.dart` posts); `label` as the desktop names pasted images (read `web/src/composer/` for the label format).

- [ ] **Step 1: Failing tests:** the desktop's `image.test.ts` cases ported (a large PNG over the threshold becomes JPEG, a large image is scaled to the long edge, a small one passes unchanged, gif passes unchanged as the desktop does or not — follow the web); upload sends the right content type and body and returns the server's id and type.
- [ ] **Step 2: FAIL.** - [ ] **Step 3: Implement.** - [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `gh-146: images prepared and uploaded as on the desktop`.

### Task 3: Attachments in the composer

**Files:**
- Modify: `mobile/app/lib/chat/composer.dart` (paperclip in the pill, thumbnails strip above it, images in `send`), the six ARB files
- Create: `mobile/app/lib/chat/attach_sheet.dart`
- Test: `mobile/app/test/composer_attach_test.dart`

**Interfaces:**
- Consumes: `pickImages`, `prepareImage`, `uploadImage`.
- The composer keeps `List<_Draft>` (local bytes for the thumbnail, upload future, resulting `ImageRef`). Uploads start at once; Send waits for pending uploads (send disabled with a spinner meanwhile, as the desktop's `uploading`); a failed upload shows a red mark on its thumbnail and blocks Send until removed. `send.images` = the drafts' refs then the comments' images (order as `web/src/comments/send.ts`). A refused send restores text and images.
- ARB keys: `attachCamera`, `attachGallery`, `attachFile`, `attachRemove`, `attachFailed`, `attachUnsupported`, `attachTooLarge`.

- [ ] **Step 1: Failing tests:** paperclip opens a sheet with Camera, Gallery, File; picking two images shows two thumbnails and uploads them; remove drops one; send with images and no text sends `images` with both refs; a refused send restores both; send is disabled while an upload is pending; an unsupported type shows `attachUnsupported`.
- [ ] **Step 2: FAIL.** - [ ] **Step 3: Implement.** - [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `gh-146: attach images to a message`.

### Task 4: Images in the feed

**Files:**
- Modify: `mobile/app/lib/chat/feed.dart` (`UserItem.images` becomes `List<ImageRef>`; keep a count getter if callers need it), `mobile/app/lib/chat/chat_screen.dart` (bubble images; media cards after tool lines)
- Create: `mobile/app/lib/chat/media_card.dart`
- Test: `mobile/app/test/feed_media_test.dart`

**Interfaces:**
- User bubble: images in a grid above the text (1: full width of the bubble, 2+: two columns), loaded from `GET /attach/<id>` through the http stream, cached per id in memory for the tab's life; tap opens the viewer on that image with the message's images to swipe through.
- Media cards: a tool line whose path is an image under the tab's `tmpDirs` (hello) or in the project shows an image card (16:9 cover, file name) under the line; a project video shows a card with a play icon and the file name, loaded only on tap (opens the existing video screen). A missing file shows the card with "file is gone" (existing `fileNotFound` string).
- Reuse `toolPath`, `projectFile` and the existing temp-image detection from `lib/chat/files.dart` / `chat_screen.dart`.

- [ ] **Step 1: Failing tests:** a replayed user event with two images shows two thumbnails fetched from `/attach/<id>`; a `Screenshot /tmp/x.png`-style tool line with a tmp dir in hello shows a card fetching `/tmpimage?path=`; a project `.mp4` tool path shows a video card that fetches nothing until tapped; a 404 shows the gone text.
- [ ] **Step 2: FAIL.** - [ ] **Step 3: Implement.** - [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `gh-146: images in bubbles and media cards in replies`.

### Task 5: The viewer, restyled

**Files:**
- Modify: `mobile/app/lib/files/image_screen.dart` (black, gallery of the message's images, swipe down to close at scale 1, bottom actions), `MainActivity.kt` (`nb/pick` gains `share` with bytes+mime → `ACTION_SEND` via the same provider as the camera), the six ARB files
- Test: `mobile/app/test/image_screen_test.dart`

- [ ] **Step 1: Failing tests:** opened with three images at index 1 shows "2 / 3" and swipes to the third; swipe down at scale 1 pops; bottom actions Mark up (existing markup), Comment (existing whole-image comment), Share (channel `share` called with the bytes).
- [ ] **Step 2: FAIL.** - [ ] **Step 3: Implement**; existing image_screen tests keep passing. - [ ] **Step 4: PASS; debug build exit 0.**
- [ ] **Step 5: Commit** `gh-146: the image viewer restyled, with share`.

### Task 6: Whole-app check and APK

- [ ] The three Flutter checks and `flutter build apk --release` → exit 0.
