import type { Cut } from '@nota-bene/shared/cut';
import type { GroupRefusal } from './ops.ts';

/** The timeline's tool (issue 432): Select (V) picks and drags clips, Blade (C) cuts the clip under a click. */
export type Tool = 'select' | 'blade';

/** What the timeline and the preview need to edit an edit (issue 409); absent, they are read-only. */
export type Editing = {
  /** the edit as committed: a drag works from it, whatever it shows meanwhile */
  cut: Cut;
  /** the selected clips' ids (issue 432: any number of them), in the order they were picked */
  sel: readonly string[];
  select: (ids: readonly string[]) => void;
  tool: Tool;
  /** the blade's cut at `t` seconds: the clip `clip`, or with `all` every clip under `t` */
  blade: (t: number, clip: string | null, all: boolean) => void;
  /** the edit shown while a drag goes on (null: the committed one); never saved */
  draft: (c: Cut | null) => void;
  /** a finished change: a step of the history, saved */
  commit: (c: Cut) => void;
  /** a move of the selection was refused (issue 442): the edit bar says why until the next change */
  refuse: (why: GroupRefusal) => void;
  /** a source's length in seconds, once known */
  lenOf: (src: string) => number | undefined;
  /** a project file dropped on a track (null: below the tracks, a new one) at `at` seconds */
  addFile: (src: string, track: string | null, at: number) => void;
};
