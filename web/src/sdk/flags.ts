// Local feature flags (issue 511): `nb.flag.<name>` in this origin's storage over the typed table below. A flag is added
// with the feature it guards and removed with it; nothing sets one but a hand in the browser's storage.
import { bool, storage, useStored } from './storage.ts';

export const FLAGS = {} as const satisfies Record<string, boolean>;
export type Flag = keyof typeof FLAGS;

const item = (name: Flag) => storage.local(`nb.flag.${name}`, bool, (FLAGS as Record<string, boolean>)[name] ?? false);
export const flag = (name: Flag): boolean => item(name).get();
export const useFlag = (name: Flag): boolean => useStored(item(name));
