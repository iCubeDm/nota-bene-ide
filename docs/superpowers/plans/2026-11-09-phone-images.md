# Phone images (#146) Implementation Plan

**Goal:** Images in the phone's chat: attach from camera, gallery or files and send with a message; see them in the user's bubbles; see images and videos the agent produced as cards in its replies; open them in a restyled viewer with markup, comment and share.

**Approach:** The server already takes images (`POST /attach` returns `{id, mediaType}`, `send.images: ImageRef[]`) and serves them (`GET /attach/<id>`, `/tmpimage`, `/file`). The phone gains a small native picker channel (no packages), a Dart port of the desktop's image preparation (`web/src/attachments/image.ts`, using the `image` package already in pubspec), draft attachments in the composer, and image-aware feed items. The existing image and video screens (`lib/files/`) are restyled, not rewritten.

**Spec:** `docs/superpowers/specs/2026-11-09-phone-ux-design.md` ("Images and video"). Global constraints of `2026-11-09-phone-layout.md` apply.

## Decisions

- No new packages and no new Android permissions: system photo picker, camera app and document picker through intents. Camera capture needs a `FileProvider`; if `androidx.core` is not on the classpath, use a minimal own `ContentProvider` writing to the app cache (the camera intent's thumbnail is not acceptable). Report which.
- Types png, jpeg, gif, webp only (as `/attach` takes); others are refused with a message.
- Preparation exactly as `web/src/attachments/image.ts` (long edge, PNG to JPEG threshold, quality): port its numbers, order and test cases. Runs in `Isolate.run` to avoid out-of-memory on a mid phone.
- Uploads start at once; Send waits for pending uploads (disabled with a spinner, as the desktop's `uploading`). A failed upload shows a red mark and blocks Send until removed. A refused send (busy/switching) or offline tab keeps the draft's images as it keeps its text. Image-only messages are sendable.
- `send.images` = drafts' refs then the comments' images (order as `web/src/comments/send.ts`).

## Design

- Picker channel `nb/pick`: `camera` (one image), `gallery` (up to 10; API 33+ `MediaStore.ACTION_PICK_IMAGES` with `EXTRA_PICK_IMAGES_MAX`, older `ACTION_GET_CONTENT` image/* multiple), `file` (`ACTION_OPEN_DOCUMENT` image/*). Each answers a list of `{bytes, mime, name}`, empty when cancelled; items over 40 MB are skipped and reported as `{skipped: name}`. Later `share` (bytes+mime, `ACTION_SEND` via the same provider). Dart: `PickedImage`, `PickSource {camera, gallery, file}`, `pickImages(source)` returning `(images, skipped)` (`lib/media/picker.dart`).
- Upload (`lib/media/attach.dart`): `prepareImage(bytes, mime)` throws `UnsupportedImage` for other types; `uploadImage(tab, prepared, label)` posts `/attach` through the window's http stream (`windowHttp(tab)` in `lib/files/image_screen.dart`, as `media/media_comment.dart` does); label as the desktop names pasted images.
- Composer (`chat/composer.dart`, `chat/attach_sheet.dart`): paperclip in the pill opens a sheet Camera / Gallery / File; thumbnails strip above; composer keeps `List<_Draft>` (bytes, upload future, `ImageRef`). ARB keys: `attachCamera`, `attachGallery`, `attachFile`, `attachRemove`, `attachFailed`, `attachUnsupported`, `attachTooLarge`.
- Feed: `UserItem.images` becomes `List<ImageRef>`. User bubble shows images in a grid above the text (1: full width, 2+: two columns), loaded from `GET /attach/<id>`, cached per id for the tab's life; tap opens the viewer with the message's images to swipe. Media cards (`chat/media_card.dart`): a tool line whose path is an image under the tab's `tmpDirs` or in the project shows a 16:9 cover card with file name; a project video shows a play-icon card, loaded only on tap (existing video screen). A missing file (404) shows "file is gone" (`fileNotFound`), no crash. Reuses `toolPath`, `projectFile`, temp-image detection.
- Viewer (`files/image_screen.dart`): black, gallery of the message's images with "2 / 3" counter, swipe down closes only at scale 1 (zoomed: pans), bottom actions Mark up, Comment (existing), Share.

## Files

New: `lib/media/{picker,attach}.dart`, `lib/chat/{attach_sheet,media_card}.dart`. Changed: `MainActivity.kt` (`dev/notabene/nb_app`), `chat/{composer,feed,chat_screen}.dart`, `files/image_screen.dart`, six ARB files. Tests: `picker`, `attach`, `composer_attach`, `feed_media`, `image_screen`.

Final check: the three Flutter checks and `flutter build apk --release`.
