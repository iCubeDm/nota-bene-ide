// The background tasks (issue 545): server data the tasks drawer and the subagents' cards both read, so core.
import { createSelector, createSlice } from '@reduxjs/toolkit';
import { reduceTasks, type TasksState } from '@nota-bene/shared';
import { serverEvent, type RootState } from './store.ts';

export const tasksSlice = createSlice({
  name: 'tasks',
  initialState: {} as TasksState,
  reducers: {},
  extraReducers: (b) => b.addCase(serverEvent, (s, a) => reduceTasks(s as TasksState, a.payload)),
});

/** The tool-use ids of the Agent calls whose task is still running (the card's "running"). */
export const selectLiveCalls = createSelector([(s: RootState) => s.tasks], (t): ReadonlySet<string> =>
  new Set(Object.values(t).flatMap((x) => (x.call && x.status === 'running' ? [x.call] : []))));

/** How the task that started the tool call `call` ended, when it ended badly (the card says so instead of "done"). */
export const selectCallEnd = (s: RootState, call: string): 'failed' | 'stopped' | undefined => {
  const e = Object.values(s.tasks).find((x) => x.call === call && (x.status === 'failed' || x.status === 'stopped'));
  return e?.status === 'failed' || e?.status === 'stopped' ? e.status : undefined;
};
