/**
 * An edit: a `*.nbcut.json` file in the project, the only state of the video editor (epic #406). The user edits it on the
 * timeline, the agent writes it as JSON, and the export renders it through ffmpeg. Times are seconds; sizes are pixels.
 */
export type Cut = {
  version: 1;
  /** the output frame */
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

/** Where a clip sits in the frame: fractions of the output frame, top-left origin. Absent: the whole frame. */
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
  /** a project-relative path, `/` separated; a photo by its extension (IMAGE in web/src/files/kinds.ts) */
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
  /** the clip's sound fades, seconds from each end; the picture never fades (no transitions) */
  fadeIn?: number;
  fadeOut?: number;
  /** a clip on a video track: its frame; the picture fits inside keeping its aspect ratio */
  place?: CutPlace;
};

/** The edit's file name ending. */
export const CUT_EXT = '.nbcut.json';

export { clipLength, cutDuration, IMAGE, isPhotoSrc, validateCut, type CutCheck, type CutIssue } from './cutCheck.ts';
