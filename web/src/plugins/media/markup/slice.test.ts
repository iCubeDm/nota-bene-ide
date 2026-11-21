import { expect, it } from 'vitest';
import { enterRoot } from '../../tabs/slice.ts';
import { addShape, commitEdit, dropShapes, markupSlice, replaceShape, setMode, undo, type MarkupState } from './slice.ts';

const r = markupSlice.reducer;
const shape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 } as const;
const go = (root: string, first = false) => enterRoot({ root, first, tabs: null });

it('a folder switch keeps each folder\'s drafts (by tab id) and a switch back restores them', () => {
  let s: MarkupState = r(undefined, go('/a', true));
  s = r(s, setMode('file:x.png', true));
  s = r(s, addShape('file:x.png', shape));
  s = r(s, go('/b'));
  expect(s.drafts).toEqual({}); // /b has its own x.png: not /a's drawing
  s = r(s, addShape('file:x.png', { ...shape, x: 0.5 }));
  s = r(s, go('/a'));
  expect(s.drafts['file:x.png']).toMatchObject({ on: true, shapes: [shape] });
  s = r(s, go('/b'));
  expect(s.drafts['file:x.png']!.shapes).toEqual([{ ...shape, x: 0.5 }]);
});

it('the first root merges: a draft made before the root was known stays', () => {
  let s: MarkupState = r(undefined, addShape('file:x.png', shape));
  s = r(s, go('/a', true));
  expect(s.drafts['file:x.png']!.shapes).toEqual([shape]);
});

it('dropShapes removes only the submitted shapes (by value, once each); the mode stays on', () => {
  const other = { ...shape, x: 0.6 };
  let s: MarkupState = r(undefined, setMode('t', true));
  s = r(s, addShape('t', shape));
  s = r(s, addShape('t', other));
  s = r(s, dropShapes('t', [{ ...shape }]));
  expect(s.drafts.t).toMatchObject({ on: true, shapes: [other] });
  s = r(s, dropShapes('t', [other]));
  expect(s.drafts.t).toMatchObject({ on: true, shapes: [] });
});

it('undo (issue 447): an edit of a polygon is undone before the shape, in the order they were made', () => {
  const tri = { kind: 'polygon' as const, color: '#ff3b30' as const, points: [0, 0, 1, 0, 1, 1] };
  const rect = { kind: 'rect' as const, color: '#ff3b30' as const, x: 0, y: 0, w: 0.1, h: 0.1 };
  let s = markupSlice.reducer(undefined, addShape('t', tri));
  s = markupSlice.reducer(s, replaceShape('t', 0, { ...tri, points: [0.1, 0, 1, 0, 1, 1] }));
  s = markupSlice.reducer(s, replaceShape('t', 0, { ...tri, points: [0.2, 0, 1, 0, 1, 1] })); // the same drag
  s = markupSlice.reducer(s, commitEdit('t', 0, tri));
  s = markupSlice.reducer(s, addShape('t', rect));
  s = markupSlice.reducer(s, undo('t'));
  expect(s.drafts.t.shapes).toEqual([{ ...tri, points: [0.2, 0, 1, 0, 1, 1] }]);
  s = markupSlice.reducer(s, undo('t'));
  expect(s.drafts.t.shapes).toEqual([tri]);
  s = markupSlice.reducer(s, undo('t'));
  expect(s.drafts.t.shapes).toEqual([]);
});
