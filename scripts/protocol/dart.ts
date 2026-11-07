// Dart 3 types for the protocol, generated from the JSON Schema (see schema.ts). Objects become final classes, unions of
// objects with a common discriminator become sealed classes (with an Unknown variant, so a newer peer does not fail),
// string enums become enums (with $unknown). A shape it does not understand throws, naming the definition and pointer.
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import type { ProtocolSchema } from './schema.ts';

export const DART_PATH = 'mobile/protocol/lib/src/protocol.g.dart';

type Ty =
  | { k: 'prim'; d: 'String' | 'num' | 'int' | 'bool' | 'Object?'; nullable: boolean }
  | { k: 'class' | 'enum'; name: string; nullable: boolean }
  | { k: 'list' | 'map'; of: Ty; nullable: boolean };
type Field = { json: string; dart: string; ty: Ty; required: boolean };
type Disc = { prop: string; values: string[] };
type ClassDecl = { k: 'class'; name: string; fields: Field[]; bases: string[]; disc?: Disc };
type UnionDecl = { k: 'union'; name: string; prop: string; variants: { values: string[]; name: string }[] };
type EnumDecl = { k: 'enum'; name: string; values: string[] };
type Decl = ClassDecl | UnionDecl | EnumDecl;
type Ctx = { def: string; ptr: string; name: string };

const WIDTH = 80;
const RESERVED = new Set(['assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extends', 'false', 'final', 'finally', 'for', 'if', 'in', 'is', 'new', 'null', 'rethrow', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'var', 'void', 'while', 'with']);
const TAKEN = new Set(['toJson', 'fromJson', 'hashCode', 'runtimeType', 'toString', 'noSuchMethod', 'values', 'index']);
const DISC_PRIORITY = ['type', 'kind', 't'];

const isObj = (n: JSONSchema7Definition | undefined): n is JSONSchema7 => typeof n === 'object' && n !== null;
const words = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean);
const pascal = (s: string) => words(s).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const safe = (s: string) => (RESERVED.has(s) || TAKEN.has(s) ? `${s}_` : s);

