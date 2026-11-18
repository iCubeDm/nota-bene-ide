# Remote: Whisper on the host (#92, part B) Implementation Plan

**Goal:** An optional, off-by-default Whisper on the host: Settings installs it (size shown first), then the phone's microphone records, the host transcribes, the text lands in the same field.

**Approach:** The runtime is transformers.js (`@huggingface/transformers`, onnxruntime-node), installed by `npm install --prefix <NB home>/whisper` the way `server/src/runtime.ts` installs updates (lock, log, timeout, check); the model downloads into `<NB home>/whisper/models`. The server never imports it statically: `transcribe.ts` loads it from that prefix on first use. Routes under `/dictation`; hello capabilities say when it is ready. The phone records 16 kHz mono 16-bit WAV through a new `nb/record` channel and posts it; without the capability, or with the host offline, it uses part A's recognizer.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` ("Whisper on the host").

## Decisions

- transformers.js over whisper.cpp for now (no compiler, no Python on the host); speed to be watched.
- Off by default; nothing downloads until the user confirms in Settings with the size shown. Everything under `<stateBaseDir()>/whisper/`; Remove is a Settings action, turning off keeps files.
- Pins (package version, model's Hugging Face revision) are constants in one file. Multilingual Whisper ONNX model: `onnx-community/whisper-small` preferred, `whisper-base` if small exceeds about 500 MB. Verify versions read-only before pinning and record the choice and size.
- Audio reaches only the host; no audio written to disk or logged; the agent gets text only.
- Tests: ports 4790-4795, temp `NOTA_BENE_HOME`; none downloads anything (installer `spawn` and model loader injected).
- Failures: two installs at once give one running and the other `installing`; a failed or interrupted install leaves `failed`, never `ready` with half files; a stale lock past the timeout is `failed`; concurrent transcriptions share one model load; bad WAV answers 400/413 without crashing; a host gone mid-recording says so and keeps the field.

## Contracts

- `whisperDir()`, `whisperPhase(): 'none'|'installing'|'ready'|'failed'`. `installWhisper({spawn, npm, fetchModel})`: lock file, `npm install --prefix <dir> @huggingface/transformers@<version> --no-audit --no-fund`, load the pipeline once with `cacheDir = <dir>/models`, write `<dir>/ready.json` `{version, model, revision}`; ready = it matches the constants.
- Routes: `GET /dictation` returns `{on, phase, sizeMb, model}`; `POST /dictation/install` (202, once; 409 while installing); `POST /dictation/on {on}` (409 unless ready); `POST /dictation/remove` (deletes `whisperDir()` only; refused while installing); `POST /dictation/transcribe?lang=<code>`: 503 not on/ready, 415 not `audio/wav`, 400 `WavError`, 413 over 4 MiB (two minutes), 200 `{text}`; requests queued one at a time.
- `pcmFromWav(buf): Float32Array`: RIFF/WAVE PCM mono 16 000 Hz 16-bit, else `WavError`. `transcribe(pcm, lang, {load})`: one cached `automatic-speech-recognition` pipeline loaded from `whisperDir()`, `language` from `lang`, `task: 'transcribe'`, trimmed text.
- `Capabilities.dictation?: 'whisper'` in `shared/src/protocol.ts`, set in hello when on and ready; `npm run gen:protocol` regenerates `mobile/protocol`. `prefs.ts` gets `whisper?: boolean`.
- Settings section "Dictation on the phone" (`web/src/settings/SettingsView.tsx`, six i18n files): none gives "Install Whisper (about N MB)" with a confirm naming size and folder; installing shows a spinner polled every 2 s; failed shows error and Retry; ready shows a "Use Whisper" checkbox and Remove (asks first).
- Phone: Kotlin `nb/record` (`start`, `stop` returning WAV bytes, `cancel`; `AudioRecord` 16 kHz mono PCM16, same RECORD_AUDIO request as `nb/speech`, self-stops at 2 min). `HostDictation implements Dictation` (`lib/dictation/host_dictation.dart`): `stop` posts `audio/wav` to `/dictation/transcribe?lang=<ui>` via `windowHttp(tab)`, emits `DictationFinal` then `DictationEnd`; errors become `DictationError(failed)` or a new `hostFailed`. `mic_button.dart` takes a `Dictation Function()?` chooser; the composer picks host dictation when `capabilities.dictation == 'whisper'` and the tab is open. While posting the button shows a spinner (tooltip `dictationTranscribing`) and ignores taps. ARB: `dictationTranscribing`, `dictationHostFailed`.

## Files

`server/src/dictation/{whisper,install,routes,wav,transcribe}.ts` with tests, `server/src/{prefs,server}.ts`, `shared/src/protocol.ts`, `web/src/settings/SettingsView.tsx`, `web/src/i18n/*.ts`, `MainActivity.kt`, `lib/dictation/{host_dictation,mic_button}.dart`, six ARB files, `docs/guide.md`, `mobile/README.md`.

Final check (one at a time): `npm test`, `npx tsc -b`, `npm run gen:protocol -- --check`, `npm run build -w web`, Flutter tests/analyze/debug build. Real smoke only with the user's yes for the download (temp home, port 4790, time the transcription). Commits `gh-92: ...`; draft PR into `remote`.
