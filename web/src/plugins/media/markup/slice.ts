import { type RootState, enterRoot } from '@/sdk';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { MARK_COLORS, type MarkColor, type MediaShape } from '@nota-bene/shared';

/** `polygon`: the Mask tool (issue 447, from `polygons`); `select`: picks a drawn shape to move, reshape or delete (issue 729). */
export type MarkTool = 'select' | 'rect' | 'ellipse' | 'pen' | 'arrow' | 'polygon';
/** One media tab's unfinished drawing. In memory only: a page reload loses it, a tab or folder switch does not. */
export type Draft = {
  on: boolean; tool: MarkTool; color: MarkColor; shapes: MediaShape[];
  /** The shape picked with the Select tool (issue 729), by index. */
  sel?: number;
  /**
   * The edits of drawn shapes (issues 447, 729), oldest first: the shape at `index` as it was before (`removed`: the
   * shape deleted from there), and how many shapes there were after it (`n`). Undo restores the newest one while no
   * shape was added after it, else drops the last shape.
   */
  edits?: { index: number; prev: MediaShape; n: number; removed?: true }[];
};
/** `drafts`: the current folder's, by tab id; `parked`: the other folders' (by root), put back on a switch back. */
export type MarkupState = { drafts: Record<string, Draft>; root: string | null; parked: Record<string, Record<string, Draft>> };

const EMPTY: Draft = { on: false, tool: 'rect', color: MARK_COLORS[0], shapes: [] };
const draftOf = (s: MarkupState, tabId: string): Draft => (s.drafts[tabId] ??= { ...EMPTY, shapes: [] });

