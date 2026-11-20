// A usage-event point (issue 511): the last events in memory, for tests and a future local view. Nothing is stored and
// nothing leaves the machine.
export type TrackProps = Record<string, string | number | boolean>;
export type Tracked = { name: string; props?: TrackProps; at: number };

const KEEP = 200;
const ring: Tracked[] = [];

export function track(name: string, props?: TrackProps): void {
  ring.push({ name, ...(props && { props }), at: Date.now() });
  if (ring.length > KEEP) ring.shift();
}
/** the last 200 events, oldest first */
track.recent = (): Tracked[] => [...ring];
