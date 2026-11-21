// The Settings tab's host, as its sections see it (issue 511): the sections come from several plugins and share one
// POST helper, one status line, one confirm dialog and one read of the server's prefs.
import { createContext, useContext } from 'react';
import type { AgentMode } from '@nota-bene/shared';
import type { Sounds } from './storage.ts';
import { defineResource } from './repository.ts';
import { routes, type Route } from './routes.ts';

export interface SettingsHost {
  /** POSTs `body` as JSON; a refusal or a network error is told in the tab's status line and gives null */
  post(route: Route, body?: unknown): Promise<Response | null>;
  /** the line at the top of the tab (an action's outcome); null clears it */
  note(text: string | null): void;
  /** asks first: `run` after the confirm */
  ask(a: { title: string; body: string; confirm: string; run: () => unknown }): void;
}

export const SettingsContext = createContext<SettingsHost | null>(null);
export const useSettings = (): SettingsHost => {
  const host = useContext(SettingsContext);
  if (!host) throw new Error('useSettings: outside the Settings tab');
  return host;
};

/** What `GET /system/prefs` answers: this agent's prefs, kept by its server. `shells`: Windows only. */
export type SystemPrefs = {
  defaultMode: AgentMode;
  updateCheck?: boolean;
  updateCheckForcedOff?: boolean;
  audit?: boolean;
  auditDir?: string;
  sounds?: Sounds;
  shell?: string;
  shells?: Record<string, string | null>;
};
/** The prefs as Settings shows them: one read for every row (reloaded after a row saves one). */
export const systemPrefs = defineResource<void, SystemPrefs>({ key: () => '', route: () => routes.systemPrefs() });
