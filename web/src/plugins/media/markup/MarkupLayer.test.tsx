import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MediaShape, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { setLang } from '@/core/i18n/index.ts';
import { connState, serverEvent } from '@/core/store/store.ts';
import { makeStore } from '@/core/testing';
import { MarkupLayer } from './MarkupLayer.tsx';
import { shapePath } from './geometry.ts';
import { addShape, selectDraft, setMode } from './slice.ts';

const TAB = 'file:p.png';
const rect = (x: number, y: number, w: number, h: number) => ({
  x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON() { return this; },
}) as DOMRect;

let pane: HTMLDivElement;
beforeEach(() => {
  setLang('en');
  Element.prototype.setPointerCapture = () => {}; // jsdom has no pointer capture
  pane = document.createElement('div');
  pane.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  document.body.append(pane);
});
afterEach(() => { cleanup(); pane.remove(); vi.restoreAllMocks(); });

/** A 2000×1000 image letterboxed in a 1000×1000 element: content box (0, 250) 1000×500. */
function image() {
  const img = document.createElement('img');
  Object.defineProperty(img, 'naturalWidth', { value: 2000 });
  Object.defineProperty(img, 'naturalHeight', { value: 1000 });
  img.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(img);
  return img;
}

function setup(media: HTMLImageElement | HTMLVideoElement = image(), protocol = 4, held = false) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(serverEvent({ kind: 'hello', protocol } as ServerEvent));
  const onAdd = vi.fn();
  const ui = () => (
    <Provider store={store}>
      <TooltipProvider>
        <MarkupLayer tabId={TAB} media={media} fit="contain" onAdd={onAdd} held={held} />
      </TooltipProvider>
    </Provider>
  );
  const r = render(ui());
  const dispatch = vi.spyOn(store, 'dispatch');
  return { store, r, onAdd, dispatch, ui, draft: () => selectDraft(store.getState(), TAB) };
}
const toggle = () => screen.getByRole('button', { name: /mark up/i });
const layer = () => pane.querySelector<SVGSVGElement>('svg[data-markup-layer]')!;
const drag = (pts: [number, number][]) => {
  const [first, ...rest] = pts;
  fireEvent.pointerDown(layer(), { button: 0, clientX: first[0], clientY: first[1], pointerId: 1, isPrimary: true });
  for (const [x, y] of rest) fireEvent.pointerMove(layer(), { clientX: x, clientY: y, pointerId: 1 });
  const last = pts[pts.length - 1];
  fireEvent.pointerUp(layer(), { clientX: last[0], clientY: last[1], pointerId: 1 });
};
const key = (k: Partial<KeyboardEventInit>) => fireEvent.keyDown(document.body, k);

it('the mode is not offered to a server below protocol 4', () => {
  setup(image(), 3);
  expect(screen.queryByRole('button', { name: /mark up/i })).toBeNull();
  cleanup();
  setup(image(), 4);
  expect(toggle()).toBeInTheDocument();
});

it('entering the mode pauses a playing video', () => {
  const v = document.createElement('video');
  v.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(v);
  let paused = false;
  Object.defineProperty(v, 'paused', { get: () => paused });
  const pause = vi.spyOn(v, 'pause').mockImplementation(() => { paused = true; });
  const { draft } = setup(v);
  fireEvent.click(toggle());
  expect(pause).toHaveBeenCalledTimes(1);
  expect(draft().on).toBe(true);
  expect(layer()).not.toBeNull();
});

it('the layer sits on the content box, inside the pane', () => {
  setup();
  fireEvent.click(toggle());
  expect(layer().parentElement).toBe(pane);
  const st = layer().style;
  expect([st.left, st.top, st.width, st.height]).toEqual(['0px', '250px', '1000px', '500px']);
});

