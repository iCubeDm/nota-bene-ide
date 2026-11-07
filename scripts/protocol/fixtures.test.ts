import { parseClientMessage } from '@nota-bene/shared';
import Ajv from 'ajv';
import fs from 'node:fs';
import { expect, it } from 'vitest';
import { SCHEMA_PATH } from './schema.ts';

const read = (p: string) => JSON.parse(fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
const schema = read(SCHEMA_PATH);
const fx = read('shared/fixtures/protocol.json') as { client: any[]; server: any[]; usage: any[] };
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema, 'p');
const validator = (root: string) => ajv.compile({ $ref: `p#/definitions/${root}` });

function failures(items: unknown[], root: string): string[] {
  const v = validator(root);
  return items.flatMap((it, i) => (v(it) ? [] : [`${root}[${i}]: ${ajv.errorsText(v.errors)}`]));
}

it('every fixture is valid', () => {
  expect([...failures(fx.client, 'ClientMessage'), ...failures(fx.server, 'ServerEvent'), ...failures(fx.usage, 'UsageReport')]).toEqual([]);
});

it('the parser takes every client fixture as it is', () => {
  for (const item of fx.client) expect(parseClientMessage(JSON.stringify(item))).toEqual(item);
});

// the values a variant pins down: its const or single-value enum
function tags(def: any, prop: string): string[] {
  const out: string[] = [];
  const walk = (d: any) => {
    if (d?.$ref) return walk(schema.definitions[d.$ref.replace('#/definitions/', '')]);
    for (const k of ['anyOf', 'oneOf']) if (d?.[k]) return d[k].forEach(walk);
    const p = d?.properties?.[prop];
    if (p?.const !== undefined) out.push(p.const);
    else if (p?.enum) out.push(...p.enum);
  };
  walk(def);
  return out;
}

it('every variant has a fixture', () => {
  const agent = [...fx.server.filter((e) => e.kind === 'agent').map((e) => e.e), ...fx.server.filter((e) => e.kind === 'replay').flatMap((e) => e.events).filter((e: any) => e.kind === 'agent').map((e: any) => e.e)];
  const want = {
    type: [tags(schema.definitions.ClientMessage, 'type'), new Set(fx.client.map((m) => m.type))],
    kind: [tags(schema.definitions.ServerEvent, 'kind'), new Set([...fx.server.map((e) => e.kind), ...fx.server.filter((e) => e.kind === 'replay').flatMap((e) => e.events.map((x: any) => x.kind))])],
    t: [tags(schema.definitions.WireAgentEvent, 't'), new Set(agent.map((e) => e.t))],
  } as const;
  const missing = Object.entries(want).flatMap(([prop, [all, have]]) => {
    expect(all.length).toBeGreaterThan(5);
    return (all as string[]).filter((v) => !(have as Set<string>).has(v)).map((v) => `${prop}=${v}`);
  });
  expect(missing).toEqual([]);
});