export const markupSlice = createSlice({
  name: 'markup',
  initialState: (): MarkupState => ({ drafts: {}, root: null, parked: {} }),
  reducers: {
    setMode: {
      reducer: (s, a: PayloadAction<{ tabId: string; on: boolean }>) => void (draftOf(s, a.payload.tabId).on = a.payload.on),
      prepare: (tabId: string, on: boolean) => ({ payload: { tabId, on } }),
    },
    setTool: {
      reducer: (s, a: PayloadAction<{ tabId: string; tool: MarkTool }>) => {
        const d = draftOf(s, a.payload.tabId);
        d.tool = a.payload.tool;
        if (d.tool !== 'select') delete d.sel;
      },
      prepare: (tabId: string, tool: MarkTool) => ({ payload: { tabId, tool } }),
    },
    setColor: {
      reducer: (s, a: PayloadAction<{ tabId: string; color: MarkColor }>) => void (draftOf(s, a.payload.tabId).color = a.payload.color),
      prepare: (tabId: string, color: MarkColor) => ({ payload: { tabId, color } }),
    },
    addShape: {
      reducer: (s, a: PayloadAction<{ tabId: string; shape: MediaShape }>) => void draftOf(s, a.payload.tabId).shapes.push(a.payload.shape),
      prepare: (tabId: string, shape: MediaShape) => ({ payload: { tabId, shape } }),
    },
    /** The shape picked with the Select tool, or none (null). */
    select: {
      reducer: (s, a: PayloadAction<{ tabId: string; index: number | null }>) => {
        const d = draftOf(s, a.payload.tabId);
        if (a.payload.index === null || a.payload.index < 0 || a.payload.index >= d.shapes.length) delete d.sel;
        else d.sel = a.payload.index;
      },
      prepare: (tabId: string, index: number | null) => ({ payload: { tabId, index } }),
    },
    /** A drawn shape is deleted: one undo step, which puts it back. */
    removeShape: {
      reducer: (s, a: PayloadAction<{ tabId: string; index: number }>) => {
        const d = s.drafts[a.payload.tabId];
        if (!d || a.payload.index < 0 || a.payload.index >= d.shapes.length) return;
        const [prev] = d.shapes.splice(a.payload.index, 1);
        (d.edits ??= []).push({ index: a.payload.index, prev, n: d.shapes.length, removed: true });
        delete d.sel;
      },
      prepare: (tabId: string, index: number) => ({ payload: { tabId, index } }),
    },
    /** A drawn shape changed in place (dragged, reshaped: issues 447, 729); no undo step (commitEdit). */
    replaceShape: {
      reducer: (s, a: PayloadAction<{ tabId: string; index: number; shape: MediaShape }>) => {
        const d = s.drafts[a.payload.tabId];
        if (d && a.payload.index >= 0 && a.payload.index < d.shapes.length) d.shapes[a.payload.index] = a.payload.shape;
      },
      prepare: (tabId: string, index: number, shape: MediaShape) => ({ payload: { tabId, index, shape } }),
    },
    /** One drag of a shape is done: `prev` (the shape before it) becomes one undo step. */
    commitEdit: {
      reducer: (s, a: PayloadAction<{ tabId: string; index: number; prev: MediaShape }>) => {
        const d = s.drafts[a.payload.tabId];
        if (!d || a.payload.index < 0 || a.payload.index >= d.shapes.length) return;
        (d.edits ??= []).push({ index: a.payload.index, prev: a.payload.prev, n: d.shapes.length });
      },
      prepare: (tabId: string, index: number, prev: MediaShape) => ({ payload: { tabId, index, prev } }),
    },
    undo: (s, a: PayloadAction<string>) => {
      const d = s.drafts[a.payload];
      if (!d) return;
      const e = d.edits?.at(-1);
      if (e && e.n === d.shapes.length && e.index < d.shapes.length + (e.removed ? 1 : 0)) {
        if (e.removed) {
          d.shapes.splice(e.index, 0, e.prev);
          d.sel = e.index;
        } else d.shapes[e.index] = e.prev;
        d.edits!.pop();
        return;
      }
      d.shapes.pop();
      if (d.sel !== undefined && d.sel >= d.shapes.length) delete d.sel;
      if (d.edits) d.edits = d.edits.filter((x) => x.index < d.shapes.length + (x.removed ? 1 : 0) && x.n <= d.shapes.length);
    },
    /**
     * The comment made of `shapes` was added: those shapes leave the draft (one match each, by value); a stroke drawn
     * while it was being saved stays. The mode stays on, with its tool and colour, for the next comment (Esc or ✕ leaves).
     */
    dropShapes: {
      reducer: (s, a: PayloadAction<{ tabId: string; shapes: MediaShape[] }>) => {
        const d = s.drafts[a.payload.tabId];
        if (!d) return;
        const left = [...d.shapes];
        for (const sh of a.payload.shapes) {
          const k = JSON.stringify(sh);
          const i = left.findIndex((x) => JSON.stringify(x) === k);
          if (i >= 0) left.splice(i, 1);
        }
        d.shapes = left;
        delete d.edits; // the indices moved
        delete d.sel;
      },
      prepare: (tabId: string, shapes: MediaShape[]) => ({ payload: { tabId, shapes } }),
    },
    /** Drops the shapes and leaves the mode; the tool and colour stay for the next drawing. */
    clear: (s, a: PayloadAction<string>) => {
      const d = s.drafts[a.payload];
      if (d) s.drafts[a.payload] = { on: false, tool: d.tool, color: d.color, shapes: [] };
    },
  },
  // another folder: its tabs are other files even when a path is the same, so the drafts are parked under the folder
  // left and the new folder's own come back (the first root merges: drafts made before it was known are its own)
  extraReducers: (b) => b.addCase(enterRoot, (s, a) => {
    const { root, first } = a.payload;
    if (!first && root !== s.root) {
      if (s.root !== null && Object.keys(s.drafts).length) s.parked[s.root] = s.drafts;
      s.drafts = s.parked[root] ?? {};
      delete s.parked[root];
    }
    s.root = root;
  }),
});

export const { setMode, setTool, setColor, addShape, select, removeShape, replaceShape, commitEdit, undo, clear, dropShapes } = markupSlice.actions;

export const selectDraft = (s: RootState, tabId: string): Draft => s.markup.drafts[tabId] ?? EMPTY;