it('a drag with the rect tool adds a rect in relative coordinates of the content box', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  // the content box is (0,250) 1000×500: x 100→300 is 0.1→0.3; y 350→450 is 0.2→0.4; dragged up-left
  drag([[300, 450], [200, 400], [100, 350]]);
  expect(draft().shapes).toEqual([{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.2, h: 0.2 }]);
  // outside the content box (the letterbox) clamps to the edge
  drag([[500, 100], [600, 50]]);
  expect(draft().shapes).toHaveLength(1); // zero height: not a shape
  drag([[500, 600], [1200, 900]]);
  expect(draft().shapes[1]).toEqual({ kind: 'rect', color: '#ff3b30', x: 0.5, y: 0.7, w: 0.5, h: 0.3 });
});

it('ellipse and arrow tools by key, a colour by digit (any keyboard layout)', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  key({ key: 'у', code: 'KeyE' }); // E on a Russian layout
  key({ key: '2', code: 'Digit2' });
  drag([[100, 250], [300, 750]]);
  key({ key: 'a', code: 'KeyA' });
  drag([[0, 250], [1000, 750]]);
  expect(draft().shapes).toEqual([
    { kind: 'ellipse', color: '#ffcc00', x: 0.1, y: 0, w: 0.2, h: 1 },
    { kind: 'arrow', color: '#ffcc00', x1: 0, y1: 0, x2: 1, y2: 1 },
  ]);
});

it('pen strokes update in place during the drag and are simplified on pointerup', () => {
  const { dispatch, draft } = setup();
  fireEvent.click(toggle());
  key({ key: 'p', code: 'KeyP' });
  dispatch.mockClear();
  const live = pane.querySelector('polyline[data-live]')!;
  fireEvent.pointerDown(layer(), { button: 0, clientX: 100, clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(layer(), { clientX: 100.5, clientY: 500, pointerId: 1 }); // 0.0005: dropped by simplify
  fireEvent.pointerMove(layer(), { clientX: 200, clientY: 500, pointerId: 1 });
  expect(live.getAttribute('points')).toBe('0.1,0.5 0.1005,0.5 0.2,0.5');
  fireEvent.pointerMove(layer(), { clientX: 300, clientY: 600, pointerId: 1 });
  expect(live.getAttribute('points')).toBe('0.1,0.5 0.1005,0.5 0.2,0.5 0.3,0.7');
  expect(dispatch).not.toHaveBeenCalled(); // no store update per move
  fireEvent.pointerUp(layer(), { clientX: 300, clientY: 600, pointerId: 1 });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(draft().shapes).toEqual([{ kind: 'pen', color: '#ff3b30', points: [0.1, 0.5, 0.2, 0.5, 0.3, 0.7] }]);
  expect(live.getAttribute('points')).toBe('');
  // a tap is a dot, never lost
  drag([[500, 500]]);
  expect(draft().shapes[1]).toEqual({ kind: 'pen', color: '#ff3b30', points: [0.5, 0.5, 0.5, 0.5] });
});

it('a live pen stroke appends each new point to both polylines (no rewrite of the whole points string per move)', () => {
  setup();
  fireEvent.click(toggle());
  key({ key: 'p', code: 'KeyP' });
  // jsdom has no SVGPointList: a browser-like one on the two live polylines and createSVGPoint on the svg
  (layer() as unknown as { createSVGPoint: () => { x: number; y: number } }).createSVGPoint = () => ({ x: 0, y: 0 });
  const lists = [...pane.querySelectorAll('polyline')].map((el) => {
    const items: { x: number; y: number }[] = [];
    Object.defineProperty(el, 'points', { configurable: true, value: { appendItem: (p: { x: number; y: number }) => (items.push(p), p) } });
    return { el, items, set: vi.spyOn(el, 'setAttribute') };
  });
  expect(lists).toHaveLength(2);
  fireEvent.pointerDown(layer(), { button: 0, clientX: 100, clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(layer(), { clientX: 200, clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(layer(), { clientX: 300, clientY: 600, pointerId: 1 });
  for (const l of lists) {
    expect(l.items).toEqual([{ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.7 }]);
    // the stroke colour (live pen) and the first point at pointerdown, nothing per move
    expect(l.set.mock.calls.filter((c) => c[0] === 'points')).toEqual([['points', '0.1,0.5']]);
    expect(l.items[0]).not.toBe(lists[0] === l ? lists[1]!.items[0] : lists[0]!.items[0]); // one point object per list
  }
});

it('undo removes the last shape; Esc with shapes asks before discarding; Esc without shapes just leaves', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  drag([[300, 300], [400, 400]]);
  key({ key: 'z', code: 'KeyZ', metaKey: true });
  expect(draft().shapes).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /undo/i }));
  expect(draft().shapes).toHaveLength(0);
  key({ key: 'Escape', code: 'Escape' });
  expect(draft().on).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  act(() => { document.body.dispatchEvent(ev); });
  expect(ev.defaultPrevented).toBe(true); // the document hotkeys do not also act on it
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
  expect(draft().on).toBe(true);
  expect(draft().shapes).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /leave/i })); // ✕ asks too
  fireEvent.click(screen.getByRole('button', { name: /discard/i }));
  expect(draft()).toMatchObject({ on: false, shapes: [] });
});

