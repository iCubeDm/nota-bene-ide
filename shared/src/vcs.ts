/** The read-only git views' answers (`/vcs-*`). */
export type VcsFile = { path: string; old?: string; status: 'A' | 'M' | 'D' | 'R'; add: number | null; del: number | null; binary: boolean };
export type VcsBaseHow = 'reflog' | 'default' | 'none';
export type VcsDiff = { repo: false } | {
  repo: true;
  branch: string | null;
  /** a working folder, not a branch's commits only */
  live: boolean;
  /** what the range starts from; null: only what is not committed, or nothing to compare */
  base: string | null;
  /** the source's own base, whatever is picked */
  detected: string | null;
  how: VcsBaseHow;
  uncommitted: boolean;
  /** `base` shares no history with the source */
  unrelated: boolean;
  mergeBase: string | null;
  commits: { sha: string; subject: string }[];
  candidates: string[];
  files: VcsFile[];
  truncated: boolean;
};
export type VcsPatch = { patch: string; truncated: boolean };
export type VcsBranch = { id: string; branch: string | null; base: string | null; ahead: number; dirty: boolean; busy: boolean; at: number };
export type VcsCommit = { sha: string; parents: string[]; author: string; at: number; subject: string; refs: string[] };
export type VcsLog = { repo: boolean; commits: VcsCommit[]; tip: string | null; more: boolean };
export type VcsCommitDetail = { sha: string; author: string; at: number; message: string; files: VcsFile[]; truncated: boolean };
