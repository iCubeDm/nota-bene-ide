import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { orderedTasks, reduceTasks, type Task, type TaskStatus, type TasksState } from '@nota-bene/shared';
import { serverEvent, type AppThunk, type RootState } from '../store/store.ts';

export type { Task, TasksState } from '@nota-bene/shared';

export const tasksSlice = createSlice({
  name: 'tasks',
  initialState: {} as TasksState,
  reducers: {},
  extraReducers: (b) => b.addCase(serverEvent, (s, a) => reduceTasks(s as TasksState, a.payload)),
});

/** The first protocol whose server takes `task-stop` / `task-background` and serves `/task-output`: below it the controls are absent, not disabled. */
export const TASKS_PROTOCOL = 8;

/** The drawer's state: whether it is open (the rows come from `tasks`), and how many task refusals the server has sent. */
export const tasksUiSlice = createSlice({
  name: 'tasksUi',
  initialState: { open: false, refusals: 0 },
  reducers: {
    setDrawer: (s, a: PayloadAction<boolean>) => void (s.open = a.payload),
    toggleDrawer: (s) => void (s.open = !s.open),
  },
  // the server refused a stop / to-background (its `task` error): a button waiting for its answer may try again
  extraReducers: (b) => b.addCase(serverEvent, (s, a) => void (a.payload.kind === 'server-error' && a.payload.where === 'task' && s.refusals++)),
});
export const { setDrawer, toggleDrawer } = tasksUiSlice.actions;
export const selectDrawerOpen = (s: RootState): boolean => s.tasksUi.open;

/** The tool-use ids of the Agent calls whose task is still running (the card's "running"). */
export const selectLiveCalls = createSelector([(s: RootState) => s.tasks], (t): ReadonlySet<string> =>
  new Set(Object.values(t).flatMap((x) => (x.call && x.status === 'running' ? [x.call] : []))));

export const selectTasks = (s: RootState): TasksState => s.tasks;
/** How many tasks run (what the indicator, the pulse and the favicon count). */
export const selectRunningCount = createSelector([selectTasks], (t) => Object.values(t).filter((x) => x.status === 'running' && !x.ambient).length);
/** Running watchers (`ambient`): only they exist => the indicator shows a quiet variant, so the drawer stays reachable. */
export const selectWatcherCount = createSelector([selectTasks], (t) => Object.values(t).filter((x) => x.status === 'running' && x.ambient).length);
/** Finished tasks, not counting watchers (`ambient`, listed in the drawer but never activity). */
export const selectFinishedCount = createSelector([selectTasks], (t) => Object.values(t).filter((x) => x.status !== 'running' && !x.ambient).length);

/** A swarm: the agents one model response launched, as one row. `live`: the running members, the ones Stop all stops. */
export type TaskGroup = {
  key: string; ids: string[]; live: string[]; status: TaskStatus;
  total: number; running: number; done: number; failed: number; stopped: number; tokens: number;
  /** the first start; `end`, the last end, once none runs */ start: number; end?: number;
};
export type TaskRow = { id: string; depth: number } & ({ task: Task; group?: undefined } | { group: TaskGroup; task?: undefined });

function swarm(key: string, members: [string, Task][]): TaskGroup {
  const ts = members.map(([, x]) => x);
  const n = (st: TaskStatus) => ts.filter((x) => x.status === st).length;
  const g = { running: n('running'), done: n('done'), failed: n('failed'), stopped: n('stopped') };
  return {
    key, ids: members.map(([id]) => id), live: members.flatMap(([id, x]) => (x.status === 'running' ? [id] : [])), ...g, total: ts.length,
    status: g.running ? 'running' : g.failed ? 'failed' : g.stopped ? 'stopped' : 'done',
    tokens: ts.reduce((a, x) => a + x.tokens, 0), start: Math.min(...ts.map((x) => x.start)),
    ...(g.running ? {} : { end: Math.max(...ts.map((x) => x.end ?? x.start)) }),
  };
}

/**
 * The drawer's rows: the running tasks (oldest first) then the finished (newest ended first); a task that has a known
 * parent task is nested under it (`depth` 1+), whatever its own status; one whose parent is unknown (never started here,
 * or pushed out by the cap) stands on its own. Two or more agents of one `group` under the same parent (or none) are a
 * swarm: an umbrella row where its first member would stand, its members nested under it.
 */