it('keys are ignored in a text field and outside the mode; Enter comments with the shapes', () => {
  const { draft, onAdd, store } = setup();
  key({ key: 'p', code: 'KeyP' });
  expect(draft().tool).toBe('rect');
  fireEvent.click(toggle());
  const field = document.createElement('textarea');
  document.body.append(field);
  fireEvent.keyDown(field, { key: 'p', code: 'KeyP' });
  fireEvent.keyDown(field, { key: 'Escape', code: 'Escape' });
  expect(draft()).toMatchObject({ tool: 'rect', on: true });
  field.remove();
  key({ key: 'Enter', code: 'Enter' });
  expect(onAdd).not.toHaveBeenCalled(); // nothing drawn
  const shape: MediaShape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
  act(() => { store.dispatch(addShape(TAB, shape)); });
  key({ key: 'Enter', code: 'Enter' });
  expect(onAdd).toHaveBeenCalledWith([shape], expect.objectContaining({ width: expect.any(Number) }));
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  expect(onAdd).toHaveBeenCalledTimes(2);
  expect(draft().shapes).toEqual([shape]); // the caller clears it once the comment exists
});

it('the draft survives a tab switch (the slice keeps it; the layer remounts with it)', () => {
  const { r, ui, store } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  r.unmount();
  expect(pane.querySelector('svg[data-markup-layer]')).toBeNull();
  render(ui());
  expect(selectDraft(store.getState(), TAB).on).toBe(true);
  expect(layer().querySelectorAll('path[data-shape]')).toHaveLength(1);
});

it('a hidden tab does not take the keys', () => {
  const { draft, store } = setup();
  act(() => { store.dispatch(setMode(TAB, true)); });
  pane.hidden = true;
  key({ key: 'p', code: 'KeyP' });
  expect(draft().tool).toBe('rect');
});

it('a dropped connection does not hide a drawing in progress', () => {
  const { store } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  act(() => { store.dispatch(connState('closed')); }); // protocol is 0 until the next hello
  expect(layer().querySelectorAll('path[data-shape]')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /leave/i })).toBeInTheDocument();
});

