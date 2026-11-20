import { createSlice } from '@reduxjs/toolkit';
import { has, type RemoteState, type ServerEvent } from '@nota-bene/shared';
import { serverEvent, type RootState } from '@/sdk';


export type RemotePair = Extract<ServerEvent, { kind: 'remote-pair' }>;
export type RemoteSlice = {
  /** the window's server is new enough (`hello.protocol`): before it, no indicator and no tab */
  supported: boolean;
  /** it also takes an access key */
  keys: boolean;
  /** it also connects to other computers */
  computers: boolean;
  /** null until the first `remote` event */
  state: RemoteState | null;
  /** the last outcome of this window's pairing, until the tab starts another or dismisses it */
  pair: RemotePair | null;
};

const initialState: RemoteSlice = { supported: false, keys: false, computers: false, state: null, pair: null };

export const remoteSlice = createSlice({
  name: 'remote',
  initialState,
  reducers: {
    clearPair: (s) => { s.pair = null; },
  },
  extraReducers: (b) =>
    b.addCase(serverEvent, (s, a) => {
      const ev = a.payload;
      if (ev.kind === 'hello') {
        s.supported = has(ev.protocol, 'remote');
        s.keys = has(ev.protocol, 'accessKeys');
        s.computers = has(ev.protocol, 'remoteHosts');
      }
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
