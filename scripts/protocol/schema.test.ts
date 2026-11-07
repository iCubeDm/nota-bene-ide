import { PROTOCOL } from '@nota-bene/shared';
import { expect, it } from 'vitest';
import { buildSchema, serialize } from './schema.ts';

function refs(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => refs(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string') out.push(x);
      else refs(x, out);
    }
  }
  return out;
}

it('holds every root and what it reaches', () => {
  const s = buildSchema();
  for (const k of ['ClientMessage', 'ServerEvent', 'UsageReport', 'Comment', 'Anchor', 'WireAgentEvent']) expect(s.definitions).toHaveProperty(k);
  const missing = refs(s).filter((r) => !(r.replace('#/definitions/', '') in s.definitions));
  expect(missing).toEqual([]);
});

it('carries the protocol version', () => {
  expect(buildSchema()['x-protocol']).toBe(PROTOCOL);
});

it('is deterministic', () => {
  expect(serialize(buildSchema())).toBe(serialize(buildSchema()));
});
