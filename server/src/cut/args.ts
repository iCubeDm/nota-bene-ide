// The ffmpeg command of an export (epic 406): a pure function of the edit, its resolved sources and the output.
import { clipLength, isPhotoSrc, type Cut, type CutTrack } from '@nota-bene/shared/cut';

export type ExportMode = 'mp4' | 'wav' | 'm4a';
export const EXPORT_MODES: readonly ExportMode[] = ['mp4', 'wav', 'm4a'];

/** A clip's `src` resolved: the absolute file, and whether it has a picture and a sound stream (asked of ffmpeg before the export; a photo is a picture). */
export type Sources = ReadonlyMap<string, { file: string; video: boolean; audio: boolean }>;

/** ffmpeg reads AVIF through its mp4/mov reader, not image2: no `-loop` there, so the still is looped as a stream and cut in the graph. */
const isAvif = (src: string): boolean => /\.avif$/i.test(src);

/** A frame side as H.264 in yuv420p takes it: an even integer, 2 at least. */
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Where the edit ends: the end of its last clip (0 without clips). The export is this long. */
export const cutEnd = (cut: Cut): number => num(Math.max(0, ...cut.clips.map((c) => c.at + clipLength(c))));

/** A number as ffmpeg reads it, without float noise (0.1 + 0.2 is 0.3). */
const num = (n: number): number => Math.round(n * 1e6) / 1e6;
const s = (n: number): string => String(num(n));

