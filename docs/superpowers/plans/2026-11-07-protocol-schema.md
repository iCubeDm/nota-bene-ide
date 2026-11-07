# Protocol schema and Dart types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A JSON Schema generated from the existing types in `shared/src/protocol.ts`, Dart types generated from that schema in a pure Dart package, shared fixtures that both sides round-trip, and a CI job that fails when either output is stale (#85).

**Architecture:** `scripts/gen-protocol.ts` runs `ts-json-schema-generator` over `shared/src/protocol.ts` for three roots and writes `shared/schema/protocol.schema.json`; a small generator of our own (`scripts/protocol/dart.ts`) turns that schema into Dart 3 sealed classes in `mobile/protocol/lib/src/protocol.g.dart`. `shared/fixtures/protocol.json` holds one or more samples of every variant: Vitest validates them against the schema and the TypeScript parser, `dart test` round-trips them through the Dart types. `--check` regenerates in memory and fails on any difference.

**Tech Stack:** Node ≥23.6 running TypeScript directly, `ts-json-schema-generator` 2.9.0 (brings its own TypeScript 5), `ajv` 8 for validation in tests, Vitest, Dart SDK ≥3.5 with `package:test`, GitHub Actions `dart-lang/setup-dart@v1`.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` (section "What goes through the channel", and "Schema source" under it).

## Global Constraints

- `shared/src/protocol.ts` is not restructured; this work only reads it. (Spec: "`protocol.ts` is not restructured.")
- The schema covers the messages the app uses; where a type does not convert cleanly, that part is written by hand and a test checks it against the TypeScript parser's fixtures. (Spec, verbatim.)
- "generation runs in CI and fails on a stale output." (Spec, verbatim.)
- New dev dependencies are pinned to exact versions, like the existing ones in the root `package.json`.
- Public repository: neutral fixtures (`/proj`, `src/a.ts`, made-up ids), no personal paths.
- Tests use no network and no ports; nothing here starts a server.
- Work in a worktree on branch `gh-85-protocol-schema`; the PR closes #85, squash only.

## Prerequisite (the author's go-ahead)

The Dart SDK is not installed on the development machine. Before Task 3, install it with the author's consent: `brew install dart-sdk` (or Flutter, which bundles Dart and is needed for #88 anyway: `brew install --cask flutter`). Tasks 1 and 2 need only Node.

## Review Focus

1. A newer server sends an event `kind`, an agent event `t` or an enum value this app does not know: parsing yields an unknown variant or the enum's `$unknown`, never an exception (Task 2 unit tests, Task 3 Dart test).
2. An optional field that is absent (`force?`) and a required field that is `null` (`session.title: string | null`) both survive a round trip exactly: the first stays absent, the second stays `null` (Task 3 fixtures include both).
3. `replay.events` nests whole `ServerEvent`s, `agent` events among them: nested items parse to their own variants (Task 3 fixture).
4. Someone changes `protocol.ts` and forgets to regenerate: `--check` exits 1 and names the stale file and the command that fixes it (Task 1 test, Task 2 extends it).
5. Someone adds a variant without a fixture: the coverage test fails and names the missing discriminator value (Task 1).

## File Structure

- `scripts/protocol/schema.ts` — builds the schema object from `protocol.ts` (`buildSchema`).
- `scripts/protocol/dart.ts` — turns a schema into Dart source (`schemaToDart`).
- `scripts/protocol/gen.ts` — what the outputs are (`generate`), how they are compared (`check`), and `serialize`.
- `scripts/gen-protocol.ts` — the CLI: writes the outputs, or `--check` compares them.
- `scripts/protocol/*.test.ts` — Vitest tests of the three above and of the fixtures.
- `shared/schema/protocol.schema.json` — generated, committed.
- `shared/fixtures/protocol.json` — hand-written samples, committed.
- `mobile/protocol/` — the Dart package `nb_protocol`: `pubspec.yaml`, `lib/nb_protocol.dart`, `lib/src/protocol.g.dart` (generated, committed), `test/protocol_test.dart`, `analysis_options.yaml`.

---

### Task 1: The JSON Schema, the fixtures and the stale check

**Files:**
- Create: `scripts/protocol/schema.ts`, `scripts/protocol/gen.ts`, `scripts/gen-protocol.ts`, `shared/schema/protocol.schema.json`, `shared/fixtures/protocol.json`
- Test: `scripts/protocol/schema.test.ts`, `scripts/protocol/fixtures.test.ts`, `scripts/protocol/gen.test.ts`
- Modify: `package.json` (devDependencies `ts-json-schema-generator: "2.9.0"` and `ajv` at the version already in the lockfile, exact; script `"gen:protocol": "node scripts/gen-protocol.ts"`)

**Interfaces:**
- Produces: `ROOTS = ['ClientMessage', 'ServerEvent', 'UsageReport'] as const`; `buildSchema(): ProtocolSchema` where `ProtocolSchema = { $schema: 'http://json-schema.org/draft-07/schema#'; 'x-protocol': number; definitions: Record<string, JSONSchema7Definition> }` and every root plus everything it reaches is a key of `definitions`; `SCHEMA_PATH = 'shared/schema/protocol.schema.json'`; `serialize(value: unknown): string` (stable key order, two-space indent, trailing newline); `generate(): Map<string, string>` (repo-relative path → file text; Task 2 adds the Dart file to it); `check(files: Map<string, string>, root: string): string[]` (the stale or missing paths).
- The fixtures file shape: `{ "client": ClientMessage[], "server": ServerEvent[], "usage": UsageReport[] }`.

- [ ] **Step 1: Write the failing tests**

`schema.test.ts`:
- `it('holds every root and what it reaches')`: `buildSchema().definitions` has keys `ClientMessage`, `ServerEvent`, `UsageReport`, `Comment`, `Anchor`, `WireAgentEvent`; no `$ref` anywhere in the schema points to a missing definition (walk it).
- `it('carries the protocol version')`: `buildSchema()['x-protocol']` equals `PROTOCOL` from `@nota-bene/shared` (13 today).
- `it('is deterministic')`: `serialize(buildSchema())` twice gives identical strings.

`fixtures.test.ts` (ajv over the generated schema file):
- `it('every fixture is valid')`: each `client` item validates against `ClientMessage`, each `server` item against `ServerEvent`, each `usage` item against `UsageReport`; a failure names the index and ajv's errors.
- `it('the parser takes every client fixture as it is')`: for each `client` item, `parseClientMessage(JSON.stringify(item))` deep-equals the item.
- `it('every variant has a fixture')`: the `type` values of `ClientMessage`, the `kind` values of `ServerEvent` and the `t` values of `WireAgentEvent`, read from the schema's `const`/`enum` of each variant, are all present in the fixtures (agent events inside `{kind: 'agent', e}` and inside `replay.events`); the message lists the missing values.
- Fixtures must include: a `send` without `force` (absent), a `session` event with `title: null`, a `replay` whose `events` hold a `user` and an `agent` `message` event, a `comments` event with one text, one media (with `time` and a `pen` shape) and one page anchor, a `MediaShape` of `kind: 'ellipse'`.

`gen.test.ts`:
- `it('check passes on fresh output')`: write `generate()` into a temp dir, `check(generate(), tmp)` is `[]`.
- `it('check names a stale file')`: change one byte of the schema file in the temp dir, `check` returns `['shared/schema/protocol.schema.json']`; a deleted file is reported the same way.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run scripts/protocol`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement `buildSchema`, `serialize`, `generate`, `check` and the CLI**

`buildSchema` calls `createGenerator({ path: 'shared/src/protocol.ts', tsconfig: <a minimal tsconfig object or file for TS 5 with `allowImportingTsExtensions`>, type: <each root>, expose: 'export', topRef: false, jsDoc: 'extended', additionalProperties: true })` and merges the definitions of the three roots (`additionalProperties: true` because the reverse skew must not fail: a newer peer may add fields). Keep JSDoc descriptions: they document the schema for the Dart side. If a type the roots reach does not convert, write its definition by hand in `scripts/protocol/schema.ts` (a named constant per definition, with a comment saying why) and let the fixture tests prove it. `gen-protocol.ts`: no argument writes every file of `generate()`; `--check` prints each stale path and `run: npm run gen:protocol`, then exits 1; exits 0 when clean.

- [ ] **Step 4: Write the fixtures and generate**

Run: `npm run gen:protocol && npx vitest run scripts/protocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/protocol scripts/gen-protocol.ts shared/schema shared/fixtures
git commit -m "gh-85: a JSON Schema of the protocol, its fixtures and a stale check"
```

### Task 2: The Dart generator

**Files:**
- Create: `scripts/protocol/dart.ts`
- Test: `scripts/protocol/dart.test.ts`
- Modify: `scripts/protocol/gen.ts`: `generate()` adds `DART_PATH = 'mobile/protocol/lib/src/protocol.g.dart'`

**Interfaces:**
- Consumes: `ProtocolSchema`, `buildSchema`, `generate`, `check` (Task 1).
- Produces: `schemaToDart(schema: ProtocolSchema): string`. The Dart it emits, which Task 3 relies on:
  - a header `// GENERATED by scripts/gen-protocol.ts from shared/src/protocol.ts. Do not edit.` and `const int protocolVersion = <x-protocol>;`
  - every class has `factory X.fromJson(Map<String, Object?> json)` and `Map<String, Object?> toJson()`; enums have `static E fromJson(Object? v)` and `String toJson()`.
  - named definitions keep their TypeScript names (`ClientMessage`, `ServerEvent`, `Comment`, `UsageReport`, …).

Mapping rules (the decisions; the implementer writes the code):
- **Object** → `final class` with `final` fields in camelCase of the JSON name (`resets_at` → `resetsAt`, the JSON key kept in `fromJson`/`toJson`). A property in `required` → non-nullable unless its schema allows `null`; a property not in `required` → nullable, and `toJson` omits it when `null`. A required nullable property is always written, `null` included.
- **Union of objects with a common discriminator** (a property that is `const` or a string `enum` in every variant, e.g. `type`, `kind`, `t`) → `sealed class` with one `final class` per variant named `<Union><Value in PascalCase>` (`ServerEventHello`, `ClientMessageShellRun`, `WireAgentEventMessageChunk`); a variant whose discriminator allows several values is named by joining them with `Or` (`MediaShapeRectOrEllipse`) and keeps the discriminator as a field. `fromJson` switches on the discriminator; an unknown or missing value yields `<Union>Unknown`, which keeps the raw map and returns it from `toJson`.
- **A union where exactly one object variant lacks the discriminator** (`Anchor`: `TextAnchor` has no `kind`) → the same sealed class; a map without the discriminator parses as that variant. Named definitions used as variants keep their names (`TextAnchor`, `MediaAnchor`, `PageAnchor` implement `Anchor`).
- **String enum** (a union of string literals, or `enum`) → Dart `enum` with members in lowerCamelCase of the wire value (`codex-read-only` → `codexReadOnly`; a value that is not an identifier, such as `#ff3b30` or `image/png`, has its other characters turned into `_` and gets the prefix `v` when it does not start with a letter: `v_ff3b30`, `image_png`; two values that land on one name make the generator throw) plus a last member `$unknown`; `fromJson` maps an unknown string to `$unknown`; `toJson` of `$unknown` throws `StateError` (a client must not send it).
- **`T | null`** → `T?`. **`number`** → `num`, **`integer`** → `int`, `boolean` → `bool`, `string` → `String`. **Array** → `List<T>`; a tuple (`items` as a list, as `ModelCamera.position`) → `List<num>`. **`additionalProperties` only** (`Record<string, V>`) → `Map<String, V>`. **Empty schema / unknown** → `Object?`.
- **Anonymous nested objects and enums** are named `<Parent><Property in PascalCase>` (`StatsContext`, `CommentStatus`), with `Item` appended for array items (`StatsWindowsItem`); intersections arrive merged by the schema generator and need no rule.
- **Anything else** → `schemaToDart` throws an `Error` naming the definition and the JSON pointer of the shape. No silent `Object?` for a shape it does not understand.
- Output is deterministic (definitions sorted by name). Task 3's CI runs `dart format --set-exit-if-changed` on it, so the generator emits formatter-clean code.

- [ ] **Step 1: Write the failing tests** (`dart.test.ts`, on small hand-made schemas, asserting on substrings of the output)

- `it('an object with optional and required-nullable fields')`: `{ a: string (required), b?: number, c: string | null (required) }` → contains `final String a;`, `final num? b;`, `final String? c;`, and the `toJson` writes `'c': c` unconditionally and `b` only `if (b != null)`.
- `it('a discriminated union with an unknown variant')`: a union of `{kind:'x', n:number}` and `{kind:'y'}` named `E` → contains `sealed class E`, `final class EX extends E`, `final class EY extends E`, `final class EUnknown extends E`, and the switch has a default branch to `EUnknown`.
- `it('a union with one variant lacking the discriminator')`: `Anchor`-shaped input → a map without `kind` goes to the text variant (assert the `fromJson` code path: `if (!json.containsKey('kind')) return TextAnchor.fromJson(json);` or an equivalent the test can find).
- `it('an enum with $unknown')`: `'a-b' | 'c'` → `enum ... { aB, c, $unknown }`.
- `it('a variant with several discriminator values')`: `{kind:'rect'|'ellipse'}` → class `MediaShapeRectOrEllipse`.
- `it('throws on an unsupported shape')`: a `oneOf` of `string` and `number` → throws, message contains the definition name.
- `it('the real schema converts')`: `schemaToDart(buildSchema())` does not throw and contains `const int protocolVersion = 13;`, `sealed class ServerEvent`, `final class ServerEventReplay`, `List<ServerEvent> events`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run scripts/protocol/dart.test.ts`
Expected: FAIL, `schemaToDart` does not exist.

- [ ] **Step 3: Implement `schemaToDart` and add the Dart file to `generate()`**

- [ ] **Step 4: Generate and run**

Run: `npm run gen:protocol && npx vitest run scripts/protocol`
Expected: PASS; `gen.test.ts` now also covers the Dart file (extend `it('check names a stale file')` to a changed Dart file).

- [ ] **Step 5: Commit**

```bash
git add scripts/protocol mobile/protocol/lib/src/protocol.g.dart
git commit -m "gh-85: Dart types generated from the protocol schema"
```

### Task 3: The Dart package, its tests, CI and docs

**Files:**
- Create: `mobile/protocol/pubspec.yaml` (`name: nb_protocol`, `publish_to: none`, `environment: sdk: ^3.5.0`, dev dependency `test`), `mobile/protocol/analysis_options.yaml` (the `lints` recommended set), `mobile/protocol/lib/nb_protocol.dart` (exports `src/protocol.g.dart`), `mobile/protocol/test/protocol_test.dart`, `mobile/protocol/.gitignore` (`.dart_tool/` and `pubspec.lock`: a library package does not commit its lock file)
- Modify: `.github/workflows/ci.yml` (a new job), `AGENTS.md` (project map), `docs/architecture.md` (section 3.3, the versioning bullet), `CHANGELOG.md` is not touched (nothing user-visible)

**Interfaces:**
- Consumes: the generated Dart API (Task 2) and `shared/fixtures/protocol.json` (Task 1), read from the test as `File('../../shared/fixtures/protocol.json')`.

- [ ] **Step 1: Write the Dart tests**

```dart
test('every fixture round-trips', () { /* for each client, server and usage item: expect(X.fromJson(item).toJson(), equals(item)) */ });
test('a nested replay parses to its own variants', () { /* the replay fixture: events[0] is ServerEventUser, events[1] is ServerEventAgent whose e is WireAgentEventMessage */ });
test('an unknown event kind is kept, not thrown', () {
  final e = ServerEvent.fromJson({'kind': 'from-the-future', 'x': 1});
  expect(e, isA<ServerEventUnknown>());
  expect(e.toJson(), {'kind': 'from-the-future', 'x': 1});
});
test('an unknown enum value is \$unknown', () { /* a mode event with mode 'not-a-mode' parses; its mode is AgentMode.$unknown */ });
test('absent stays absent, null stays null', () { /* the send fixture's toJson has no 'force' key; the session fixture's toJson has 'title': null */ });
```

- [ ] **Step 2: Run them**

Run: `cd mobile/protocol && dart pub get && dart analyze --fatal-infos && dart format --output=none --set-exit-if-changed lib test && dart test`
Expected: PASS. A formatter difference in the generated file is fixed in `schemaToDart`, then regenerate; never by hand-editing `protocol.g.dart`.

- [ ] **Step 3: Add the CI job**

In `.github/workflows/ci.yml`, a job `protocol` on `ubuntu-latest`: checkout, `actions/setup-node@v4` (node 24, npm cache), `npm ci`, `npm run gen:protocol -- --check`, `dart-lang/setup-dart@v1` (`sdk: stable`), then in `mobile/protocol`: `dart pub get`, `dart analyze --fatal-infos`, `dart format --output=none --set-exit-if-changed lib test`, `dart test`. The existing `test` job is unchanged.

- [ ] **Step 4: Docs**

- `AGENTS.md`, project map: `- \`mobile/protocol/\`: Dart types generated from \`shared/\`; after a protocol change run \`npm run gen:protocol\` (CI fails on stale output).`
- `docs/architecture.md`, 3.3 Protocol, Versioning bullet: one sentence that `shared/schema/protocol.schema.json` and the Dart types are generated from these types, and a protocol change adds a fixture for each new variant to `shared/fixtures/protocol.json`.

- [ ] **Step 5: Full local checks**

Run, one after another: `npx tsc -b`, `npm test`, `npm run gen:protocol -- --check`, the Dart commands of Step 2.
Expected: every exit code 0.

- [ ] **Step 6: Commit and open the PR**

```bash
git add mobile/protocol .github/workflows/ci.yml AGENTS.md docs/architecture.md docs/superpowers/plans/2026-11-07-protocol-schema.md
git commit -m "gh-85: the nb_protocol Dart package, its tests and a CI job"
```

PR title `gh-85: protocol JSON Schema and generated Dart types`, body `Closes #85. Part of #63.`, ending with the attribution line.
