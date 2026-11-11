# mobile/

The phone side of remote access (issue #63), in three Dart packages:

| Package | What |
|---|---|
| `protocol/` (`nb_protocol`) | the window protocol's types, generated from `shared/src/protocol.ts` by `npm run gen:protocol` |
| `channel/` (`nb_channel`) | the end-to-end channel of `server/src/remote/CHANNEL.md`: Noise IK, pairing values, relay admission, the stream mux |
| `app/` (`nb_app`) | the Android app (Flutter) |

## Checks

```sh
(cd mobile/channel && dart pub get && dart analyze --fatal-infos && dart test)   # includes the cross-language test
(cd mobile/app && flutter pub get && flutter analyze --fatal-infos && flutter test)
npm run mobile:assets && npx playwright test -c mobile/app/web_test/playwright.config.ts   # the app's Mermaid page
```

The cross-language test (`channel/test/cross_test.dart`, tag `cross`) runs `server/src/remote/crossHost.ts` with Node
and builds the Go relay, so it needs `node` (>=23.6) and `go` on PATH and `npm ci` done at the root. It uses a
temporary `NOTA_BENE_HOME` and free loopback ports.

Comments use the desktop's text anchors. `app/lib/comments/anchor.dart` builds the desktop's rendered text from the
Markdown, and `web/src/anchors/mobileParity.test.tsx` writes the desktop's text of `app/test/fixtures/md/*.md` to the
`.txt` beside each file (`UPDATE_FIXTURES=1`), which `app/test/anchor_test.dart` compares. The quick labels and the
batch strings in `app/lib/comments/strings.g.dart` come from `web/src` through `npm run gen:protocol`.

## Media on the phone

Images open from the file links in the chat. The screen reads them through the window's `/file` endpoint, and it
refuses images over 32 MiB.

Videos play through a loopback proxy (`app/lib/media/proxy.dart`): an HTTP server on 127.0.0.1 under a random token
that forwards the player's ranged requests over the encrypted channel. The app's manifest allows cleartext only to
127.0.0.1 (`app/android/app/src/main/res/xml/network_security_config.xml`).

Marking up a video pauses it. Android's MediaMetadataRetriever takes the exact paused frame (the `nb/frame` method
channel in `MainActivity`, `app/lib/media/frame.dart`).

Marks and comments are the desktop's media comments: the frame and layer are stored under `/marks/<id>/`, and the
agent's image goes to `/attach`. Page and 3D-model comments stay desktop-only.

## Usage on the phone

The agent menu's Usage item opens the host's usage report (`app/lib/usage/usage_screen.dart`), which reads `GET /usage`
and `POST /usage/reset` through the channel, like the desktop's Usage tab. Its words are the web's own: the strings
generator copies every `usage*` key of the English dictionary, in all six languages, into
`app/lib/comments/strings.g.dart`. The number formatters (`app/lib/usage/format.dart`) are pinned to the desktop's by
`web/src/usage/mobileFormat.test.ts`; dates are not pinned.

## Voice messages

The round button at the right of the message field is the microphone while there is nothing to send, and Send
otherwise (`app/lib/voice/`, `app/lib/chat/composer.dart`). Hold it: the phone records 16 kHz WAV (`nb/record` in
`MainActivity.kt`); let go to send, slide left to cancel, slide up to lock (then Stop leads to a preview with Delete
and Send). The recording is uploaded to the window (`POST /voice`, encrypted through the relay) and sent as a message
of its own (`send` with `voice`, never with text, images or comments, and, when the agent is busy, after the same "send now or after" question a typed send asks: Now sends it with `force`, a dismissed question leaves the recording in the preview, a retry always goes after).
The window stores the audio beside the attachments, transcribes it with its Whisper and gives the agent the text; the
bubble shows the wave, a play button (`nb/play` in `MainActivity.kt`, files cached by id) and the transcript, or why
there is none with Retry. A recording that cannot be uploaded stays as a bubble with Retry. A recording runs up to 10
minutes. The microphone permission is asked on first use.

The comment sheet records clips the same way: each is uploaded and transcribed (`POST /voice/<id>/text`) and the
comment's text for the agent carries the transcripts after what was typed. Voice needs a window that speaks protocol 14
or later; without Whisper the microphone opens a sheet that installs it or turns it on (`/dictation/install`,
`/dictation/on`) and follows the install to the end. The phone has no recognizer of its own.

## Panes and files

A chat is three panes, Files <- Chat -> Comments (`app/lib/chat/panes.dart`): on a narrow screen one at a time under the
header, with a strip of tabs and a swipe across the screen; from 840 dp side by side. Back on Files goes up a folder,
then, like back on Comments, to the chat. The Files pane (`app/lib/files/files_pane.dart`) reads the window's `/tree`,
`/complete` and `/file`: "This session" on top, then the project's folders and files; a file opens full screen, Markdown,
images and video as before and anything else as read-only text in the code view (the first 2 MiB; a binary or larger
file says so). A comment on a selection in it is anchored to the file with the desktop's text model of a code file. The
Comments pane (`app/lib/comments/comments_pane.dart`) lists the pending comments with Send and the sent ones by the
message they went with.

### Git in the Files pane

In a git repository (`/git-status` answers) the Files pane has tabs, Files, Changes and Log, like Telegram's chat folders
(`app/lib/files/git_pages.dart`). Changes is the working tree's changed files (`/vcs-diff`), Log the commits (`/vcs-log`)
with each commit's files (`/vcs-commit`). A file opens its unified diff full screen (`/vcs-file`, `/vcs-commit-file`;
`app/lib/files/diff_screen.dart`): both line numbers, added and removed lines tinted with the theme's tokens, no wrap,
pinch zoom, copy. A comment on a selection is anchored as the desktop's diff anchors it: the file's path (with the
commit's short hash for a commit's diff) and the text of the code rows, markers and numbers left out.

## The APK

A manual run of the Mobile workflow (`.github/workflows/mobile.yml`, Run workflow) builds it and uploads it as the
`nota-bene-android` artifact; on pull requests and pushes the workflow only checks the app, and only when `mobile/`,
`shared/` or the npm lockfile changed. Builds of this repository are
signed with the keystore in the repository secrets `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` (alias
`nota-bene`); without them (forks) the job builds a debug APK. A local build needs the Android SDK:
`npm run mobile:assets && (cd mobile/app && flutter build apk --debug)`.

`npm run mobile:assets` copies the web's own `mermaid.min.js` (MIT) into `app/assets/mermaid/` (git-ignored): the app
draws diagrams with the same version as the desktop.
