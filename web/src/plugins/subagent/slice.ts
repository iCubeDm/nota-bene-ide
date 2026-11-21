import { has, type SubagentView } from '@nota-bene/shared';
import { routes, subagentRequested as requested, subagentLoaded as loaded, subagentFailed as failed, type FeedItem, type AppThunk, type RootState } from '@/sdk';

function isView(v: unknown): v is SubagentView {
  const o = v as Partial<SubagentView> | null;
  return !!o && Array.isArray(o.events) && typeof o.running === 'boolean' && typeof o.type === 'string' && typeof o.description === 'string';
}

/** What one fetch came to: the agent runs (poll again), ended, is not in this session, or failed; stale = dropped. */
type FetchResult = 'running' | 'done' | 'gone' | 'error' | 'stale';

/**
 * Reads one subagent for the current session. 404 and 409 (not in this session: switched, or never was) are `gone`,
 * anything else wrong is `error` with a short text, never a silent empty pane. An answer arriving after the
 * conversation changed is dropped.
 */
export const fetchSubagent = (tool: string, signal?: AbortSignal): AppThunk<Promise<FetchResult>> => async (dispatch, getState, { connections }) => {
  const session = getState().feed.session?.id;
  if (!session) return 'stale';
  dispatch(requested({ tool, session }));
  const stale = () => getState().feed.session?.id !== session || signal?.aborted === true;
  // an older server has no /subagent (its page fallback answers HTML): say what helps, not a JSON parse error
  const old = () => (dispatch(failed({ tool, session, status: 'error', error: OLD_SERVER })), 'error' as const);
  const { protocol } = getState().controls;
  if (knownOld(protocol)) return old(); // known old: not even asked
  try {
    const r = await connections.current().fetch(routes.subagent(session, tool), { signal });
    if (stale()) return 'stale';
    if (r.status === 404 || r.status === 409) return (dispatch(failed({ tool, session, status: 'gone' })), 'gone');
    if (!r.ok) return (dispatch(failed({ tool, session, status: 'error', error: `HTTP ${r.status}` })), 'error');
    const body = await r.text();
    if (stale()) return 'stale';
    if (body.trimStart().startsWith('<')) return old();
    const v: unknown = JSON.parse(body);
    if (!isView(v)) return (dispatch(failed({ tool, session, status: 'error', error: 'bad answer' })), 'error');
    dispatch(loaded({ tool, session, view: v }));
    return v.running ? 'running' : 'done';
  } catch (e) {
    if (stale()) return 'stale';
    dispatch(failed({ tool, session, status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return 'error';
  }
};

/** The error of a read from a server without /subagent: the tab asks for a server restart. */
export const OLD_SERVER = 'old-server';

/** A server that said hello and drops `source.agent` from a comment's anchor (before `subagentAnchors`): no comments in a subagent's tab. */
export const knownOld = (protocol: number): boolean => protocol !== 0 && !has(protocol, 'subagentAnchors');

/** Whether the Agent call has its tool_result, looked up in the chat and in every loaded subagent's feed (a nested call is in its parent's). */
export const selectToolResulted = (s: RootState, tool: string): boolean => {
  const has = (items: FeedItem[]) => items.some((it) => it.kind === 'tool' && it.id === tool && !!it.result);
  return has(s.feed.items) || Object.values(s.subagents.byTool).some((e) => has(e.feed.items));
};

