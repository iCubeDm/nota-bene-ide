import { createSlice } from '@reduxjs/toolkit';
import type { RemoteState, ServerEvent } from '@nota-bene/shared';
import { serverEvent, type RootState } from '../store/store.ts';

/** The server that has the `remote` event and the /remote routes. */
export const REMOTE_PROTOCOL = 20;

export type RemotePair = Extract<ServerEvent, { kind: 'remote-pair' }>;
export type RemoteSlice = {
  /** the window's server is new enough (`hello.protocol`): before it, no indicator and no tab */
  supported: boolean;
  /** null until the first `remote` event */
  state: RemoteState | null;
  /** the last outcome of this window's pairing, until the tab starts another or dismisses it */
  pair: RemotePair | null;
};

const initialState: RemoteSlice = { supported: false, state: null, pair: null };

export const remoteSlice = createSlice({
  name: 'remote',
  initialState,
  reducers: {
    clearPair: (s) => { s.pair = null; },
  },
  extraReducers: (b) =>
    b.addCase(serverEvent, (s, a) => {
      const ev = a.payload;
      if (ev.kind === 'hello') s.supported = ev.protocol >= REMOTE_PROTOCOL;
      else if (ev.kind === 'remote') s.state = ev.state;
      else if (ev.kind === 'remote-pair') s.pair = ev;
    }),
});

export const { clearPair } = remoteSlice.actions;
export const selectRemote = (s: RootState): RemoteSlice => s.remote;

export type Indicator = 'off' | 'connecting' | 'online' | 'trouble';

/** What the header dot says. */
export function indicator(s: RemoteState | null): Indicator {
  if (!s || !s.configured || !s.enabled) return 'off';
  if (s.lastError || s.startFailed) return 'trouble';
  return s.online ? 'online' : 'connecting';
}
