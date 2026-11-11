import type { JSONSchema7Definition } from 'json-schema';
import { expect, it } from 'vitest';
import { schemaToDart } from './dart.ts';
import { buildSchema, type ProtocolSchema } from './schema.ts';

const schema = (definitions: Record<string, JSONSchema7Definition>): ProtocolSchema => ({ $schema: 'http://json-schema.org/draft-07/schema#', 'x-protocol': 7, definitions });
const lit = (value: string): JSONSchema7Definition => ({ type: 'string', const: value });
const obj = (properties: Record<string, JSONSchema7Definition>, required: string[]): JSONSchema7Definition => ({ type: 'object', properties, required });

it('an object with optional and required-nullable fields', () => {
  const dart = schemaToDart(schema({
    Thing: obj({ a: { type: 'string' }, b: { type: 'number' }, c: { type: ['string', 'null'] }, resets_at: { type: 'integer' } }, ['a', 'c']),
  }));
  expect(dart).toContain('final String a;');
  expect(dart).toContain('final num? b;');
  expect(dart).toContain('final String? c;');
  expect(dart).toContain('final int? resetsAt;');
  expect(dart).toContain("'c': c,");
  expect(dart).toContain("if (b != null) 'b': b,");
  expect(dart).toContain("resetsAt: json['resets_at'] as int?");
});

it('a discriminated union with an unknown variant', () => {
  const dart = schemaToDart(schema({
    E: { anyOf: [obj({ kind: lit('x'), n: { type: 'number' } }, ['kind', 'n']), obj({ kind: lit('y') }, ['kind'])] },
  }));
  expect(dart).toContain('sealed class E');
  expect(dart).toContain('final class EX extends E');
  expect(dart).toContain('final class EY extends E');
  expect(dart).toContain('final class EUnknown extends E');
  expect(dart).toContain("'x' => EX.fromJson(json),");
  expect(dart).toContain('_ => EUnknown(json),');
  expect(dart).toContain("'kind': 'x',");
});

it('a union with one variant lacking the discriminator', () => {
  const dart = schemaToDart(schema({
    Anchor: { anyOf: [{ $ref: '#/definitions/TextAnchor' }, { $ref: '#/definitions/MediaAnchor' }] },
    TextAnchor: obj({ quote: { type: 'string' } }, ['quote']),
    MediaAnchor: obj({ kind: lit('media'), at: { type: 'number' } }, ['kind', 'at']),
  }));
  expect(dart).toContain("if (!json.containsKey('kind')) return TextAnchor.fromJson(json);");
  expect(dart).toContain('final class TextAnchor extends Anchor');
  expect(dart).toContain('final class MediaAnchor extends Anchor');
  expect(dart).toContain("'media' => MediaAnchor.fromJson(json),");
});

it('an enum with $unknown', () => {
  const dart = schemaToDart(schema({
    Mode: { anyOf: [lit('a-b'), lit('c'), lit('#ff3b30'), lit('image/png')] },
    Effort: { type: 'string', enum: ['low', 'high'] },
  }));
  expect(dart).toContain('enum Mode implements _Json {\n  aB,\n  c,\n  v_ff3b30,\n  image_png,\n  $unknown;');
  expect(dart).toContain("'a-b' => aB,");
  expect(dart).toContain('enum Effort implements _Json {\n  low,\n  high,\n  $unknown;');
  expect(dart).toContain('StateError');
});

it('two enum values on one name throw', () => {
  expect(() => schemaToDart(schema({ Mode: { type: 'string', enum: ['a-b', 'a_b'] } }))).toThrow(/Mode/);
});

it('a variant with several discriminator values', () => {
  const dart = schemaToDart(schema({
    MediaShape: { anyOf: [obj({ kind: { type: 'string', enum: ['rect', 'ellipse'] }, w: { type: 'number' } }, ['kind', 'w']), obj({ kind: lit('arrow') }, ['kind'])] },
  }));
  expect(dart).toContain('final class MediaShapeRectOrEllipse extends MediaShape');
  expect(dart).toContain("'rect' || 'ellipse' => MediaShapeRectOrEllipse.fromJson(json),");
  expect(dart).toContain('enum MediaShapeRectOrEllipseKind');
  expect(dart).toContain('final MediaShapeRectOrEllipseKind kind;');
});

it('nested objects, arrays, maps and tuples', () => {
  const dart = schemaToDart(schema({
    Stats: obj({
      context: { anyOf: [obj({ used: { type: 'number' } }, ['used']), { type: 'null' }] },
      windows: { type: 'array', items: obj({ n: { type: 'number' } }, ['n']) },
      input: { type: 'object', additionalProperties: {} },
      pos: { type: 'array', items: [{ type: 'number' }, { type: 'number' }, { type: 'number' }], minItems: 3, maxItems: 3 },
      status: { type: 'string', enum: ['open', 'done'] },
    }, ['context', 'windows']),
  }));
  expect(dart).toContain('final class StatsContext');
  expect(dart).toContain('final StatsContext? context;');
  expect(dart).toContain('final class StatsWindowsItem');
  expect(dart).toContain('final List<StatsWindowsItem> windows;');
  expect(dart).toContain('final Map<String, Object?>? input;');
  expect(dart).toContain('final List<num>? pos;');
  expect(dart).toContain('enum StatsStatus');
});

it('helpers are emitted only when used', () => {
  const dart = schemaToDart(schema({ Thing: obj({ a: { type: 'string' } }, ['a']) }));
  expect(dart).toContain('abstract interface class _Json');
  expect(dart).not.toContain('_listOrNull');
  expect(dart).not.toContain('_jsonMap');
});

it('throws on an unsupported shape, naming the definition and the pointer', () => {
  const bad = schema({ Odd: obj({ v: { oneOf: [{ type: 'string' }, { type: 'number' }] } }, ['v']) });
  expect(() => schemaToDart(bad)).toThrow(/Odd #\/definitions\/Odd\/properties\/v/);
  expect(() => schemaToDart(schema({ Odd: { anyOf: [{ type: 'string' }, { type: 'number' }] } }))).toThrow(/Odd/);
});

// building the schema compiles protocol.ts: seconds on a loaded CI runner
it('the real schema converts', () => {
  const dart = schemaToDart(buildSchema());
  expect(dart).toContain('const int protocolVersion = 16;');
  expect(dart).toContain('sealed class ServerEvent');
  expect(dart).toContain('final class ServerEventReplay');
  expect(dart).toContain('List<ServerEvent> events');
  expect(dart).toContain('final class TextAnchor extends Anchor');
  expect(dart).toContain('final class MediaShapeRectOrEllipse extends MediaShape');
  expect(dart).toContain('enum AgentMode');
  expect(schemaToDart(buildSchema())).toBe(dart);
}, 60_000);