it('every shape has a dark halo under it, no CSS filter, the hit area outside any group', () => {
  setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  const shape = layer().querySelector('path[data-shape]')!;
  const halo = layer().querySelector('path[data-halo]')!;
  expect(halo.getAttribute('d')).toBe(shape.getAttribute('d'));
  expect(halo.compareDocumentPosition(shape) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // painted first
  expect(layer().innerHTML).not.toContain('filter');
  expect(layer().querySelector('rect')!.parentElement).toBe(layer());
});

it('the natural size known only after mount sizes the arrow head', () => {
  const img = document.createElement('img');
  let nat = [0, 0];
  Object.defineProperty(img, 'naturalWidth', { get: () => nat[0] });
  Object.defineProperty(img, 'naturalHeight', { get: () => nat[1] });
  img.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(img);
  const { draft } = setup(img);
  nat = [2000, 1000]; // loaded after the layer mounted, no load event seen
  fireEvent.click(toggle());
  key({ key: 'a', code: 'KeyA' });
  drag([[100, 400], [500, 500]]);
  expect(layer().querySelector('path[data-shape]')!.getAttribute('d')).toBe(shapePath(draft().shapes[0], 2000, 1000));
  nat = [1000, 2000];
  fireEvent.load(img); // a reload with another size
  expect(layer().querySelector('path[data-shape]')!.getAttribute('d')).toBe(shapePath(draft().shapes[0], 1000, 2000));
});

it('a tool or colour key pressed mid-drag does not change the shape being drawn', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  fireEvent.pointerDown(layer(), { button: 0, clientX: 100, clientY: 300, pointerId: 1 });
  key({ key: 'p', code: 'KeyP' });
  key({ key: '3', code: 'Digit3' });
  fireEvent.pointerMove(layer(), { clientX: 200, clientY: 400, pointerId: 1 });
  fireEvent.pointerUp(layer(), { clientX: 200, clientY: 400, pointerId: 1 });
  expect(draft().shapes).toEqual([{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.1, h: 0.2 }]);
  expect(draft()).toMatchObject({ tool: 'pen', color: '#34c759' }); // the next shape
});

it('Esc with focus inside the chat feed is not taken by the markup', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  const feed = document.createElement('div');
  const link = document.createElement('a');
  link.href = '#x';
  feed.append(link);
  document.body.append(feed);
  link.focus();
  const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  act(() => { link.dispatchEvent(ev); });
  expect(ev.defaultPrevented).toBe(false); // not taken by markup: the document hotkeys get it
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.keyDown(link, { key: 'Enter', code: 'Enter' });
  expect(draft().on).toBe(true);
  feed.remove();
});

it('colour buttons are named', () => {
  setup();
  fireEvent.click(toggle());
  for (const n of ['Red (1)', 'Yellow (2)', 'Green (3)', 'Blue (4)', 'White (5)']) expect(screen.getByRole('button', { name: n })).toBeInTheDocument();
});

