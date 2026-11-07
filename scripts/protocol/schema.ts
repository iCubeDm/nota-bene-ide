// The JSON Schema of the browser/server protocol, generated from shared/src/protocol.ts. The schema is the contract
// other-language clients (the Dart types, a later task) are generated from; `npm run gen:protocol -- --check` fails on drift.
import { fileURLToPath } from 'node:url';
import { PROTOCOL } from '@nota-bene/shared';
import type { JSONSchema7Definition } from 'json-schema';
import { createGenerator } from 'ts-json-schema-generator';

export const ROOTS = ['ClientMessage', 'ServerEvent', 'UsageReport'] as const;
export const SCHEMA_PATH = 'shared/schema/protocol.schema.json';

export type ProtocolSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#';
  'x-protocol': number;
  definitions: Record<string, JSONSchema7Definition>;
};

const REPO = fileURLToPath(new URL('../../', import.meta.url));

export function buildSchema(): ProtocolSchema {
  const definitions: Record<string, JSONSchema7Definition> = {};
  for (const type of ROOTS) {
    // additionalProperties: true, because the reverse skew must not fail: a newer peer may add fields
    const gen = createGenerator({
      path: `${REPO}shared/src/protocol.ts`, tsconfig: `${REPO}scripts/protocol/tsconfig.json`, type, expose: 'export', topRef: false,
      jsDoc: 'extended', additionalProperties: true,
    });
    // topRef: false puts the root's own definition at the top level, beside the ones it reaches
    const { $schema: _s, definitions: reached, ...root } = gen.createSchema(type);
    Object.assign(definitions, reached, { [type]: root });
  }
  const sorted = Object.fromEntries(Object.entries(definitions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { $schema: 'http://json-schema.org/draft-07/schema#', 'x-protocol': PROTOCOL, definitions: sorted };
}

// Stable key order for objects, so the file only changes when the protocol does. Arrays keep their order.
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
