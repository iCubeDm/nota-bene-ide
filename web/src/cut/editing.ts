import type { Cut } from '@nota-bene/shared/cut';

/** What the timeline and the preview need to edit an edit (issue 409); absent, they are read-only. */
export type Editing = {
  /** the edit as committed: a drag works from it, whatever it shows meanwhile */
  cut: Cut;
  sel: string | null;
  select: (id: string | null) => void;
  /** the edit shown while a drag goes on (null: the committed one); never saved */
  draft: (c: Cut | null) => void;
  /** a finished change: a step of the history, saved */
  commit: (c: Cut) => void;
  /** a source's length in seconds, once known */
  lenOf: (src: string) => number | undefined;
  /** a project file dropped on a track (null: below the tracks, a new one) at `at` seconds */
  addFile: (src: string, track: string | null, at: number) => void;
};
