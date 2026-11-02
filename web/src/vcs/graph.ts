export const ROW = 26;
export const STEP = 13;
export const COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff', '#ff9e64', '#73daca'];

type C = { sha: string; parents: string[] };
export type Lane = { col: number; up: [number, number][]; down: [number, number][]; width: number };

/** Lanes top to bottom: each open lane waits for one commit; a commit takes its lane and hands it to its first parent. */
export function layout(commits: C[]): Lane[] {
  const lanes: (string | null)[] = [];
  const out: Lane[] = [];
  const free = (not: number) => { const i = lanes.findIndex((l, k) => l === null && k !== not); return i < 0 ? lanes.length : i; };
  for (const c of commits) {
    let col = lanes.indexOf(c.sha);
    if (col < 0) { col = free(-1); lanes[col] = c.sha; }
    const up: [number, number][] = [];
    lanes.forEach((l, i) => { if (l === null) return; up.push([i, l === c.sha ? col : i]); });
    lanes.forEach((l, i) => { if (l === c.sha) lanes[i] = null; });
    const down: [number, number][] = [];
    lanes.forEach((l, i) => { if (l !== null) down.push([i, i]); });
    c.parents.forEach((p, k) => {
      const had = lanes.indexOf(p);
      if (had >= 0) { down.push([col, had]); return; }
      const slot = k === 0 ? col : free(col);
      lanes[slot] = p;
      down.push([col, slot]);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    out.push({ col, up, down, width: Math.max(lanes.length, col + 1, ...up.map(([a]) => a + 1)) });
  }
  return out;
}
