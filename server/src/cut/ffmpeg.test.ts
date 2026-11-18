import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpegPlaces, ffmpegVersion, findFfmpeg, isOldFfmpeg, probeSource, readFfmpegVersion } from './ffmpeg.ts';

describe('findFfmpeg', () => {
  const yes = (...ok: string[]) => (p: string) => ok.includes(p);

  it('NOTA_BENE_FFMPEG first, and authoritative: a wrong path is no ffmpeg, never another one', () => {
    expect(findFfmpeg({ env: { NOTA_BENE_FFMPEG: '/x/ff', PATH: '/p' }, platform: 'darwin', exists: yes('/x/ff', '/p/ffmpeg') })).toBe('/x/ff');
    expect(findFfmpeg({ env: { NOTA_BENE_FFMPEG: '/nonexistent', PATH: '/p' }, platform: 'darwin', exists: yes('/p/ffmpeg') })).toBeNull();
  });

  it('then ffmpeg on PATH, then Homebrew and the Linux places, else none', () => {
    expect(findFfmpeg({ env: { PATH: '/a:/p' }, platform: 'darwin', exists: yes('/p/ffmpeg', '/opt/homebrew/bin/ffmpeg') })).toBe('/p/ffmpeg');
    // a GUI launch's PATH often lacks Homebrew
    expect(findFfmpeg({ env: { PATH: '/usr/bin' }, platform: 'darwin', exists: yes('/opt/homebrew/bin/ffmpeg') })).toBe('/opt/homebrew/bin/ffmpeg');
    expect(findFfmpeg({ env: { PATH: '' }, platform: 'darwin', exists: yes('/usr/local/bin/ffmpeg') })).toBe('/usr/local/bin/ffmpeg');
    expect(findFfmpeg({ env: { PATH: '' }, platform: 'linux', exists: yes('/snap/bin/ffmpeg') })).toBe('/snap/bin/ffmpeg');
    expect(findFfmpeg({ env: { PATH: '/a' }, platform: 'linux', exists: yes() })).toBeNull();
  });

  it('Windows: ffmpeg.exe on Path, then winget, Scoop, Chocolatey and the usual folders', () => {
    const env = { Path: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u', ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' };
    const places = ffmpegPlaces(env, 'win32');
    expect(places).toEqual([
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe',
      'C:\\Users\\u\\scoop\\shims\\ffmpeg.exe',
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
    ]);
    expect(findFfmpeg({ env, platform: 'win32', exists: yes('C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe') })).toBe('C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe');
    // a folder of the environment that is not set is no place
    expect(ffmpegPlaces({}, 'win32')).toEqual(['C:\\ffmpeg\\bin\\ffmpeg.exe']);
  });
});

describe('probeSource', () => {
  it('reads the streams from what ffmpeg -i prints', () => {
    const video = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:00:03.00, start: 0.000000, bitrate: 120 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 320x240, 25 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s
At least one output file must be specified`;
    expect(probeSource(video)).toEqual({ video: true, audio: true });
    expect(probeSource(video.split('\n').filter((l) => !l.includes('Audio:')).join('\n'))).toEqual({ video: true, audio: false });
    expect(probeSource("  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s")).toEqual({ video: false, audio: true });
    // an unreadable file: ffmpeg names no stream
    expect(probeSource('a.mp4: Invalid data found when processing input')).toEqual({ video: false, audio: false });
  });
});

describe('ffmpegVersion', () => {
  it('reads the release from the first line of ffmpeg -version; a git build has none', () => {
    expect(ffmpegVersion('ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with clang')).toBe('9.0.2');
    expect(ffmpegVersion('ffmpeg version n4.3.1 Copyright (c) 2000-2020')).toBe('4.3.1');
    expect(ffmpegVersion('ffmpeg version 4.3.6-0+deb11u1 Copyright')).toBe('4.3.6');
    expect(ffmpegVersion('ffmpeg version N-112233-gabcdef Copyright')).toBeNull();
    expect(ffmpegVersion('')).toBeNull();
  });

  // issue 468: it was execFileSync on a tab's hello, up to 5 s of a frozen server
  it.skipIf(process.platform === 'win32')('readFfmpegVersion asks without blocking the event loop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-ffver-'));
    try {
      const slow = path.join(dir, 'ffmpeg');
      fs.writeFileSync(slow, "#!/usr/bin/env node\nsetTimeout(() => console.log('ffmpeg version 6.1.1 Copyright'), 300);\n", { mode: 0o755 });
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 20);
      const asked = readFfmpegVersion(slow);
      expect(ticks).toBe(0);
      expect(await asked).toBe('6.1.1');
      clearInterval(timer);
      expect(ticks).toBeGreaterThan(3);
      expect(await readFfmpegVersion(path.join(dir, 'missing'))).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('older than 4.4 is old (amix has no normalize there); unknown is not', () => {
    expect(isOldFfmpeg('4.3.6')).toBe(true);
    expect(isOldFfmpeg('3.4')).toBe(true);
    expect(isOldFfmpeg('4.4')).toBe(false);
    expect(isOldFfmpeg('5.0.1')).toBe(false);
    expect(isOldFfmpeg('10.1')).toBe(false);
    expect(isOldFfmpeg(null)).toBe(false);
  });
});
