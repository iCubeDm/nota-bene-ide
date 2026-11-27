// The host stream of the end-to-end channel (server/src/remote/CHANNEL.md, Stream kinds): what a computer tells a paired
// phone or computer about its windows. One definition for the server (remote/device.ts), the desktop's link to another
// computer (remote/hostLink.ts) and the phone (generated Dart, mobile/channel).
import type { AgentProvider } from './agent.ts';

/** The latest user message or final reply of a window's session, as the window sends it: one plain line. */
export type LastMessage = {
  role: 'user' | 'assistant';
  text: string;
  /** ms since the epoch; absent or 0 when the window has no time for it (a restored history) */
  at?: number;
};

/**
 * One agent (once: one window) as the host stream lists it. `port`, `provider` and `root` are always there; every other field may be
 * missing (the host could not read the window's /info that time, or an older host).
 */
export type HostWindow = {
  /**
   * The window's stable id (issue 511): `provider:sha1(root)[0..16]`, the same across restarts and port changes; for a
   * second window of the same folder and agent, `<id>:<port>`. Opaque to clients. Absent from a host before it.
   */
  id?: string;
  /**
   * Transport only: the port the host reaches the window on (the `port` of the `ws` / `http` stream kinds).
   * @asType integer
   */
  port: number;
  provider: AgentProvider;
  root: string;
  title?: string | null;
  session?: string | null;
  model?: string | null;
  busy?: boolean;
  supervised?: boolean;
  /** a permission or interaction prompt awaits an answer in the window */
  pending?: boolean;
  last?: LastMessage | null;
  /**
   * The final replies of the session.
   * @asType integer
   */
  replies?: number;
  /**
   * Issue 174: the final replies after the person last saw the session on any client (the window's /info.unseen).
   * Absent from a host before protocol 41.
   * @asType integer
   */
  unseen?: number;
  /** the version (a hash) of the picture of the window's project folder; null when it has none */
  icon?: string | null;
  /**
   * Epic 383: the agent, its streams under `/a/<agent>` (issue 639). Absent from an older host's rows (its one agent
   * answered at the top).
   */
  agent?: string;
};

/** What the host stream sends: the whole list on open and on every change, one row per agent of every server (protocol 38). */
export type HostStreamMessage = { t: 'windows'; windows: HostWindow[] };

/** The fields of a window's /info the host stream passes on. */
export const HOST_WINDOW_INFO = ['title', 'session', 'model', 'busy', 'supervised', 'pending', 'last', 'replies', 'unseen', 'icon'] as const satisfies readonly (keyof HostWindow)[];
