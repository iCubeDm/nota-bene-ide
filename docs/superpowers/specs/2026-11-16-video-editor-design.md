# Video editor in the window (epic 406)

A simple editor for video, photos and sound inside the window, so voice, voice-over and music can be mixed precisely
without an outside editor. Agreed with the user; the sub-issues are 407 to 412.

## Intent

- An edit is a JSON file in the project (`*.nbcut.json`, types in `shared/src/cut.ts`). The agent can build a rough cut
  from a request ("cut these clips to the music, 60 s"), the user fixes it on the timeline or comments a moment, the
  agent edits again. No other editor works this way.
- Sound is precise: waveforms, clip gain in dB, fades, track gain, mute and solo.

## Non-goals for the first version

Transitions, titles and text, colour correction, effects, speed changes, animated position or size. Proxies for heavy
4K files come later if the preview is slow. No editor on the phone (an exported file plays there already).

## Approaches

Export through ffmpeg on the machine (chosen by the user: reliable, fast, reads any source including HEVC, a few days of
work; needs ffmpeg installed) versus encoding in the browser with WebCodecs (nothing to install, but several times the
code, weaker in Safari and Firefox, some sources unreadable).

## Decisions

- Any number of video and audio tracks. Within a track clips do not overlap. Video tracks stack in their order in
  `tracks`, a later one over an earlier one; a clip on a video track has a fixed placement (`place`: position and size as
  fractions of the frame, opacity) and its picture fits inside it keeping the aspect ratio. Absent: the whole frame.
- A video clip's own sound belongs to the clip (gain, mute, fades). Audio tracks mix; `solo` on any track silences the
  others.
- A clip's length: `out - in` for video and audio, `dur` for a photo. Fades act on the clip's sound, and on a video
  track on its picture too (issue 431): from and to black on the lowest video track, over the tracks under it on an upper
  one. No transitions between clips.
- The file is the only state: saved as the user edits, undo and redo in the editor, an outside change (the agent's)
  reloads it.
- Preview in the browser: one clock; per video track the clip in view follows it and the next one is preloaded; photos
  are images; every sound goes through Web Audio gain nodes.
- Export: the server builds the ffmpeg arguments from the edit (a pure function), runs ffmpeg with an argument list
  (never a shell), reports progress, can be cancelled, and writes `exports/<name>.mp4` (H.264/AAC at the edit's size and
  frame rate) or the sound mix alone (`.wav`, `.m4a`) into the project. `<name>` is the edit's file name without
  `.nbcut.json`. Without ffmpeg the editor works and Export explains how to install it.
- Every new string in all 6 UI languages.

## Left to the builder

The timeline's look, keyboard shortcuts beyond the media player's, the ffmpeg search order, how thumbnails and waveform
peaks are cached.