export const selectTaskRows = createSelector([selectTasks], (t): TaskRow[] => {
  // a finished parent with a running descendant is shown with the running rows (the live child must not sink into the finished block)
  const ordered0 = orderedTasks(t);
  const live = new Set<string>();
  for (const [id, x] of ordered0) {
    if (x.status !== 'running') continue;
    for (let p: string | undefined = id, n = 0; p && !live.has(p) && n < 50; p = t[p]?.parent, n++) live.add(p);
  }
  const ordered = [...ordered0.filter(([id]) => live.has(id)), ...ordered0.filter(([id]) => !live.has(id))];
  const kids = new Map<string, [string, Task][]>();
  const roots: [string, Task][] = [];
  for (const e of ordered) {
    const p = e[1].parent;
    if (p && p !== e[0] && t[p]) kids.set(p, [...(kids.get(p) ?? []), e]);
    else roots.push(e);
  }
  const rows: TaskRow[] = [];
  const seen = new Set<string>();
  const walk = (e: [string, Task], depth: number) => {
    if (seen.has(e[0])) return; // a parent cycle (never sent) must not loop
    seen.add(e[0]);
    rows.push({ id: e[0], task: e[1], depth });
    level(kids.get(e[0]) ?? [], depth + 1);
  };
  // one level of siblings: a swarm's umbrella takes its first member's place
  const level = (list: [string, Task][], depth: number) => {
    const swarms = new Map<string, [string, Task][]>();
    for (const e of list) if (e[1].kind === 'agent' && e[1].group) swarms.set(e[1].group, [...(swarms.get(e[1].group) ?? []), e]);
    for (const e of list) {
      const members = e[1].kind === 'agent' && e[1].group ? swarms.get(e[1].group)! : [];
      if (members.length < 2) { walk(e, depth); continue; }
      if (members[0] !== e) continue;
      rows.push({ id: `group:${e[1].group}`, group: swarm(e[1].group!, members), depth });
      for (const m of members) walk(m, depth + 1);
    }
  };
  level(roots, 0);
  return rows;
});

/** The id of the running task started by the tool call `call`, if any (a string, so a selector on it is stable). */
export const selectTaskIdByCall = (s: RootState, call: string): string | undefined =>
  Object.entries(s.tasks).find(([, x]) => x.call === call && x.status === 'running')?.[0];

/** How the task that started the tool call `call` ended, when it ended badly (the card says so instead of "done"). */
export const selectCallEnd = (s: RootState, call: string): 'failed' | 'stopped' | undefined => {
  const e = Object.values(s.tasks).find((x) => x.call === call && (x.status === 'failed' || x.status === 'stopped'));
  return e?.status === 'failed' || e?.status === 'stopped' ? e.status : undefined;
};

/** The ids of the tool calls that have their result, in the chat and in every loaded subagent feed: one scan per change, not one per button. */
export const selectResultedIds = createSelector(
  [(s: RootState) => s.feed.items, (s: RootState) => s.subagents.byTool],
  (items, byTool): ReadonlySet<string> => {
    const ids = new Set<string>();
    const scan = (list: typeof items) => { for (const it of list) if (it.kind === 'tool' && it.result) ids.add(it.id); };
    scan(items);
    for (const e of Object.values(byTool)) scan(e.feed.items);
    return ids;
  },
);

/**
 * "To background" is for a running task that blocks its tool call. The CLI says so (`bg`: false); when it did not, the
 * call having no result yet stands in, and a task of the main thread is never in the foreground once its turn is over
 * (a blocking call cannot outlive the turn). Nothing to send without the call's id.
 */
export const selectForeground = (s: RootState, id: string): boolean => {
  const x = s.tasks[id];
  if (!x || x.status !== 'running' || !x.call) return false;
  if (x.bg !== undefined) return !x.bg;
  return !selectResultedIds(s).has(x.call) && (!!x.parent || s.feed.busy);
};

/** The server understands the task controls (stop, to background, shell output). */
export const selectTaskControls = (s: RootState): boolean => s.controls.protocol >= TASKS_PROTOCOL;

export const stopTask = (id: string | string[]): AppThunk => (_d, getState, { send }) => {
  if (selectTaskControls(getState())) for (const one of typeof id === 'string' ? [id] : id) send({ type: 'task-stop', id: one });
};
export const backgroundTask = (toolUseId: string): AppThunk => (_d, getState, { send }) => {
  if (selectTaskControls(getState())) send({ type: 'task-background', toolUseId });
};
