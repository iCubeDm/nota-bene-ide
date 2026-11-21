// The SDK's export order (issue 511): loaded first in a fresh module graph, every export is defined, none caught
// undefined by an import cycle through the store.
import { expect, it, vi } from 'vitest';

it.each(['./index.ts', './ui.ts'])('%s, imported first, defines every export', async (entry) => {
  vi.resetModules();
  const mod: Record<string, unknown> = await import(entry);
  expect(Object.keys(mod).length).toBeGreaterThan(0);
  expect(Object.entries(mod).filter(([, v]) => v === undefined).map(([k]) => k)).toEqual([]);
});