it('Comment hands over the client rect around the drawn shapes (the popup opens there)', () => {
  const { onAdd, store } = setup();
  fireEvent.click(toggle());
  // content box (0, 250) 1000×500
  act(() => { store.dispatch(addShape(TAB, { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 })); });
  act(() => { store.dispatch(addShape(TAB, { kind: 'arrow', color: '#ff3b30', x1: 0.5, y1: 0.1, x2: 0.6, y2: 0.3 })); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  const r = onAdd.mock.calls[0]![1] as DOMRect;
  expect([r.left, r.top, r.width, r.height].map(Math.round)).toEqual([100, 300, 500, 250]);
});

it('shapes scrolled out of sight: the rect is the toolbar\'s', () => {
  const img = image();
  img.getBoundingClientRect = () => rect(0, -5000, 1000, 1000); // scrolled far up
  const { onAdd, store } = setup(img);
  fireEvent.click(toggle());
  act(() => { store.dispatch(addShape(TAB, { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 })); });
  const bar = screen.getByRole('toolbar');
  const tb = rect(800, 8, 180, 30);
  bar.getBoundingClientRect = () => tb;
  bar.parentElement!.getBoundingClientRect = () => rect(12, 8, 976, 30); // the pane-wide wrapper: not where it opens
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  expect(onAdd.mock.calls[0]![1]).toBe(tb);
});

it('held (the comment popup is open): the mode keys are off', () => {
  const { draft, onAdd, store } = setup(image(), 4, true);
  fireEvent.click(toggle());
  act(() => { store.dispatch(addShape(TAB, { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.1, h: 0.1 })); });
  key({ key: 'Enter', code: 'Enter' });
  key({ key: 'Escape', code: 'Escape' });
  key({ key: 'p', code: 'KeyP' });
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(draft()).toMatchObject({ on: true, tool: 'rect' });
});


it.each(['KeyR', 'KeyE', 'KeyA', 'KeyP'])('Esc mid-drag (%s) drops only the unfinished shape, no dialog; re-entering has no stale start point', (code) => {
  const { draft } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]); // one finished shape stays
  key({ key: 'x', code });
  fireEvent.pointerDown(layer(), { button: 0, clientX: 300, clientY: 350, pointerId: 1, isPrimary: true });
  fireEvent.pointerMove(layer(), { clientX: 500, clientY: 600, pointerId: 1 });
  key({ key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(draft().on).toBe(true);
  expect(draft().shapes).toHaveLength(1);
  for (const el of pane.querySelectorAll('[data-live]')) expect(el.getAttribute('d') ?? el.getAttribute('points') ?? '').toBe('');
  // a later move or release draws and adds nothing
  fireEvent.pointerMove(layer(), { clientX: 700, clientY: 700, pointerId: 1 });
  fireEvent.pointerUp(layer(), { clientX: 700, clientY: 700, pointerId: 1 });
  expect(draft().shapes).toHaveLength(1);
  // with nothing in progress, Esc still asks (there is a shape)
  key({ key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('leaving the mode mid-drag keeps no half-drawn shape for the next time', () => {
  const { store, draft } = setup();
  fireEvent.click(toggle());
  fireEvent.pointerDown(layer(), { button: 0, clientX: 300, clientY: 350, pointerId: 1, isPrimary: true });
  fireEvent.pointerMove(layer(), { clientX: 500, clientY: 600, pointerId: 1 });
  // the mode goes off from elsewhere (✕, the tab's own Esc): the svg is gone, no pointerup ever reaches it
  act(() => void store.dispatch(setMode(TAB, false)));
  fireEvent.click(toggle());
  fireEvent.pointerMove(layer(), { clientX: 700, clientY: 700, pointerId: 1 });
  for (const el of pane.querySelectorAll('[data-live]')) expect(el.getAttribute('d') ?? el.getAttribute('points') ?? '').toBe('');
  fireEvent.pointerUp(layer(), { clientX: 700, clientY: 700, pointerId: 1 });
  expect(draft().shapes).toEqual([]);
});

// ---- the Mask tool (issue 447) ----
// the content box is (0,250) 1000×500: client (x, y) is relative (x/1000, (y-250)/500)
const click = (x: number, y: number) => {
  fireEvent.pointerDown(layer(), { button: 0, clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  fireEvent.pointerUp(layer(), { clientX: x, clientY: y, pointerId: 1 });
};
const maskOn = () => {
  const s = setup(image(), 24);
  fireEvent.click(toggle());
  key({ key: 'g', code: 'KeyG' });
  return s;
};
const tri = { kind: 'polygon', color: '#ff3b30', points: [0.1, 0.2, 0.5, 0.2, 0.3, 0.8] };

it('the Mask tool is offered from protocol 24, with its key in the tooltip', () => {
  const { draft } = setup(image(), 23);
  fireEvent.click(toggle());
  expect(screen.queryByRole('button', { name: /mask/i })).toBeNull();
  key({ key: 'g', code: 'KeyG' });
  expect(draft().tool).toBe('rect');
  cleanup();
  maskOn();
  expect(screen.getByRole('button', { name: 'Mask (G)' })).toHaveAttribute('aria-pressed', 'true');
});

it('Mask: each click adds a point, a click on the first point closes the polygon', () => {
  const { draft } = maskOn();
  click(100, 350);
  click(500, 350);
  click(300, 650);
  expect(draft().shapes).toEqual([]);
  click(103, 352); // within reach of the first point
  expect(draft().shapes).toEqual([tri]);
  expect(pane.querySelector('[data-shape="polygon"]')).toHaveAttribute('fill', '#ff3b30');
});

it('Mask: Enter or a double-click closes; Enter with fewer than 3 points does nothing (and does not comment)', () => {
  const { draft, onAdd } = maskOn();
  click(100, 350);
  click(500, 350);
  key({ key: 'Enter' });
  expect(draft().shapes).toEqual([]);
  expect(onAdd).not.toHaveBeenCalled();
  click(300, 650);
  key({ key: 'Enter' });
  expect(draft().shapes).toEqual([tri]);
  // a double-click: its two presses add one point, then it closes
  click(700, 300);
  click(900, 300);
  click(800, 500);
  click(800, 500);
  fireEvent.doubleClick(layer(), { clientX: 800, clientY: 500 });
  expect(draft().shapes[1]).toEqual({ kind: 'polygon', color: '#ff3b30', points: [0.7, 0.1, 0.9, 0.1, 0.8, 0.5] });
});

it('Mask: a line follows the pointer from the last point; Backspace removes the last point; Esc drops the polygon, no dialog', () => {
  const { draft } = maskOn();
  click(100, 350);
  click(500, 350);
  fireEvent.pointerMove(layer(), { clientX: 600, clientY: 500, pointerId: 1 });
  const live = pane.querySelector('path[data-live-poly]')!;
  expect(live.getAttribute('d')).toBe('M0.1 0.2L0.5 0.2L0.6 0.5');
  key({ key: 'Backspace' });
  expect(live.getAttribute('d')).toBe('M0.1 0.2L0.6 0.5');
  key({ key: 'Escape' });
  expect(live.getAttribute('d')).toBe('');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(draft().on).toBe(true);
  expect(draft().shapes).toEqual([]);
  // the next click starts a new polygon
  click(100, 350);
  expect(live.getAttribute('d')).toBe('M0.1 0.2');
});

it('Mask: Cmd/Ctrl+Z while drawing removes the last point, as Backspace does, and leaves the drawn shapes', () => {
  const { store, draft } = maskOn();
  act(() => void store.dispatch(addShape(TAB, { kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 0.1, h: 0.1 })));
  click(100, 350);
  click(500, 350);
  const mod = { metaKey: true };
  key({ key: 'z', code: 'KeyZ', ...mod });
  expect(pane.querySelector('path[data-live-dots]')!.getAttribute('d')).toBe('M0.1 0.2h0');
  expect(draft().shapes).toHaveLength(1);
});

it('Mask: a press inside a closed polygon starts a new one (the Select tool edits drawn shapes)', () => {
  const { store, draft } = maskOn();
  act(() => void store.dispatch(addShape(TAB, tri as MediaShape)));
  click(300, 450);
  expect(draft().shapes).toEqual([tri]); // not moved
  expect(pane.querySelector('path[data-live-poly]')!.getAttribute('d')).toMatch(/^M0.3 0.4/);
  expect(pane.querySelector('[data-handles]')).toBeNull();
});

it('Mask: a drag is a lasso: the outline follows the pointer, a dot at its start only, and closes on release', () => {
  const { draft } = maskOn();
  fireEvent.pointerDown(layer(), { button: 0, clientX: 100, clientY: 350, pointerId: 1, isPrimary: true });
  for (const [x, y] of [[200, 350], [300, 350], [300, 450], [300, 550], [100, 550]]) fireEvent.pointerMove(layer(), { clientX: x, clientY: y, pointerId: 1 });
  expect(pane.querySelector('path[data-live-dots]')!.getAttribute('d')).toBe('M0.1 0.2h0');
  fireEvent.pointerUp(layer(), { clientX: 100, clientY: 550, pointerId: 1 });
  expect(draft().shapes).toEqual([{ kind: 'polygon', color: '#ff3b30', points: [0.1, 0.2, 0.3, 0.2, 0.3, 0.6, 0.1, 0.6] }]); // the outline's corners
  expect(pane.querySelector('path[data-live-poly]')!.getAttribute('d')).toBe('');
});

it('Mask: a drag while clicking a polygon adds a freehand stretch to it and leaves it open', () => {
  const { draft } = maskOn();
  click(100, 350);
  drag([[500, 350], [500, 450], [500, 550]]);
  expect(draft().shapes).toEqual([]);
  expect(pane.querySelector('path[data-live-dots]')!.getAttribute('d')).toBe('M0.1 0.2h0M0.5 0.2h0');
  key({ key: 'Enter' });
  expect(draft().shapes).toEqual([{ kind: 'polygon', color: '#ff3b30', points: [0.1, 0.2, 0.5, 0.2, 0.5, 0.6] }]); // the clicked point stays
});

it('Mask: points go close together: a quick click 10 px off is a point of its own, one 3 px off too', () => {
  const { draft } = maskOn();
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  click(100, 350);
  vi.spyOn(performance, 'now').mockReturnValue(1200);
  click(110, 350);
  vi.spyOn(performance, 'now').mockReturnValue(2000);
  click(110, 353);
  key({ key: 'Enter' });
  expect(draft().shapes).toEqual([{ kind: 'polygon', color: '#ff3b30', points: [0.1, 0.2, 0.11, 0.2, 0.11, 0.206] }]);
});

it('Mask: a lasso keeps the points its outline needs (a circle: a few dozen), and the Select tool shows them', () => {
  const { draft } = maskOn();
  const ring = Array.from({ length: 3000 }, (_, i) => [500 + 200 * Math.cos((2 * Math.PI * i) / 3000), 500 + 200 * Math.sin((2 * Math.PI * i) / 3000)] as [number, number]);
  drag(ring);
  const s = draft().shapes[0] as Extract<MediaShape, { kind: 'polygon' }>;
  expect(s.points.length / 2).toBeGreaterThan(20);
  expect(s.points.length / 2).toBeLessThan(80);
  expect(pane.querySelector('[data-handles]')).toBeNull();
  key({ key: 'v', code: 'KeyV' });
  click(500, 500);
  expect(pane.querySelector('[data-handles]')!.getAttribute('d')!.split('M')).toHaveLength(s.points.length / 2 + 1);
});

it('Mask: a double-click\'s second press adds no point even when the pointer moved; the first point with 2 points adds nothing', () => {
  const { draft } = maskOn();
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  click(100, 350);
  click(500, 350);
  const dots = () => pane.querySelector('path[data-live-dots]')!.getAttribute('d');
  click(100, 350); // the first point, only 2 points: nothing
  expect(dots()).toBe('M0.1 0.2h0M0.5 0.2h0');
  vi.spyOn(performance, 'now').mockReturnValue(5000);
  click(300, 650);
  vi.spyOn(performance, 'now').mockReturnValue(5200); // 200 ms later, 4 px off: the double-click's second press
  click(304, 650);
  fireEvent.doubleClick(layer(), { clientX: 304, clientY: 650 });
  expect(draft().shapes).toEqual([tri]);
});

// ---- the Select tool (issue 729) ----
const box = { kind: 'rect', color: '#0a84ff', x: 0.6, y: 0.6, w: 0.2, h: 0.2 }; // client x 600–800, y 550–650
const selectOn = (...shapes: object[]) => {
  const s = maskOn();
  for (const sh of shapes) act(() => void s.store.dispatch(addShape(TAB, sh as MediaShape)));
  key({ key: 'v', code: 'KeyV' });
  return s;
};

it('Select (V): a press picks any shape and moves it whole; the picked one\'s grips reshape it', () => {
  const { draft } = selectOn(tri, box);
  expect(screen.getByRole('button', { name: 'Select (V)' })).toHaveAttribute('aria-pressed', 'true');
  expect(pane.querySelector('[data-handles]')).toBeNull();
  drag([[700, 600], [750, 600], [800, 575]]); // the rect by (+0.1, -0.05)
  expect(draft().sel).toBe(1);
  expect(draft().shapes[1]).toEqual({ ...box, x: 0.7, y: 0.55 });
  expect(pane.querySelector('[data-handles]')!.getAttribute('d')).toBe('M0.7 0.55h0M0.9 0.55h0M0.9 0.75h0M0.7 0.75h0');
  drag([[900, 625], [950, 700]]); // its bottom right corner → (0.95, 0.9)
  expect(draft().shapes[1]).toEqual({ ...box, x: 0.7, y: 0.55, w: 0.25, h: 0.35 });
  click(300, 450); // inside the polygon: picked, not moved
  expect(draft().sel).toBe(0);
  drag([[500, 350], [550, 360], [600, 400]]); // its second point → (0.6, 0.3)
  expect(draft().shapes[0]).toEqual({ ...tri, points: [0.1, 0.2, 0.6, 0.3, 0.3, 0.8] });
  click(950, 300); // nothing there: nothing picked
  expect(draft().sel).toBeUndefined();
});

it('Select: a drag on a picked polygon\'s side bows it into an arc through the pointer, one undo step', () => {
  const { draft } = selectOn(tri);
  click(300, 450);
  drag([[300, 350], [300, 330], [300, 300]]); // the side (0.1, 0.2)–(0.5, 0.2), its middle up to y 0.1
  const pts = (draft().shapes[0] as { points: number[] }).points;
  expect(pts.slice(0, 2)).toEqual([0.1, 0.2]);
  expect(pts.slice(-4)).toEqual([0.5, 0.2, 0.3, 0.8]);
  expect(pts.length).toBeGreaterThan(tri.points.length);
  expect(pts.slice(0, -4).some((v, i) => i % 2 && v === 0.1)).toBe(true);
  key({ key: 'z', code: 'KeyZ', metaKey: true });
  expect(draft().shapes).toEqual([tri]);
});

it('Select: one drag of a point or of the shape is one undo step, which brings back the shape before it', () => {
  const { draft } = selectOn(tri);
  click(300, 450);
  drag([[500, 350], [550, 360], [600, 400]]); // a point, several moves
  drag([[300, 450], [350, 450], [400, 400]]); // the whole shape
  const mod = { metaKey: true };
  key({ key: 'z', code: 'KeyZ', ...mod });
  expect(draft().shapes).toEqual([{ ...tri, points: [0.1, 0.2, 0.6, 0.3, 0.3, 0.8] }]);
  fireEvent.click(screen.getByRole('button', { name: /undo/i }));
  expect(draft().shapes).toEqual([tri]);
  key({ key: 'z', code: 'KeyZ', ...mod });
  expect(draft().shapes).toEqual([]);
});

it('Select: Delete or Backspace removes the picked shape, Cmd/Ctrl+Z puts it back; Esc picks none, then leaves', () => {
  const { draft } = selectOn(tri, box);
  click(700, 600);
  key({ key: 'Delete' });
  expect(draft().shapes).toEqual([tri]);
  key({ key: 'z', code: 'KeyZ', metaKey: true });
  expect(draft().shapes).toEqual([tri, box]);
  expect(draft().sel).toBe(1);
  key({ key: 'Escape' });
  expect(draft().sel).toBeUndefined();
  expect(screen.queryByRole('dialog')).toBeNull();
  click(300, 450);
  key({ key: 'Backspace' });
  expect(draft().shapes).toEqual([box]);
  key({ key: 'Escape' }); // nothing picked: leaving asks about the drawing
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('Select: a click on a picked polygon\'s point picks the point, Delete removes it (one undo step); a triangle goes whole', () => {
  const square = { kind: 'polygon', color: '#ff3b30', points: [0.1, 0.2, 0.5, 0.2, 0.5, 0.6, 0.1, 0.6] }; // client y 350–550
  const { draft } = selectOn(square);
  click(300, 450);
  click(500, 550); // its third point
  expect(pane.querySelector('[data-point]')!.getAttribute('d')).toBe('M0.5 0.6h0');
  key({ key: 'Delete' });
  expect(draft().shapes).toEqual([{ ...square, points: [0.1, 0.2, 0.5, 0.2, 0.1, 0.6] }]);
  expect(pane.querySelector('[data-point]')).toBeNull();
  key({ key: 'z', code: 'KeyZ', metaKey: true });
  expect(draft().shapes).toEqual([square]);
  cleanup();
  const t = selectOn(tri);
  click(300, 450);
  click(100, 350);
  key({ key: 'Backspace' });
  expect(t.draft().shapes).toEqual([]);
});
