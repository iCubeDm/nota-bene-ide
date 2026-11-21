import { expect, it } from 'vitest';
import { describe as describeEl, elementAnchor, pickTarget, resolvePage, selectorOf, trailOf } from './anchor.ts';

const SRC = { kind: 'file', path: 'docs/map.html' } as const;
const page = (body: string) => new DOMParser().parseFromString(`<!doctype html><body>${body}</body>`, 'text/html');
const MAP = `<h1>Town</h1><p>intro</p><h2>Map</h2>
<svg id="map" aria-label="Town"><g class="node"><circle><title>Mill: grinds</title></circle><text>Mill</text></g>
<g class="node"><circle><title>Market: Fridays</title></circle><text>Market</text></g></svg>`;

it('an element reads as its tag, id, first class and name: its own title, aria-label, a group\'s first text, or the start of its text', () => {
  const d = page(MAP + '<p class="note big">' + 'word '.repeat(30) + '</p>');
  expect(describeEl(d.querySelector('svg')!)).toBe('svg#map «Town»');
  expect(describeEl(d.querySelector('circle')!)).toBe('circle «Mill: grinds»');
  expect(describeEl(d.querySelector('g')!)).toBe('g.node «Mill»');
  expect(describeEl(d.querySelector('h2')!)).toBe('h2 «Map»');
  expect(describeEl(d.querySelector('p.note')!)).toMatch(/^p\.note «(word ){11}word…»$/);
});

it('the trail: the heading before it, its named ancestors, itself', () => {
  const d = page(MAP);
  const c = d.querySelectorAll('circle')[1]!;
  expect(trailOf(c)).toEqual(['h2 «Map»', 'svg#map «Town»', 'g.node «Market»', 'circle «Market: Fridays»']);
  expect(trailOf(d.querySelector('h1')!)).toEqual(['h1 «Town»']);
});

it('a click in a diagram means the titled shape, else its group; elsewhere the element; never the page root', () => {
  const d = page(MAP + '<svg><g class="x"><rect/></g></svg>');
  expect(pickTarget(d.querySelectorAll('title')[0]!)).toBe(d.querySelector('circle'));
  expect(pickTarget(d.querySelectorAll('text')[1]!)).toBe(d.querySelectorAll('g')[1]);
  expect(pickTarget(d.querySelector('rect')!)).toBe(d.querySelector('g.x'));
  expect(pickTarget(d.querySelector('p')!)).toBe(d.querySelector('p'));
  expect(pickTarget(d.body)).toBeNull();
});

it('found again at its path; moved, by what it reads as; gone or ambiguous, not at all', () => {
  const d = page(MAP);
  const a = elementAnchor(SRC, d.querySelectorAll('circle')[1]!)!;
  expect(a.selector).toBe(selectorOf(d.querySelectorAll('circle')[1]!));
  expect(resolvePage(d, a)).toBe(d.querySelectorAll('circle')[1]);
  // a paragraph added above: the path points elsewhere, the shape is found by its name
  const moved = page('<p>new</p>' + MAP);
  expect(resolvePage(moved, a)).toBe(moved.querySelectorAll('circle')[1]);
  // renamed: gone
  expect(resolvePage(page(MAP.replace('Market: Fridays', 'Market: daily')), a)).toBeNull();
  // two shapes read the same now: the trail picks the one under the same group
  const twice = page('<p>new</p>' + MAP + '<svg><circle><title>Market: Fridays</title></circle></svg>');
  expect(resolvePage(twice, a)).toBe(twice.querySelectorAll('circle')[1]);
  expect(resolvePage(d, { ...a, selector: '>>>' })).toBe(d.querySelectorAll('circle')[1]); // not a selector: by name
});
