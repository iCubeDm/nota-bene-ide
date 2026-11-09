# Remote: Whisper on the host (#92, part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an optional, off-by-default Whisper on the host: Settings installs it (size shown first), then the phone's
microphone records, the host transcribes, the text lands in the same field.

**Architecture:** the runtime is transformers.js (`@huggingface/transformers`, onnxruntime-node) installed by
`npm install --prefix <NB home>/whisper` the way `server/src/runtime.ts` installs updates (lock, log, timeout, check);
the model is downloaded into `<NB home>/whisper/models`. The server never imports it statically: `transcribe.ts`
loads it from that prefix on first use. Routes under `/dictation`; the hello's capabilities say when it is ready. The
phone records 16 kHz mono 16-bit WAV through a new `nb/record` channel and posts it; without the capability, or with
the host offline, it uses part A's recognizer.

**Tech Stack:** Node/TypeScript server, React web Settings, Flutter + Kotlin `AudioRecord`.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` ("Whisper on the host"). The user chose
transformers.js over whisper.cpp for now (no compiler, no Python on the host); speed is to be watched.

## Global Constraints

- Off by default; nothing is downloaded until the user confirms in Settings with the size shown.
- Everything under the NB home (`stateBaseDir()`, `server/src/state.ts`): `<home>/whisper/`. Removing it is a
  Settings action; turning it off keeps the files.
- Pin exact versions: the npm package version and the model's Hugging Face revision are constants in one file.
- Audio only reaches the host; the agent gets text only. No audio is written to disk or logged.
- All six UI languages (web `web/src/i18n`, app ARB) with real translations.
- Tests on ports 4790–4795 only, temp `NOTA_BENE_HOME`; never `~/.nota-bene`, never 4777–4789. No test downloads
  anything: the installer's `spawn` and the model loader are injected.
- Public repo: neutral fixtures.

## Review Focus

1. Two installs at once (two Settings tabs, a double click) — one runs, the other sees `installing`.
2. A failed or interrupted install (network, timeout, killed server) leaves `failed`, never `ready` with half files;
   a restart does not report `installing` forever.
3. A malformed or oversize WAV, or a body that is not WAV, answers 400/413 and does not crash or hang the server.
4. Transcription while the model is loading the first time: requests wait for the one load, not load twice.
5. The phone with Whisper on but the host gone mid-recording says so and keeps the field as it was.

---

### Task 1: the installer and its routes

**Files:** Create `server/src/dictation/whisper.ts` (constants: package, version, model id, revision, approximate
download size in MB), `server/src/dictation/install.ts`, `server/src/dictation/routes.ts`; Modify
`server/src/prefs.ts` (`whisper?: boolean`), `server/src/server.ts` (spread the routes); Test
`server/src/dictation/install.test.ts`, `server/src/dictation/routes.test.ts`.

**Interfaces — Produces:**
- `whisperDir(): string` = `<stateBaseDir()>/whisper`; `whisperPhase(): 'none'|'installing'|'ready'|'failed'`.
- `installWhisper(o?: { spawn?, npm?, fetchModel? }): Promise<void>` — lock file, `npm install --prefix <dir>
  @huggingface/transformers@<version> --no-audit --no-fund`, then `fetchModel` (default: load the pipeline once with
  `cacheDir` = `<dir>/models`, which downloads it), then writes `<dir>/ready.json` `{version, model, revision}`.
  `ready` = that file matches the constants; a stale lock older than the timeout is `failed`.
- Routes: `GET /dictation` → `{ on: boolean, phase, sizeMb, model }`; `POST /dictation/install` (202, starts once;
  409 while installing); `POST /dictation/on` `{on: boolean}` (on only when ready, else 409); `POST
  /dictation/remove` (deletes `whisperDir()` only; refused while installing).

- [ ] Verify the pins first (read-only): `npm view @huggingface/transformers version`, and the model id and a
  revision sha via the Hugging Face API (`https://huggingface.co/api/models/<id>`). Choose a multilingual Whisper
  ONNX model (`onnx-community/whisper-small` preferred; `whisper-base` if small exceeds ~500 MB download). Record the
  choice and size estimate as a ruling.
- [ ] Tests first (injected spawn/fetchModel, temp `NOTA_BENE_HOME`): phases none → installing → ready; a failing npm
  → failed and no `ready.json`; a second install while one runs → 409; `on` before ready → 409; remove while
  installing → 409; `GET` shape. See them fail, then implement mirroring `runtime.ts`.
- [ ] `npm test -w server -- dictation`; `npx tsc -b`.
- [ ] Commit `gh-92: Whisper installer on the host`.

### Task 2: transcription and the capability

