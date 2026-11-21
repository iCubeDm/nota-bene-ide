import { expect, it } from 'vitest';
import { preparePage } from './prep.ts';

const parse = (doc: string) => new DOMParser().parseFromString(doc, 'text/html');

it('nothing of the page runs: scripts, handlers and javascript: links are gone, a policy says so again', () => {
  const { doc, scripts } = preparePage('<!doctype html><head><base href="http://x/"><meta http-equiv="refresh" content="0;url=http://x"><script>alert(1)</script></head><body onload="x()"><a href="javascript:x()" onclick="y()">a</a></body>', 'docs', 'here');
  expect(scripts).toBe(true);
  const d = parse(doc);
  expect(d.querySelectorAll('script, base, meta[http-equiv=refresh]')).toHaveLength(0);
  expect(d.body.hasAttribute('onload')).toBe(false);
  expect(d.querySelector('a')!.getAttributeNames()).toEqual([]);
  expect(d.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).toContain("script-src 'none'");
  expect(doc.startsWith('<!doctype html>')).toBe(true);
});

it('relative resources point at the files beside the page; absolute, data and fragment ones stay', () => {
  const { doc, scripts } = preparePage('<link rel="stylesheet" href="s.css"><img src="../img/a.png"><img src="data:image/png;base64,x"><img src="https://e.x/b.png"><svg><use href="#d"/><image href="p.svg"/></svg>', 'docs/valley', 'here');
  expect(scripts).toBe(false);
  const d = parse(doc);
  expect(d.querySelector('link')!.getAttribute('href')).toBe('/file?path=docs%2Fvalley%2Fs.css');
  expect([...d.querySelectorAll('img')].map((e) => e.getAttribute('src'))).toEqual(['/file?path=docs%2Fimg%2Fa.png', 'data:image/png;base64,x', 'https://e.x/b.png']);
  expect(d.querySelector('use')!.getAttribute('href')).toBe('#d');
  expect(d.querySelector('image')!.getAttribute('href')).toBe('/file?path=docs%2Fvalley%2Fp.svg');
  expect(doc.startsWith('<!doctype')).toBe(false); // no doctype in the file: none added (the same rendering mode)
});

it('a page of another source reads its resources from that source', () => {
  const d = parse(preparePage('<img src="a.png">', undefined, 'ref:feature/x').doc);
  expect(d.querySelector('img')!.getAttribute('src')).toBe('/file?path=a.png&src=ref%3Afeature%2Fx');
});
