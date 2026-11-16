/**
 * An edit: a `*.nbcut.json` file in the project, the only state of the video editor (epic #406). The user edits it on the
 * timeline, the agent writes it as JSON, and the export renders it through ffmpeg. Times are seconds; sizes are pixels.
 */
export type Cut = {
  version: 1;
  /** the output frame: whole pixels from 16 to 8192, 1 to 120 frames a second */
  width: number;
  height: number;
  fps: number;
  /** video tracks in stacking order (a later one covers an earlier one), audio tracks in any order among them */
  tracks: CutTrack[];
  clips: CutClip[];
};

export type CutTrack = {
  /** unique within the edit */
  id: string;
  kind: 'video' | 'audio';
  name?: string;
  /** dB, default 0 */
  gain?: number;
  mute?: boolean;
  /** any solo track silences every audio of the tracks without solo */
  solo?: boolean;
  /** a video track's picture is not shown (its clips' sound still plays) */
  hidden?: boolean;
};

/**
 * Where a clip sits in the frame: fractions of the output frame, top-left origin. Absent: the whole frame. `x`, `y` are
 * 0..1 and `w`, `h` above 0 up to 1, but the box may run past the frame's right or bottom edge (`x + w > 1`): the part
 * outside is cropped.
 */
export type CutPlace = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1, default 1 */
  opacity?: number;
};

export type CutClip = {
  /** unique within the edit */
  id: string;
  /** a track id */
  track: string;
  /** a project-relative path, `/` separated; a video (VIDEO), sound (AUDIO) or photo (PHOTO; IMAGE is drawn as one) file by its extension */
  src: string;
  /** where the clip starts on the timeline */
  at: number;
  /** video and audio: the used part of the source, `in` defaults to 0 */
  in?: number;
  out?: number;
  /** a photo: how long it shows */
  dur?: number;
  /** the clip's sound (an audio clip, a video clip's own sound): dB, default 0 */
  gain?: number;
  /** the clip's own sound off */
  mute?: boolean;
  /**
   * fades, seconds from each end: the clip's sound, and on a video track its picture too (issue 431). The lowest video
   * track (the first in `tracks`) fades from and to black, an upper one fades its opacity over the tracks under it; the
   * same sum either way, since the frame under every track is black. No transitions between clips.
   */
  fadeIn?: number;
  fadeOut?: number;
  /** a clip on a video track: its frame; the picture fits inside keeping its aspect ratio */
  place?: CutPlace;
};

/** A source's waveform (issue 431, `GET /cut/peaks`): this many peaks a second, each the loudest sample there as 0..255. */
export const CUT_PEAKS_RATE = 100;

/** The edit's file name ending. */
export const CUT_EXT = '.nbcut.json';

export { AUDIO, clipLength, cutDuration, IMAGE, isCutPath, isPhotoSrc, PHOTO, validateCut, VIDEO, type CutCheck, type CutIssue } from './cutCheck.ts';

/**
 * A new edit's file name in a folder that has `names` (issue 426): `edit.nbcut.json`, else `edit 2.nbcut.json` and on, the
 * first free one; compared without case, since a folder on macOS or Windows takes `Edit` for `edit`.
 */
export function uniqueCutName(names: Iterable<string>): string {
  const have = new Set([...names].map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `edit${n === 1 ? '' : ` ${n}`}${CUT_EXT}`;
    if (!have.has(name)) return name;
  }
}