**Files:** Create `server/src/dictation/wav.ts`, `server/src/dictation/transcribe.ts`; Modify
`server/src/dictation/routes.ts` (`POST /dictation/transcribe?lang=<code>`), `shared/src/protocol.ts`
(`Capabilities.dictation?: 'whisper'`), `server/src/server.ts` (set it in hello when on and ready), regenerate
`mobile/protocol` (`npm run gen:protocol`); Test `wav.test.ts`, `transcribe.test.ts`, routes test additions.

**Interfaces — Produces:**
- `pcmFromWav(buf: Buffer): Float32Array` — RIFF/WAVE, PCM format 1, mono, 16 000 Hz, 16-bit; anything else throws
  `WavError`.
- `transcribe(pcm: Float32Array, lang: string, o?: { load? }): Promise<string>` — one cached pipeline promise
  (`automatic-speech-recognition`) loaded from `whisperDir()` via `createRequire`/`import()` of the installed package;
  `language` from `lang`, `task: 'transcribe'`; trimmed text.
- Route: 503 when not on/ready; 415 when content-type is not `audio/wav`; 400 on `WavError`; 413 over 4 MiB (two
  minutes of audio); 200 `{ text }`. Requests run one at a time (a queue), no audio kept.

- [ ] Tests first: WAV parse of a generated fixture (sine, 0.5 s) and four rejects; `transcribe` with an injected
  loader: two concurrent calls load once, `lang` passed; route codes above; hello carries `dictation: 'whisper'`
  only when on and ready. See them fail.
- [ ] `npm test -w server -- dictation`; `npx tsc -b`; `npm run gen:protocol -- --check` after regenerating.
- [ ] Commit `gh-92: transcription on the host`.

### Task 3: the Settings section

**Files:** Modify `web/src/settings/SettingsView.tsx`, `web/src/i18n/*.ts` (six); Test `SettingsView.test.tsx`.

- [ ] A "Dictation on the phone" section: phase `none` → a button "Install Whisper (≈ N MB)" that asks first
  (confirm text names the size and `~/.nota-bene/whisper`); `installing` → a spinner line, polled every 2 s;
  `failed` → the error line and Retry; `ready` → a checkbox "Use Whisper for the phone's microphone" and a Remove
  button (asks first). Strings in all six languages.
- [ ] Tests first for each phase and that install posts only after the confirm. `npm test -w web -- Settings`;
  `npx tsc -b`; `npm run build -w web`.
- [ ] Commit `gh-92: Whisper in Settings`.

### Task 4: recording on the phone

**Files:** Modify `MainActivity.kt` (`nb/record`: `start`, `stop` → WAV bytes, `cancel`; `AudioRecord` 16 kHz mono
PCM16, the same RECORD_AUDIO request as `nb/speech`, a 2-minute cap that stops itself); Create
`mobile/app/lib/dictation/host_dictation.dart` (`HostDictation implements Dictation`: `listen` starts recording,
`stop` posts `audio/wav` to `/dictation/transcribe?lang=<ui>` through `windowHttp(tab)` and emits `DictationFinal`
then `DictationEnd`; errors → `DictationError(failed)` or a new `DictationFailure.hostFailed`); Modify `mic_button.dart`
(take a `Dictation Function()?` chooser; composer passes host dictation when `tab.capabilities?.dictation == 'whisper'`
and the tab is open, else the phone's), the six ARB files (`dictationTranscribing` "Transcribing…",
`dictationHostFailed` "The computer could not transcribe it"); Test `test/host_dictation_test.dart`, mic button additions.

- [ ] Tests first: host dictation posts the recorder's bytes with `content-type: audio/wav` and the UI language; 200 →
  the text at the cursor; 503/offline → `dictationHostFailed`, field unchanged; while posting the button shows a
  spinner with tooltip `dictationTranscribing` and ignores taps; without the capability the phone's recognizer is used.
- [ ] `flutter test`; `dart format lib test && flutter analyze`; `flutter build apk --debug`.
- [ ] Commit `gh-92: the phone records for Whisper on the host`.

### Task 5: Finish

- [ ] `docs/guide.md` (Settings → Dictation on the phone) and `mobile/README.md` (the Dictation section: Whisper on the
  host when on).
- [ ] Gated one at a time: `npm test`, `npx tsc -b`, `npm run gen:protocol -- --check`, `npm run build -w web`,
  `flutter test` (app, channel), `flutter analyze`, `flutter build apk --debug`.
- [ ] Real smoke (only with the user's yes for the download): temp `NOTA_BENE_HOME`, port 4790, install from Settings,
  transcribe a short WAV of speech via `curl` with the window's key, note the time taken.
- [ ] Commit `gh-92: docs for Whisper on the host`; push; draft PR into `remote`.
