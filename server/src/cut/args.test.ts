import { describe, expect, it } from 'vitest';
import type { Cut } from '@nota-bene/shared/cut';
import { cutEnd, exportArgs, type Sources } from './args.ts';

/** The value after `flag` (the first one). */
const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];
const graph = (args: string[]): string[] => after(args, '-filter_complex')!.split(';');
/** The `-i` files in order. */
const inputs = (args: string[]): string[] => args.flatMap((a, i) => (a === '-i' ? [args[i + 1]!] : []));

// a main video, a picture-in-picture photo over it, a voice-over track and music
const CUT: Cut = {
  version: 1, width: 1280, height: 720, fps: 30,
  tracks: [
    { id: 'v1', kind: 'video' },
    { id: 'v2', kind: 'video', gain: -3 },
    { id: 'a1', kind: 'audio', name: 'voice', gain: 2 },
    { id: 'a2', kind: 'audio', name: 'music' },
  ],
  clips: [
    // a gap from 0 to 1 s: black and silent
    { id: 'c1', track: 'v1', src: 'media/a.mp4', at: 1, in: 2.5, out: 4.5, gain: -6, fadeIn: 0.5 },
    { id: 'c2', track: 'v2', src: 'media/b.png', at: 1.5, dur: 1, place: { x: 0.5, y: 0.25, w: 0.25, h: 0.5, opacity: 0.6 } },
    { id: 'c3', track: 'a1', src: 'media/voice.wav', at: 0.25, out: 2, fadeOut: 0.5 },
    { id: 'c4', track: 'a2', src: 'media/music.mp3', at: 0, in: 10, out: 13.5 },
  ],
};
const SOURCES: Sources = new Map([
  ['media/a.mp4', { file: '/p/media/a.mp4', video: true, audio: true }],
  ['media/b.png', { file: '/p/media/b.png', video: true, audio: false }],
  ['media/voice.wav', { file: '/p/media/voice.wav', video: false, audio: true }],
  ['media/music.mp3', { file: '/p/media/music.mp3', video: false, audio: true }],
]);
const cut = (patch: (c: Cut) => void): Cut => {
  const c = structuredClone(CUT);
  patch(c);
  return c;
};

describe('cutEnd', () => {
  it('is the end of the last clip: out - in for video and sound, dur for a photo', () => {
    expect(cutEnd(CUT)).toBe(3.5); // the music, 0 + 3.5
    expect(cutEnd(cut((c) => { c.clips[1]!.dur = 4; }))).toBe(5.5);
    expect(cutEnd(cut((c) => { c.clips = []; }))).toBe(0);
  });
});

