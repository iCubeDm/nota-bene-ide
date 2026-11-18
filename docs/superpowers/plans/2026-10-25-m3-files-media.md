# M3 Files & Media Implementation Plan

**Goal:** The prototype's daily file and media workflow inside the rebuild: a tab strip (chat pinned first) with a context menu, a file tree, file tabs with viewers for md, code, image, video and audio (Range seeking), picture-in-picture without the prototype's loop, clickable project paths, `@` mentions, image attachments, comments on files, and read-only browsing of other branches and worktrees.

M3 is the first of three milestones (M3, M4, M5) that bring the rebuild to full prototype parity so the user can switch. M2 comes after M5 (spec, Milestones, Order).

**Architecture:**
- The server owns the file system and attachments. `/tree`, `/file` (Range) and `/complete` are scoped to the project root, symlinks included. Attachments are content-addressed blobs under `~/.nota-bene/attachments/`; only ids travel over the socket.
- The web adds a `tabs` slice. All open tabs stay mounted and inactive ones are only hidden, so media keeps playing and the chat keeps its scroll. Each pane has its own highlight layer; comments are matched to a pane by their `AnchorSource`.

**Stack:** as M1. No new dependencies (the context menu is `radix-ui`'s ContextMenu).

**Spec:** `docs/superpowers/specs/2026-10-24-nota-bene-rebuild-design.md`: Parity checklist (Files & media), tab strip and context menu items (Agents & tasks), Follow-ups (media and PiP loop), Server (Range). Base: branch `m3-files` from `main`.

## Constraints

- M0 and M1 rules hold (task trailer `Task: M3-NN`, all strings via `t()` in ru and en, no state in the repo, `prototype/` untouched except bug fixes).
- Server binds 127.0.0.1; every route checks Host; every non-GET route also requires an allowed `Origin` (403 otherwise), new for `POST /attach` (the prototype's `originOk`).
- Ports: 4790 manual smoke, 4791-4793 e2e, never 4777-4781 (live windows).
- Copied from the prototype verbatim:
  - `VIDEO = /\.(mp4|mov|webm|m4v)$/i`, `AUDIO = /\.(mp3|wav|m4a|ogg)$/i`, `IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i`
  - `AT_RE = /(^|\s)@("[^"]*|[^\s"]*)$/`
  - `isPath(p) = !/^(https?:|~|\/)/.test(p) && !/[\n`<>|*]/.test(p) && (/\//.test(p) || /\.[a-z0-9]{1,5}$/i.test(p))`
  - `IMG_OK = ['image/png','image/jpeg','image/gif','image/webp']`, `IMG_EDGE = 1568`, `IMG_BYTES = 3.5e6`
  - Tree hides `.git`, `node_modules`, `.DS_Store`; folders first, then `localeCompare(b, 'ru', {numeric: true})`; `/complete` returns at most 30 paths.
  - i18n keys `noFile`, `imgLabel(k)`, `imgLabelC(k, ci)`, `imgRef(ks)`, `atNone`, `onlyImages`, `imgFail` with the prototype's ru and en texts.
- Text files over 2 MB, or with a NUL in the first 8 KB, are not rendered: a note and a raw link instead.
- An attachment is at most 5 MB (413 above) and its type must be in `IMG_OK` (415 otherwise).

## Review focus (each has a test)

1. Non-ASCII and unusual names (Cyrillic, spaces, `#`, `%`, `?`) survive `/tree`, `/file` with Range, tabs, refs, `@` picks and file comments (M3-02; e2e M3-14 with `Отчёт #1 (final).md`).
2. Escaping the root: `..`, absolute paths, encoded `%2e%2e`, and a symlink pointing outside all get 403 and are never listed or served (M3-02).
3. Huge and binary files: a 1 GB video seeks by Range without being read whole; a 50 MB log or binary opens as a note with a raw link and never enters the DOM; `bytes=<size>-` returns 416 (the prototype's crash) (M3-02, M3-08).
4. A file that changes or disappears while its tab is open: the tab reloads after the live turn ends; anchors re-resolve or orphan, never mark wrong text; a deleted file shows `t('fileGone')` and the tab stays (M3-08, M3-13).
5. Several media tabs: exactly one medium plays, no PiP loop; leaving a playing video for a non-media tab uses PiP; switching between media tabs pauses the previous; closing stops the medium; the chat keeps its scroll (M3-09; e2e play A, open B, open C).

## Files

```
shared/src/protocol.ts          + ImageRef, send.images, user.images, Comment.images
server/src/files.ts             resolveInRoot, listDir, listFiles (cached walk)
server/src/range.ts             parseRange (RFC 9110 single range)
server/src/fileRoutes.ts        GET /tree, GET|HEAD /file, GET /complete
server/src/fuzzy.ts             fuzzyScore
server/src/attachments.ts       AttachmentStore + POST /attach, GET /attach/<id>
server/src/agent/*, transcript.ts, http.ts, server.ts   images, fileSuggestions, routes, Origin check
server/src/git.ts               sources: checkout, worktrees, branches
web/src/tabs/{slice,TabStrip,Panes}.tsx
web/src/files/{FileTree,FileView,kinds,SourcePicker}.tsx
web/src/media/mediaController.ts
web/src/refs/refs.ts            composer/MentionPicker.tsx
web/src/attachments/{image.ts,Attachments.tsx}
e2e/files.spec.ts, e2e/fixtures/project/
```

## Contracts

Protocol:
```ts
IMAGE_TYPES = ['image/png','image/jpeg','image/gif','image/webp']
ImageRef = { id: string /* sha256 hex, 64 */; mediaType: ImageType; label: string }
// send and user events gain images?: ImageRef[]; Comment gains images?: string[] (attachment ids; labels assigned at send)
TreeEntry = { name: string; dir: boolean }
```
A bad id or type rejects the whole send; unknown keys on a ref are dropped; non-hex comment image ids are rejected.

Files and routes (server):
- `resolveInRoot(root, rel)`: null when outside, including via symlink (realpath of the deepest existing ancestor must stay inside realpath(root)). `listDir`, `listFiles` (relative, `/`-separated, skips `.git`/`node_modules`, cap 20 000, cached 10 s).
- `parseRange(header, size)`: `{start,end}` | `'unsatisfiable'` | null (serve whole). `bytes=0-99`, `100-`, `-50`; end clamped; `bytes=<size>-` and `5-2` unsatisfiable; multi-range or garbage gives null.
- `GET /tree?path=` gives `TreeEntry[]` (missing folder 404 with `[]`, outside 403). `GET|HEAD /file?path=` gives 200 with `Accept-Ranges: bytes` or 206 with `Content-Range`; 416 with `Content-Range: bytes */<size>`; 404 missing; 403 outside. Types from the prototype `MIME` table, default `application/octet-stream`, known text extensions as `text/plain; charset=utf-8`. A stream error ends only that response via `reportError`.
- Origin rule lives in `httpHandler`: any method other than GET/HEAD needs `allowedOrigins.includes(origin)`, passed like `allowedHosts`.

Attachments:
- `AttachmentStore({dir})`: `put(bytes, mediaType)` returns sha256 hex, atomic write only if absent; `get(id)` requires `/^[0-9a-f]{64}$/`.
- `POST /attach`: raw body, content-type in `IMAGE_TYPES`, returns `{id, mediaType}`; over 5 MB gives 413 (stop reading at the cap), unknown type 415. `GET /attach/<id>`: bytes with `cache-control: private, max-age=31536000, immutable`, 404 unknown; http.ts matches `/attach/` with `startsWith`.
- `AgentSession.send` takes `images?: {mediaType, data(base64), label}[]`; SDK content is the prototype's `toContent` (text block, then label text plus image block per image). `SessionManager.send({id, text, force?, images?: ImageRef[]})`; the user event carries refs, never base64. An unknown ref id gives `server-error` (`where: 'attach'`) and the message still goes out without that image.
- Fake agent: a turn may set `echoImages: true`, the reply ends with `images: <n>`.
- Transcript: base64 image blocks in a user message are `put` into the store; the user event gets `ImageRef`s (label = preceding text block if label-like, else `[image]`; label blocks removed from bubble text).

`@` completion:
- `fuzzyScore(path, q)` (prototype `fuzzy`, -1 = no match; a file-name hit ranks higher).
- `AgentSession.fileSuggestions(query)`: sdk uses `q.request({subtype:'file_suggestions', query})` (internal API, cast); fake returns the script's `suggestions` or `[]`.
- `complete({session, root}, raw)`: CLI hits (minus the query itself, max 30); when none and q non-empty, `listFiles` + `fuzzyScore`, sorted, max 30. The CLI index is warmed 2 s after start with `fileSuggestions('')`, failures ignored.

Tabs (`web/src/tabs/slice.ts`):
```ts
Tab = { id:'chat'; kind:'chat' } | { id:`file:${string}`; kind:'file'; path }   // open[0] is always the chat
actions: openFile, activate, closeTab (chat no-op; closing the active one activates its left neighbour), closeOthers, closeRight, closeAll (keeps chat)
persistence: localStorage `tabs:<root>` = {paths, active}, restored when session.root first arrives; extends the single store.subscribe persistence
```
- `TabStrip` below the header: icon, name (basename; chat shows `t('chat')`), close button (none on chat), pending-comment badge, `▶` dot via `data-playing`. Middle click closes. radix ContextMenu: Close, Close Others, Close Right, Close All, plus Copy Path and Reveal in Tree on file tabs; the chat offers only Close Others and Close All. `Panes` renders `<main data-chat-pane data-pane="chat">` and one `FileView` per file tab, all mounted, inactive `hidden`. `revealInTree` thunk emits `tree/reveal`.

Tree (`FileTree`): left overlay sheet 300 px with filter input, spinning refresh button, lazy folders via `/tree?path=`; open folders persisted in `localStorage tree:<root>`; filter hides non-matching loaded file rows but keeps folders (prototype `applyFilter`); per-file pending-comment badge; refreshes when `turnSeq` changes (counter in `feed.ts`, incremented on a live `result`, not on replay) keeping open folders and scroll; `tree/reveal` expands all ancestors; load error shows `t('serverError','/tree')` inline.

Viewers (`kinds.ts`, `FileView`): `kindOf`, `fileUrl(p, baseDir?)` (moved from Markdown.tsx), `isPath`. md renders with `Markdown` (`final`, `baseDir`); image fitted, click toggles 100%; video `<video controls preload="metadata">`, audio `<audio controls>`; text highlighted by extension with auto-detect fallback, no wrap. Text guard: HEAD first; over 2 MB or `\0` in a `Range: bytes=0-8191` probe shows `t('tooLarge')` or `t('binary')` with a raw link. 404 shows `t('fileGone')`, tab stays. Root has `data-file-path` and `data-pane`. Reload: on `turnSeq` change an active view refetches at once, an inactive one when next activated; a toolbar refresh reloads manually.

Media (`MediaController({pip, activate})`: `register`, `onSwitch(from,to)`, `onClose`, `playing`; `PipApi = {request, exit, current}`). Rules:
- Media to media: never PiP, the previous medium pauses.
- Playing video to a non-media tab: request PiP; at most one PiP window (exit any other first).
- Audio keeps playing when leaving its tab.
- PiP "back to tab" (`leavepictureinpicture` while not ended) calls only `activate(itsTab)`; a guard ignores the event fired by our own `exit()`.
- Closing a tab pauses its medium and exits PiP.

Paths and mentions (`refs.ts`): `markRefs(root, baseDir?)` marks inline `code` (not in `pre`) that passes `isPath`, and relative `<a href>` (not http(s), mailto, `#`), with class `ref` and normalised `data-path`. `splitMentions` uses the prototype's `/(^|\s)@("[^"]+"|[^\s"]+)/g`. `openRef` does HEAD `/file`; ok opens the tab, else adds `.missing` and `t('noFile')`. `.ref` dotted underline; `.missing` struck through. A click opens only with a collapsed selection, so commenting selections do not open files.

`MentionPicker` (`target` textarea ref): opens when `AT_RE` matches before the caret, queries `/complete?q=`, a sequence guard drops stale answers. Window-capture keys as in M1's ShortcodePicker: arrows move, Enter/Tab pick, Esc closes with `preventDefault`+`stopPropagation`. A pick inserts `@path ` or `@"path" ` when it has whitespace; a folder inserts no space and re-queries. Rows: kind icon, basename with matched characters marked, dimmed folder; empty shows `t('atNone')`; placed above the field if room. Used in Composer and CommentPopup.

Images (web): `prepareImage(file)` (prototype `readImage`: long edge at most `IMG_EDGE`, re-encode png, jpeg 0.9 if over `IMG_BYTES` or type not in `IMG_OK`), `uploadImage` (POST `/attach`), `Attachments` thumbnails, `Lightbox` (Esc/click closes, Esc `preventDefault`). Composer slice gains `images`, cleared with the draft. Paste/drop accept images only (`t('onlyImages')`, `t('imgFail')` in the connection flash spot). Labels: composer images `t('imgLabel',k)`, comment images `t('imgLabelC',k,ci)` appended after them, each comment line gets `t('imgRef',[k...])`. Images-only sends are allowed. Thumbnails use `/attach/<id>` in the composer, popup, card and sent bubble.

Comments on files: `SelectionButton` accepts `[data-file-path]` roots (source kind `file`) and listens to scroll on the active `[data-pane]`; `HighlightLayer({pane})` per pane paints only that pane's comments; jump-to-source on a file opens the tab then scrolls; orphan state follows the view's load state; `whereOf` for a file is its path; `selectPendingCountByPath` feeds tab and tree badges.

Branches and worktrees (M3-16, added beyond the prototype at the user's request on 2026-10-25, because they could not see what agents write on other branches). The window's own checkout is never switched (a live window may run from it).
```ts
// git.ts: every call is execFile('git', [...], {cwd: root}), never a shell
Source = { id; kind: 'checkout'|'worktree'|'branch'; label; ref; dir? }
// id: 'here' | 'wt:<n>' (git worktree list --porcelain order) | 'br:<name>' (local branches without a worktree)
listSources(root)  // only 'here' when not a git repo
readTree(root, src, rel)   // worktree: listDir in src.dir; branch: git ls-tree <ref> -- <rel>/
readFile(root, src, rel)   // branch: git show <ref>:<rel>, maxBuffer 50 MB
```
- `GET /sources`; `/tree`, `/file`, `/complete` accept `src=<id>`, which must come from the current `listSources` (else 400); raw paths never accepted. Worktrees use `resolveInRoot` with `src.dir` and support Range; branch files are served whole, no Range, 50 MB cap (413).
- Tab id becomes `file:${src}:${path}` (`src` default `here`) with a branch chip when not `here`. Non-`here` views are read-only and skip the `turnSeq` reload, except worktrees which do reload.
- Tree has a source picker on top with separate open folders per source. Refs: an absolute path inside any worktree `dir` opens from that source; a relative ref missing in `here` is tried in the worktrees, first hit wins.
- `AnchorSource` file gains `ref?: string` (the branch name when not `here`); the batch line reads `path @ branch`.

## Tests and wrap-up

- Unit tests per task as above, including: Range edge cases; traversal and symlink 403; Cyrillic names; dedupe of attachments, 413/415; send with two refs reaching the fake agent as text, label, image, label, image; transcript images replay; fuzzy ranking and CLI-then-walk fallback; tab invariants (chat never closes); media rules with stubbed PiP; a temp git repo with a worktree on `feature/x` and a branch `old` for sources.
- e2e (`e2e/files.spec.ts`, fixture project with `docs/Отчёт #1 (final).md`, `src/a.ts`, three tiny mp4, `s.mp3`, a generated 3 MB `big.log`, a `link-out` symlink to `/tmp`): tree to Cyrillic md with relative image and ref; context menu; video seek returns 206 and play A/B/C keeps PiP count 0; too-large note and 403 for the symlink; `@Отч` pick and mention opens the file; pasted PNG shows a thumbnail and the fake echoes `images: 1`; file comment in the batch frame survives reload; worktree picker with branch chip. Run green twice and with `--repeat-each=2`.
- Real-agent smoke on port 4790 via Chrome (real video, Cyrillic md, PiP, screenshot paste, `@` mention, file comment, restart with `--continue`, open a file from an agent-created worktree). Root `CLAUDE.md` documents `~/.nota-bene/attachments/` and the new routes. After final review, merge to `main` and tag `m3`.