const RATE = 48000;
const AUDIO_FMT = `aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

/**
 * The ffmpeg arguments that render `cut` into `output` (no shell ever sees them: paths are arguments, the filter graph
 * holds only numbers). One input per clip that is seen or heard, trimmed at the input (`-ss in -t len`; a photo loops for
 * its `dur`). The picture: a black frame of the edit's size and rate for the whole length, then every clip of a shown video
 * track overlaid, the tracks in their order in `tracks` (a later one covers an earlier one) and a track's clips by time,
 * a source without a picture adds only its sound; each picture scaled to fit its `place` (or the whole frame) keeping its aspect ratio, centred there, at its opacity, from its `at`,
 * fading with the clip's fades (issue 431): `fade` to black on the lowest video track (the first in `tracks`), the alpha
 * (`alpha=1`) on an upper one, so it fades to what is under it. Over the black frame both are the preview's layer opacity.
 * The sound: silence of the whole length mixed (summed, not averaged) with every audible clip's sound, a video clip's own
 * included when its source has one: clip gain + track gain in dB, the fades, delayed to its `at`. A clip is audible unless
 * it or its track is muted, or another track has solo and its own has not. A reversed clip (issue 492) runs its trimmed
 * part backwards: `reverse` and `areverse` first in its chains, so its fades stay at its ends on the timeline. Gaps are
 * black and silent.
 * mp4: H.264 (yuv420p) and AAC; wav: 16-bit PCM; m4a: AAC. `-progress pipe:1` reports on stdout; errors go to stderr.
 */
export function exportArgs(cut: Cut, sources: Sources, output: string, mode: ExportMode): string[] {
  const W = even(cut.width);
  const H = even(cut.height);
  const fps = s(cut.fps);
  const end = s(cutEnd(cut));
  const tracks = new Map(cut.tracks.map((t) => [t.id, t]));
  const solo = cut.tracks.some((t) => t.solo);
  const audible = (t: CutTrack) => !t.mute && (!solo || t.solo === true);
  const order = new Map(cut.tracks.map((t, i) => [t.id, i]));
  // the lowest video track's fades go to black; an upper one's fade its alpha over the tracks under it (issue 431)
  const lowest = cut.tracks.find((t) => t.kind === 'video')?.id;
  // the stacking order: tracks as listed, a track's clips by time
  const clips = cut.clips
    .filter((c) => tracks.has(c.track))
    .sort((a, b) => order.get(a.track)! - order.get(b.track)! || a.at - b.at);

  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  const pictures: string[] = [];
  const sounds: string[] = [];
  let last = 'v0';
  let input = 0;
  for (const c of clips) {
    const track = tracks.get(c.track)!;
    const src = sources.get(c.src);
    if (!src) continue;
    const len = clipLength(c);
    // a source without a picture (a video file with no picture stream) contributes only its sound
    const seen = mode === 'mp4' && track.kind === 'video' && !track.hidden && src.video;
    const heard = !isPhotoSrc(c.src) && src.audio && !c.mute && audible(track);
    if (!seen && !heard) continue;
    const k = input++;
    // a photo is one image: image2 without patterns, so a `%d` in its name is no numbered sequence
    if (isAvif(c.src)) args.push('-stream_loop', '-1', '-t', s(len), '-i', src.file);
    else if (isPhotoSrc(c.src)) args.push('-f', 'image2', '-pattern_type', 'none', '-loop', '1', '-framerate', fps, '-t', s(len), '-i', src.file);
    else args.push(...((c.in ?? 0) > 0 ? ['-ss', s(c.in!)] : []), '-t', s(len), '-i', src.file);
    if (seen) {
      const n = pictures.length / 2 + 1;
      const p = c.place;
      const box = p
        ? { x: Math.round(p.x * W), y: Math.round(p.y * H), w: Math.round(p.w * W), h: Math.round(p.h * H) }
        : { x: 0, y: 0, w: W, h: H };
      const opacity = p?.opacity ?? 1;
      const alpha = c.track === lowest ? '' : ':alpha=1';
      const fades = [
        ...((c.fadeIn ?? 0) > 0 ? [`,fade=t=in:st=${s(c.at)}:d=${s(c.fadeIn!)}${alpha}`] : []),
        ...((c.fadeOut ?? 0) > 0 ? [`,fade=t=out:st=${s(Math.max(c.at, c.at + len - c.fadeOut!))}:d=${s(c.fadeOut!)}${alpha}`] : []),
      ].join('');
      pictures.push(
        `[${k}:v]${c.reverse ? 'reverse,' : ''}${isAvif(c.src) ? `fps=${fps},trim=duration=${s(len)},` : ''}scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease,setsar=1,format=yuva420p` +
          `${opacity < 1 ? `,colorchannelmixer=aa=${s(opacity)}` : ''},setpts=PTS-STARTPTS+${s(c.at)}/TB,fps=${fps}${fades}[p${n}]`,
        `[${last}][p${n}]overlay=x=${box.x}+(${box.w}-w)/2:y=${box.y}+(${box.h}-h)/2:eof_action=pass[v${n}]`,
      );
      last = `v${n}`;
    }
    if (heard) {
      const gain = num((c.gain ?? 0) + (track.gain ?? 0));
      const chain = [...(c.reverse ? ['areverse'] : []), 'asetpts=PTS-STARTPTS', AUDIO_FMT];
      if (gain !== 0) chain.push(`volume=${s(gain)}dB`);
      if ((c.fadeIn ?? 0) > 0) chain.push(`afade=t=in:st=0:d=${s(c.fadeIn!)}`);
      if ((c.fadeOut ?? 0) > 0) chain.push(`afade=t=out:st=${s(Math.max(0, len - c.fadeOut!))}:d=${s(c.fadeOut!)}`);
      if (c.at > 0) chain.push(`adelay=delays=${Math.round(c.at * 1000)}:all=1`);
      sounds.push(`[${k}:a]${chain.join(',')}[s${sounds.length + 1}]`);
    }
  }

  const graph: string[] = [];
  if (mode === 'mp4') graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${end}[v0]`, ...pictures, `[${last}]format=yuv420p[vout]`);
  const silence = `anullsrc=r=${RATE}:cl=stereo:d=${end}`;
  if (sounds.length === 0) graph.push(`${silence}[aout]`);
  else {
    const labels = ['[s0]', ...sounds.map((_, i) => `[s${i + 1}]`)].join('');
    graph.push(`${silence}[s0]`, ...sounds, `${labels}amix=inputs=${sounds.length + 1}:duration=first:normalize=0[aout]`);
  }
  args.push('-filter_complex', graph.join(';'));

  if (mode === 'mp4') {
    args.push('-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', fps,
      '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE), '-movflags', '+faststart', '-t', end, '-f', 'mp4', output);
  } else if (mode === 'wav') {
    args.push('-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', String(RATE), '-t', end, '-f', 'wav', output);
  } else {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE), '-t', end, '-f', 'mp4', output);
  }
  return args;
}
