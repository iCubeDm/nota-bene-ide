// The route builders of issue 511: the same paths the server always had, one encoding, `here` never on the wire.
import { expect, it } from 'vitest';
import { routes } from './routes.ts';

it('encodes query values and leaves out the ones not given', () => {
  expect(routes.complete('a b/c&d')).toBe('/complete?q=a%20b%2Fc%26d');
  expect(routes.vcsDiff('ref:main')).toBe('/vcs-diff?src=ref%3Amain');
  expect(routes.vcsDiff('here', 'main')).toBe('/vcs-diff?src=here&base=main');
  expect(routes.vcsFile('here', 'новый.md', { old: 'a.md' })).toBe('/vcs-file?src=here&path=%D0%BD%D0%BE%D0%B2%D1%8B%D0%B9.md&old=a.md');
  expect(routes.usage('codex', 'trip')).toBe('/usage?provider=codex&period=trip');
  expect(routes.systemPrefs()).toBe('/system/prefs');
  expect(routes.systemProjects('stop-others')).toBe('/system/projects/stop-others');
});

it('a file of the checkout carries no src; another source and a download say so', () => {
  expect(routes.file('img/a b.png')).toBe('/file?path=img%2Fa%20b.png');
  expect(routes.file('a.png', { src: 'here' })).toBe('/file?path=a.png');
  expect(routes.file('a.png', { src: 'ref:feature/x' })).toBe('/file?path=a.png&src=ref%3Afeature%2Fx');
  expect(routes.file('a.png', { download: true })).toBe('/file?path=a.png&download=1');
  expect(routes.tree('src', 'here')).toBe('/tree?path=src');
});

it('path segments are encoded too', () => {
  expect(routes.attach()).toBe('/attach');
  expect(routes.attach('ab12.png')).toBe('/attach/ab12.png');
  expect(routes.marks('m 1', 'f.png')).toBe('/marks/m%201/f.png');
  expect(routes.voiceText('v1', 'en', true)).toBe('/voice/v1/text?lang=en&detect=1');
});