function camel(s: string): string {
  const [first, ...rest] = words(s);
  if (!first) throw new Error(`no identifier in "${s}"`);
  return (first[0].toLowerCase() + first.slice(1)) + rest.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

/** the Dart member name of an enum's wire value: camelCase for words, `_` for other characters, `v` before a non-letter */
function memberName(value: string): string {
  if (/^[A-Za-z][A-Za-z0-9]*([-_ ][A-Za-z0-9]+)*$/.test(value)) return safe(camel(value));
  const s = value.replace(/[^A-Za-z0-9]/g, '_');
  return safe(/^[A-Za-z]/.test(s) ? s : `v${s}`);
}

function literals(n: JSONSchema7Definition | undefined): string[] | null {
  if (!isObj(n)) return null;
  if (typeof n.const === 'string') return [n.const];
  if (Array.isArray(n.enum) && n.enum.length && n.enum.every((v) => typeof v === 'string')) return n.enum as string[];
  return null;
}

const dartType = (t: Ty): string => {
  const q = t.nullable ? '?' : '';
  if (t.k === 'prim') return t.d === 'Object?' ? t.d : `${t.d}${q}`;
  if (t.k === 'list') return `List<${dartType(t.of)}>${q}`;
  if (t.k === 'map') return `Map<String, ${dartType(t.of)}>${q}`;
  return `${t.name}${q}`;
};
const nonNull = (t: Ty): Ty => ({ ...t, nullable: false });

// An expression as a call tree, so a line that does not fit breaks the way `dart format` breaks a call: one argument per line.
type Node = string | { fn: string; args: Node[] };
const flat = (n: Node): string => (typeof n === 'string' ? n : `${n.fn}(${n.args.map(flat).join(', ')})`);

/** `prefix` + n + `suffix` on one line when it fits, else the call opened and its arguments one per line */
function lines(n: Node, indent: number, prefix: string, suffix: string): string[] {
  const pad = ' '.repeat(indent);
  const one = `${pad}${prefix}${flat(n)}${suffix}`;
  if (one.length <= WIDTH || typeof n === 'string') return [one];
  return [`${pad}${prefix}${n.fn}(`, ...n.args.flatMap((a) => lines(a, indent + 2, '', ',')), `${pad})${suffix}`];
}

const isObjectValue = (t: Ty) => t.k === 'prim' && t.d === 'Object?';
const isJson = (t: Ty) => t.k === 'class' || t.k === 'enum';

/** a decoder of one element: a function from the raw value */
function decoder(t: Ty): Node {
  if (t.k === 'prim') return `_as<${t.d}>`;
  if (t.k === 'class') return { fn: '_obj', args: [`${t.name}.fromJson`] };
  if (t.k === 'enum') return `${t.name}.fromJson`;
  throw new Error('unreachable: nested containers are rejected in typeOf');
}

function fromExpr(t: Ty, e: string): Node {
  if (t.k === 'prim') return t.d === 'Object?' ? e : `${e} as ${dartType(t)}`;
  if (t.k === 'list' || t.k === 'map') {
    if (t.k === 'map' && isObjectValue(t.of)) return `${e} as ${dartType(t)}`;
    return { fn: `_${t.k}${t.nullable ? 'OrNull' : ''}`, args: [e, decoder(t.of)] };
  }
  if (t.nullable) return { fn: '_opt', args: [e, decoder(nonNull(t))] };
  return { fn: `${t.name}.fromJson`, args: [t.k === 'class' ? `${e} as Map<String, Object?>` : e] };
}

function toExpr(t: Ty, e: string): Node {
  if (isJson(t)) return `${e}${t.nullable ? '?' : ''}.toJson()`;
  if ((t.k === 'list' || t.k === 'map') && isJson(t.of)) return { fn: `_json${t.k === 'list' ? 'List' : 'Map'}`, args: [e] };
  return e;
}

/** `head` + items + `tail` on one line when it fits, else one item per line with trailing commas */
function wrap(indent: string, head: string, items: string[], tail: string): string[] {
  const one = `${indent}${head}${items.join(', ')}${tail}`;
  if (one.length <= WIDTH) return [one];
  return [`${indent}${head}`, ...items.map((i) => `${indent}  ${i},`), `${indent}${tail}`];
}

/** a switch arm; an arm that does not fit puts its result on the next line */
function arm(indent: number, pattern: string, result: string): string[] {
  const pad = ' '.repeat(indent);
  const one = `${pad}${pattern} => ${result},`;
  return one.length <= WIDTH ? [one] : [`${pad}${pattern} =>`, `${pad}  ${result},`];
}

export function schemaToDart(schema: ProtocolSchema): string {
  const defs = schema.definitions;
  const decls = new Map<string, Decl>();
  const variantOf = new Map<string, { union: string; disc: Disc }[]>();

  const fail = (c: { def: string; ptr: string }, what: string): never => {
    throw new Error(`protocol schema: ${what} at ${c.def} ${c.ptr}`);
  };
  const add = (d: Decl, c: Ctx) => {
    if (decls.has(d.name)) fail(c, `the name ${d.name} is used twice`);
    decls.set(d.name, d);
  };
  const defNode = (name: string, c: Ctx): JSONSchema7 => {
    const n = defs[name];
    return isObj(n) ? n : fail(c, `unknown definition ${name}`);
  };
  const isNull = (n: JSONSchema7Definition) => isObj(n) && n.type === 'null';
  const refName = (n: JSONSchema7Definition): string | null => (isObj(n) && n.$ref ? n.$ref.replace('#/definitions/', '') : null);
  const isObjectNode = (n: JSONSchema7Definition) => isObj(n) && n.type === 'object' && !!n.properties;

  /** which declaration a definition becomes */
  function defKind(name: string): 'class' | 'union' | 'enum' | 'num' | 'other' {
    const n = defNode(name, { def: name, ptr: '', name });
    if (n.anyOf && !n.anyOf.some(isNull)) {
      if (n.anyOf.every((m) => literals(m)?.length === 1)) return 'enum';
      if (n.anyOf.every((m) => refName(m) !== null || isObjectNode(m))) return 'union';
    }
    if (literals(n)) return 'enum';
    if (n.type === 'number' && n.enum) return 'num';
    if (isObjectNode(n)) return 'class';
    return 'other';
  }

  function refType(name: string, c: Ctx): Ty {
    const kind = defKind(name);
    if (kind === 'num') return { k: 'prim', d: 'num', nullable: false };
    if (kind === 'class' || kind === 'union') return { k: 'class', name, nullable: false };
    if (kind === 'enum') return { k: 'enum', name, nullable: false };
    return fail(c, `the reference to ${name} has a shape with no Dart mapping`);
  }

  function typeOf(n: JSONSchema7Definition, c: Ctx): Ty {
    if (n === true || (isObj(n) && Object.keys(n).every((k) => k === 'description'))) return { k: 'prim', d: 'Object?', nullable: false };
    if (!isObj(n)) return fail(c, 'unsupported schema');
    if (n.$ref) return refType(refName(n)!, c);
    if (Array.isArray(n.type)) {
      const rest = n.type.filter((t) => t !== 'null');
      if (rest.length !== 1 || rest.length === n.type.length) return fail(c, `unsupported type ${JSON.stringify(n.type)}`);
      return { ...typeOf({ ...n, type: rest[0] }, c), nullable: true };
    }
    if (n.anyOf) return anyOfType(n.anyOf, c);
    const lits = literals(n);
    if (lits) return n.const !== undefined ? { k: 'prim', d: 'String', nullable: false } : enumType(lits, c);
    switch (n.type) {
      case 'string': return { k: 'prim', d: 'String', nullable: false };
      case 'number': return { k: 'prim', d: 'num', nullable: false };
      case 'integer': return { k: 'prim', d: 'int', nullable: false };
      case 'boolean': return { k: 'prim', d: 'bool', nullable: false };
      case 'array': {
        if (Array.isArray(n.items)) {
          if (n.items.every((i) => isObj(i) && i.type === 'number')) return { k: 'list', of: { k: 'prim', d: 'num', nullable: false }, nullable: false };
          return fail(c, 'unsupported tuple');
        }
        if (n.items === undefined) return { k: 'list', of: { k: 'prim', d: 'Object?', nullable: false }, nullable: false };
        return { k: 'list', of: element(typeOf(n.items, { ...c, ptr: `${c.ptr}/items`, name: `${c.name}Item` }), c), nullable: false };
      }
      case 'object': {
        if (n.properties) {
          buildClass(c.name, n, c);
          return { k: 'class', name: c.name, nullable: false };
        }
        const extra = n.additionalProperties;
        const of = isObj(extra) || extra === true
          ? element(typeOf(extra, { ...c, ptr: `${c.ptr}/additionalProperties`, name: `${c.name}Value` }), c)
          : ({ k: 'prim', d: 'Object?', nullable: false } as Ty);
        return { k: 'map', of, nullable: false };
      }
    }
    return fail(c, `unsupported schema ${JSON.stringify(n).slice(0, 80)}`);
  }

  /** the element of a list or map: no containers or nulls inside containers (none occur in the protocol) */
  function element(t: Ty, c: Ctx): Ty {
    if (t.nullable || t.k === 'list' || t.k === 'map') return fail(c, 'a nested container or nullable element');
    return t;
  }

  function enumType(values: string[], c: Ctx): Ty {
    const names = new Set<string>();
    for (const v of values) {
      const m = memberName(v);
      if (names.has(m)) fail(c, `enum values collide on ${m}`);
      names.add(m);
    }
    add({ k: 'enum', name: c.name, values }, c);
    return { k: 'enum', name: c.name, nullable: false };
  }

  function anyOfType(members: JSONSchema7Definition[], c: Ctx): Ty {
    const rest = members.filter((m) => !isNull(m));
    const sub = (i: number): Ctx => ({ ...c, ptr: `${c.ptr}/anyOf/${i}` });
    if (rest.length !== members.length) {
      if (rest.length !== 1) return fail(c, 'a union with null and several other members');
      return { ...typeOf(rest[0], sub(members.indexOf(rest[0]))), nullable: true };
    }
    if (rest.length === 1) return typeOf(rest[0], sub(0));
    if (rest.every((m) => literals(m)?.length === 1)) return enumType(rest.map((m) => literals(m)![0]), c);
    if (rest.every((m) => refName(m) !== null || isObjectNode(m))) {
      parseUnion(c.name, rest, c);
      return { k: 'class', name: c.name, nullable: false };
    }
    // a raw JSON value that is either a list or one of a few words (WireAgentEvent answers: string[] | 'all' | 'none')
    if (rest.every((m) => isObj(m) && (m.type === 'array' || m.const !== undefined))) return { k: 'prim', d: 'Object?', nullable: false };
    return fail(c, 'a union of shapes with no Dart mapping');
  }

  function parseUnion(name: string, members: JSONSchema7Definition[], c: Ctx): void {
    const vs = members.map((m, i) => {
      const ref = refName(m);
      const mc: Ctx = { def: c.def, ptr: `${c.ptr}/anyOf/${i}`, name };
      const node = ref ? defNode(ref, mc) : (m as JSONSchema7);
      if (!isObjectNode(node)) fail(mc, `the union ${name} has a member that is not an object`);
      return { ref, node, mc };
    });
    const props = (n: JSONSchema7) => Object.keys(n.properties ?? {});
    const candidates = [...new Set(vs.flatMap((v) => props(v.node)))].flatMap((p) => {
      const has = vs.filter((v) => props(v.node).includes(p));
      const lacking = vs.length - has.length;
      if (lacking > 1 || !has.every((v) => literals(v.node.properties![p]))) return [];
      return [{ p, lacking }];
    });
    candidates.sort((a, b) => a.lacking - b.lacking || (DISC_PRIORITY.indexOf(a.p) + 1 || 99) - (DISC_PRIORITY.indexOf(b.p) + 1 || 99));
    if (!candidates.length) fail(c, `the union ${name} has no common discriminator`);
    const prop = candidates[0].p;
    const seen = new Set<string>();
    const variants: UnionDecl['variants'] = [];
    for (const v of vs) {
      const values = literals(v.node.properties![prop]) ?? [];
      for (const x of values) {
        if (seen.has(x)) fail(v.mc, `the discriminator value ${x} of ${name} is used twice`);
        seen.add(x);
      }
      const vname = v.ref ?? name + values.map(pascal).join('Or');
      if (!values.length && !v.ref) fail(v.mc, `a variant of ${name} has no discriminator and no name`);
      variants.push({ values, name: vname });
      const disc = { prop, values };
      if (v.ref) {
        variantOf.set(v.ref, [...(variantOf.get(v.ref) ?? []), { union: name, disc }]);
      } else {
        buildClass(vname, v.node, v.mc, { union: name, disc });
      }
    }
    add({ k: 'union', name, prop, variants }, c);
  }

  function buildClass(name: string, node: JSONSchema7, c: Ctx, as?: { union: string; disc: Disc }): void {
    const required = new Set(node.required ?? []);
    const own = variantOf.get(name) ?? [];
    if (own.length > 1 && new Set(own.map((o) => o.disc.prop)).size > 1) fail(c, `${name} is a variant of unions with different discriminators`);
    const disc = as?.disc ?? own[0]?.disc;
    const fields: Field[] = [];
    const used = new Set<string>();
    for (const [json, sch] of Object.entries(node.properties ?? {})) {
      if (disc && disc.values.length === 1 && json === disc.prop) continue; // written as a constant by toJson
      const fc: Ctx = { def: c.def, ptr: `${c.ptr}/properties/${json}`, name: name + pascal(json) };
      const dart = safe(camel(json));
      if (used.has(dart)) fail(fc, `fields collide on ${dart}`);
      used.add(dart);
      fields.push({ json, dart, ty: typeOf(sch, fc), required: required.has(json) });
    }
    const bases = [...(as ? [as.union] : []), ...own.map((o) => o.union)];
    add({ k: 'class', name, fields, bases, disc }, c);
  }

  // unions first, so a definition that is a variant knows its union when its class is built
  const names = Object.keys(defs).sort();
  for (const name of names.filter((n) => defKind(n) === 'union')) {
    const c: Ctx = { def: name, ptr: '#/definitions/' + name, name };
    parseUnion(name, (defs[name] as JSONSchema7).anyOf!, c);
  }
  for (const name of names) {
    const c: Ctx = { def: name, ptr: '#/definitions/' + name, name };
    const kind = defKind(name);
    if (kind === 'class') buildClass(name, defs[name] as JSONSchema7, c);
    else if (kind === 'enum') {
      const n = defs[name] as JSONSchema7;
      const lits = literals(n) ?? (n.anyOf ?? []).map((m) => literals(m)![0]);
      enumType(lits, { ...c, ptr: '' });
    } else if (kind === 'other') fail(c, 'a definition with no Dart mapping');
  }

  const blocks = [...decls.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(render);
  return ['// GENERATED by scripts/gen-protocol.ts from shared/src/protocol.ts. Do not edit.', '// ignore_for_file: constant_identifier_names', '', `const int protocolVersion = ${schema['x-protocol']};`, '', [...blocks, ...helpersFor(blocks.join('\n'))].join('\n\n')].join('\n') + '\n';
}

function render(d: Decl): string {
  return d.k === 'enum' ? renderEnum(d) : d.k === 'union' ? renderUnion(d) : renderClass(d);
}

const q = (s: string) => `'${s.replace(/[\\']/g, '\\$&').replace(/\$/g, '\\$')}'`;

function unknownArm(name: string): string[] {
  const msg = q(`${name}.$unknown cannot be sent`);
  if (`    $unknown => throw StateError(${msg}),`.length <= WIDTH) return [`    $unknown => throw StateError(${msg}),`];
  if (`      throw StateError(${msg}),`.length <= WIDTH) return ['    $unknown =>', `      throw StateError(${msg}),`];
  return ['    $unknown =>', '      throw StateError(', `        ${msg},`, '      ),'];
}

function renderEnum(d: EnumDecl): string {
  const members = d.values.map(memberName);
  return [
    `enum ${d.name} implements _Json {`,
    `  ${[...members, '$unknown'].join(',\n  ')};`,
    '',
    `  static ${d.name} fromJson(Object? v) => switch (v) {`,
    ...d.values.flatMap((v, i) => arm(4, q(v), members[i])),
    '    _ => $unknown,',
    '  };',
    '',
    '  @override',
    '  String toJson() => switch (this) {',
    ...d.values.flatMap((v, i) => arm(4, members[i], q(v))),
    ...unknownArm(d.name),
    '  };',
    '}',
  ].join('\n');
}

function renderUnion(d: UnionDecl): string {
  const lacking = d.variants.filter((v) => !v.values.length);
  const arms = d.variants.filter((v) => v.values.length).flatMap((v) => arm(6, v.values.map(q).join(' || '), `${v.name}.fromJson(json)`));
  return [
    `sealed class ${d.name} implements _Json {`,
    `  const ${d.name}();`,
    '',
    `  factory ${d.name}.fromJson(Map<String, Object?> json) {`,
    ...lacking.map((v) => `    if (!json.containsKey(${q(d.prop)})) return ${v.name}.fromJson(json);`),
    `    return switch (json[${q(d.prop)}]) {`,
    ...arms,
    `      _ => ${d.name}Unknown(json),`,
    '    };',
    '  }',
    '',
    '  @override',
    '  Map<String, Object?> toJson();',
    '}',
    '',
    `final class ${d.name}Unknown extends ${d.name} {`,
    `  const ${d.name}Unknown(this.raw);`,
    '',
    '  final Map<String, Object?> raw;',
    '',
    '  @override',
    '  Map<String, Object?> toJson() => raw;',
    '}',
  ].join('\n');
}

function renderClass(d: ClassDecl): string {
  const single = d.disc && d.disc.values.length === 1 ? d.disc : undefined;
  const fields = d.fields;
  const [base, ...more] = d.bases;
  const heritage = (base ? ` extends ${base}` : '') + (more.length ? ` implements ${more.join(', ')}` : base ? '' : ' implements _Json');
  const nullable = (f: Field) => !f.required || f.ty.nullable;
  const typed = (f: Field): Ty => (f.required ? f.ty : { ...f.ty, nullable: true });
  const ctorParams = fields.map((f) => `${nullable(f) ? '' : 'required '}this.${f.dart}`);
  const ctor = fields.length ? wrap('  ', `const ${d.name}({`, ctorParams, '});') : [`  const ${d.name}();`];
  const argNodes = fields.map((f) => fromExpr(typed(f), `json[${q(f.json)}]`));
  const argsFlat = fields.map((f, i) => `${f.dart}: ${flat(argNodes[i])}`).join(', ');
  const args = `    return ${d.name}(${argsFlat});`.length <= WIDTH
    ? [`    return ${d.name}(${argsFlat});`]
    : [`    return ${d.name}(`, ...fields.flatMap((f, i) => lines(argNodes[i], 6, `${f.dart}: `, ',')), '    );'];
  const entries = [
    ...(single ? [`${q(single.prop)}: ${q(single.values[0])},`] : []),
    ...fields.flatMap((f) => {
      const key = q(f.json);
      if (f.required) return lines(toExpr(f.ty, f.dart), 6, `${key}: `, ',').map((l) => l.slice(6));
      const cond = `if (${f.dart} != null)`;
      const nn = { ...f.ty, nullable: false };
      const value = toExpr(nn, isJson(nn) ? `${f.dart}!` : f.dart);
      const one = `      ${cond} ${key}: ${flat(value)},`;
      if (one.length <= WIDTH) return [one.slice(6)];
      return [cond, ...lines(value, 2, `${key}: `, ',')];
    }),
  ];
  const oneLineMap = `    return {${entries.map((e) => e.replace(/,$/, '')).join(', ')}};`;
  const mapLines = entries.length && entries.every((e) => !e.includes('\n')) && oneLineMap.length <= WIDTH && !entries.some((e) => e.endsWith('(') || e.startsWith('  ') || e.startsWith(')'))
    ? [oneLineMap]
    : ['    return {', ...entries.map((e) => `      ${e}`), '    };'];
  return [
    `final class ${d.name}${heritage} {`,
    ...ctor,
    '',
    `  factory ${d.name}.fromJson(Map<String, Object?> json) {`,
    ...(fields.length ? args : [`    return const ${d.name}();`]),
    '  }',
    ...(fields.length ? ['', ...fields.map((f) => `  final ${dartType(typed(f))} ${f.dart};`)] : []),
    '',
    '  @override',
    '  Map<String, Object?> toJson() {',
    ...(entries.length ? mapLines : ['    return {};']),
    '  }',
    '}',
  ].join('\n');
}

// What the generated code shares: raw-value casts, and the list/map/optional wrappers around a decoder or an encoder.
// A helper is emitted only when something uses it (an unused private function is an analyzer warning).
const HELPERS: { name: string; uses: string[]; code: string }[] = [
  { name: '_Json', uses: [], code: 'abstract interface class _Json {\n  Object? toJson();\n}' },
  { name: '_as', uses: [], code: 'T _as<T>(Object? v) => v as T;' },
  { name: '_obj', uses: [], code: 'T Function(Object?) _obj<T>(T Function(Map<String, Object?>) f) {\n  return (v) => f(v as Map<String, Object?>);\n}' },
  { name: '_opt', uses: [], code: 'T? _opt<T>(Object? v, T Function(Object?) f) => v == null ? null : f(v);' },
  { name: '_list', uses: [], code: 'List<T> _list<T>(Object? v, T Function(Object?) f) {\n  return (v as List<Object?>).map(f).toList();\n}' },
  { name: '_listOrNull', uses: ['_list'], code: 'List<T>? _listOrNull<T>(Object? v, T Function(Object?) f) {\n  return v == null ? null : _list(v, f);\n}' },
  { name: '_map', uses: [], code: 'Map<String, T> _map<T>(Object? v, T Function(Object?) f) {\n  return (v as Map<String, Object?>).map((k, e) => MapEntry(k, f(e)));\n}' },
  { name: '_mapOrNull', uses: ['_map'], code: 'Map<String, T>? _mapOrNull<T>(Object? v, T Function(Object?) f) {\n  return v == null ? null : _map(v, f);\n}' },
  { name: '_jsonList', uses: [], code: 'List<Object?>? _jsonList(List<_Json>? xs) {\n  return xs?.map((x) => x.toJson()).toList();\n}' },
  { name: '_jsonMap', uses: [], code: 'Map<String, Object?>? _jsonMap(Map<String, _Json>? xs) {\n  return xs?.map((k, x) => MapEntry(k, x.toJson()));\n}' },
];

function helpersFor(body: string): string[] {
  const used = new Set<string>();
  const need = (n: string) => {
    if (used.has(n)) return;
    used.add(n);
    HELPERS.find((h) => h.name === n)!.uses.forEach(need);
  };
  for (const h of HELPERS) if (new RegExp(`${h.name}\\b`).test(body)) need(h.name);
  return HELPERS.filter((h) => used.has(h.name)).map((h) => h.code);
}