describe('exportArgs', () => {
  it('mp4: the whole argument list (one -i per clip, trimmed at the input; H.264 yuv420p + AAC at the edit size and rate)', () => {
    expect(exportArgs(CUT, SOURCES, '/p/exports/.x.part', 'mp4')).toEqual([
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      '-ss', '2.5', '-t', '2', '-i', '/p/media/a.mp4',
      '-f', 'image2', '-pattern_type', 'none', '-loop', '1', '-framerate', '30', '-t', '1', '-i', '/p/media/b.png',
      '-t', '2', '-i', '/p/media/voice.wav',
      '-ss', '10', '-t', '3.5', '-i', '/p/media/music.mp3',
      '-filter_complex', [
        'color=c=black:s=1280x720:r=30:d=3.5[v0]',
        '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,setsar=1,format=yuva420p,setpts=PTS-STARTPTS+1/TB,fps=30[p1]',
        '[v0][p1]overlay=x=0+(1280-w)/2:y=0+(720-h)/2:eof_action=pass[v1]',
        '[1:v]scale=320:360:force_original_aspect_ratio=decrease,setsar=1,format=yuva420p,colorchannelmixer=aa=0.6,setpts=PTS-STARTPTS+1.5/TB,fps=30[p2]',
        '[v1][p2]overlay=x=640+(320-w)/2:y=180+(360-h)/2:eof_action=pass[v2]',
        '[v2]format=yuv420p[vout]',
        'anullsrc=r=48000:cl=stereo:d=3.5[s0]',
        '[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=-6dB,afade=t=in:st=0:d=0.5,adelay=delays=1000:all=1[s1]',
        '[2:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=2dB,afade=t=out:st=1.5:d=0.5,adelay=delays=250:all=1[s2]',
        '[3:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[s3]',
        '[s0][s1][s2][s3]amix=inputs=4:duration=first:normalize=0[aout]',
      ].join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
      '-t', '3.5', '-f', 'mp4', '/p/exports/.x.part',
    ]);
  });

  it('wav and m4a: the sound mix alone, no picture inputs or filters', () => {
    const wav = exportArgs(CUT, SOURCES, '/o.wav', 'wav');
    expect(inputs(wav)).toEqual(['/p/media/a.mp4', '/p/media/voice.wav', '/p/media/music.mp3']);
    expect(graph(wav).some((f) => f.includes(':v]') || f.startsWith('color='))).toBe(false);
    expect(wav.slice(wav.indexOf('-map'))).toEqual(['-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '48000', '-t', '3.5', '-f', 'wav', '/o.wav']);
    const m4a = exportArgs(CUT, SOURCES, '/o.m4a', 'm4a');
    expect(m4a.slice(m4a.indexOf('-map'))).toEqual(['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', '3.5', '-f', 'mp4', '/o.m4a']);
  });

  it('clip gain and track gain add up in dB; a muted clip, a muted track and a track without solo are silent', () => {
    const vol = (c: Cut) => graph(exportArgs(c, SOURCES, '/o', 'wav')).filter((f) => f.startsWith('[') && f.includes(':a]')).map((f) => /volume=([^,[]+)/.exec(f)?.[1] ?? '0dB');
    // c2 is a photo on v2 (-3 dB): no sound of its own
    expect(vol(CUT)).toEqual(['-6dB', '2dB', '0dB']);
    expect(vol(cut((c) => { c.clips[2]!.gain = -4.5; }))).toEqual(['-6dB', '-2.5dB', '0dB']);
    expect(vol(cut((c) => { c.clips[0]!.mute = true; }))).toEqual(['2dB', '0dB']);
    expect(vol(cut((c) => { c.tracks[3]!.mute = true; }))).toEqual(['-6dB', '2dB']);
    expect(vol(cut((c) => { c.tracks[2]!.solo = true; }))).toEqual(['2dB']);
    // solo on a muted track: mute wins
    expect(vol(cut((c) => { c.tracks[2]!.solo = true; c.tracks[2]!.mute = true; }))).toEqual([]);
  });

  it('a video clip of a source without sound adds no sound', () => {
    const silent = new Map(SOURCES);
    silent.set('media/a.mp4', { file: '/p/media/a.mp4', video: true, audio: false });
    const g = graph(exportArgs(CUT, silent, '/o', 'mp4'));
    expect(g.some((f) => f.startsWith('[0:a]'))).toBe(false);
    expect(g.some((f) => f.startsWith('[0:v]'))).toBe(true);
  });

  it('a sound-only source on a video track adds only its sound: no picture of it, the graph stays whole', () => {
    const c = cut((x) => { x.clips[0]!.src = 'media/voice.wav'; });
    const args = exportArgs(c, SOURCES, '/o', 'mp4');
    const g = graph(args);
    expect(inputs(args)[0]).toBe('/p/media/voice.wav');
    expect(g.some((f) => f.startsWith('[0:v]'))).toBe(false);
    expect(g.some((f) => f.startsWith('[0:a]'))).toBe(true);
    // the photo is the only picture
    expect(g).toContain('[v0][p1]overlay=x=640+(320-w)/2:y=180+(360-h)/2:eof_action=pass[v1]');
    // muted, it is no input at all
    expect(inputs(exportArgs(cut((x) => { x.clips[0]!.src = 'media/voice.wav'; x.clips[0]!.mute = true; }), SOURCES, '/o', 'mp4'))).toEqual(['/p/media/b.png', '/p/media/voice.wav', '/p/media/music.mp3']);
  });

  it('an odd or fractional frame size is rounded to an even one (H.264 yuv420p needs it), 2 at least', () => {
    const g = graph(exportArgs(cut((c) => { c.width = 1281; c.height = 719.4; }), SOURCES, '/o', 'mp4'));
    expect(g[0]).toBe('color=c=black:s=1282x720:r=30:d=3.5[v0]');
    expect(g[1]).toContain('scale=1282:720:');
    expect(graph(exportArgs(cut((c) => { c.width = 1; c.height = 0.4; }), SOURCES, '/o', 'mp4'))[0]).toBe('color=c=black:s=2x2:r=30:d=3.5[v0]');
  });

  it('a photo is read as one image: a name with %d is no sequence pattern', () => {
    const named = new Map(SOURCES);
    named.set('media/b.png', { file: '/p/media/shot%d.png', video: true, audio: false });
    const args = exportArgs(CUT, named, '/o', 'mp4');
    const i = args.indexOf('/p/media/shot%d.png');
    expect(args.slice(i - 11, i + 1)).toEqual(['-f', 'image2', '-pattern_type', 'none', '-loop', '1', '-framerate', '30', '-t', '1', '-i', '/p/media/shot%d.png']);
  });

  it('an AVIF photo (read by the mp4 reader, no -loop there) loops as a stream, cut to its length in the graph', () => {
    const c = cut((x) => { x.clips[1]!.src = 'media/b.avif'; });
    const avif = new Map(SOURCES);
    avif.set('media/b.avif', { file: '/p/media/b.avif', video: true, audio: false });
    const args = exportArgs(c, avif, '/o', 'mp4');
    const i = args.indexOf('/p/media/b.avif');
    expect(args.slice(i - 5, i + 1)).toEqual(['-stream_loop', '-1', '-t', '1', '-i', '/p/media/b.avif']);
    expect(graph(args)[3]).toMatch(/^\[1:v\]fps=30,trim=duration=1,scale=320:360:/);
  });

  it('a hidden video track is not drawn, its clips still sound; a clip with neither is no input at all', () => {
    const hidden = exportArgs(cut((c) => { c.tracks[0]!.hidden = true; }), SOURCES, '/o', 'mp4');
    const g = graph(hidden);
    expect(g.some((f) => f.startsWith('[0:v]'))).toBe(false);
    expect(g.some((f) => f.startsWith('[0:a]'))).toBe(true);
    // the photo is now the only picture: it overlays the black frame directly
    expect(g).toContain('[v0][p1]overlay=x=640+(320-w)/2:y=180+(360-h)/2:eof_action=pass[v1]');
    const gone = exportArgs(cut((c) => { c.tracks[0]!.hidden = true; c.clips[0]!.mute = true; }), SOURCES, '/o', 'mp4');
    expect(inputs(gone)).toEqual(['/p/media/b.png', '/p/media/voice.wav', '/p/media/music.mp3']);
  });

  it('video tracks stack in their order, clips of a track by time; place rounds to pixels, opacity 1 adds no alpha mix', () => {
    const c = cut((x) => {
      x.tracks = [x.tracks[1]!, x.tracks[0]!, ...x.tracks.slice(2)]; // v2 under v1 now
      x.clips[1]!.place = { x: 0.1, y: 0.1, w: 0.333, h: 0.333 };
      x.clips.push({ id: 'c5', track: 'v1', src: 'media/a.mp4', at: 0, out: 1 });
    });
    const g = graph(exportArgs(c, SOURCES, '/o', 'mp4'));
    const picked = g.filter((f) => f.includes(':v]')).map((f) => f.slice(0, f.indexOf(']') + 1));
    // inputs: c2 (v2, the lower track), then v1's clips by time: c5 at 0, c1 at 1
    expect(picked).toEqual(['[0:v]', '[1:v]', '[2:v]']);
    expect(g[1]).toContain('scale=426:240:');
    expect(g[1]).not.toContain('colorchannelmixer');
    expect(g[2]).toBe('[v0][p1]overlay=x=128+(426-w)/2:y=72+(240-h)/2:eof_action=pass[v1]');
  });

  it('an edit with nothing audible still has a silent sound track of its length', () => {
    const g = graph(exportArgs(cut((c) => { for (const t of c.tracks) t.mute = true; }), SOURCES, '/o', 'mp4'));
    expect(g.filter((f) => f.includes('anullsrc') || f.includes('amix'))).toEqual(['anullsrc=r=48000:cl=stereo:d=3.5[aout]']);
  });

  it('numbers never carry float noise into the graph', () => {
    const args = exportArgs(cut((c) => { c.clips[0]!.at = 0.1 + 0.2; c.clips[0]!.in = 0.1 + 0.7; }), SOURCES, '/o', 'mp4');
    expect(args.join(' ')).not.toMatch(/\d\.\d{7,}/);
    expect(after(args, '-ss')).toBe('0.8');
  });
});
