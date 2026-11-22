# One server, step 2a: explicit agent context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every per-agent object of a window gets its state folder from an explicit `AgentContext` instead of
`process.env.NOTA_BENE_AGENT`, with no change a user can see.

**Architecture:** `state.ts` gains `AgentContext` and `agentContext()`; `startServer`, the session manager, the
system routes and the Codex backend take the agent's `stateDir` from it. What stays process-wide (token, control
token, prefs, window registry, state guard) keeps today's env-derived folder under a new name, `serverStateDir()`, so
step 2b decides each of those openly. Paths on disk do not change.

The rest of the window's behaviour that later steps must keep is already pinned: route auth tiers
(`auth.test.ts` MATRIX), the one-tab rule (`onetab.test.ts`), restart and update rules (`restartGate.test.ts`,
`server.test.ts` gh-422 cases, updater tests). 2a adds only what M1 touches: where each provider's data lives.

**Tech Stack:** Node ≥23.6 running server TypeScript directly, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-one-server-and-agent-bus-design.md`, section M1 and "Phase 2 as pull
requests" (2a).

## Global Constraints

- No behaviour change: every file a window writes today lands at the same path (`~/.nota-bene` for Claude,
  `~/.nota-bene/providers/<p>` for Codex and omp).
- One PR into `main`, branch `gh-383-agent-context`, commits and title `gh-383: <what>`, body `Part of #383`.
- Tests use a temp `NOTA_BENE_HOME`; ports only 0 or 4790–4795. Full `npm test` only under the shared lock:
  `until mkdir /tmp/nb-fullsuite.lock 2>/dev/null; do sleep 15; done; rtk test npm test; rc=$?; rmdir /tmp/nb-fullsuite.lock; echo exit=$rc`.
- Green before review: `npx tsc -b`, the full `npm test` once. No `web/`, `shared/` or `mobile/` change.
- Public repo: neutral fixtures. Match the surrounding code's comment density and naming.

## Review Focus

- A Codex or omp window started by the launcher (env `NOTA_BENE_AGENT=codex`, no explicit context) must still write
  under `providers/codex`: main.ts must build the context from `args.agent`, not default to Claude.
- `lastSession` is read in main.ts before `startServer` (to pick the session to resume): it must read the same
  provider's `sessions.json` as the server writes.
- System storage clean (`POST /system/storage/clean`) and Settings → About's state folder must name the agent's folder,
  not the base one, for a Codex window.
- `MarkFiles`' refusal of a project whose `.nota-bene` is the state folder (root = `$HOME`) must still refuse.
- The Codex backend's replay history must read the folder the server's `HistoryArchive` writes.

---

### Task 1: Pin today's state layout per provider

**Files:**
- Create: `server/src/stateLayout.test.ts`

**Interfaces:**
- Consumes: `startServer` (server/src/server.ts), `fakeBackend` (server/src/agent/fake.ts).
- Produces: the helper `run(o)` in this file, which starts a server with `insecureNoAuth`, `resume: SESSION`,
  `oneTab: false`, `ffmpeg: () => null`, a temp `webDist`, posts `/seen {session: SESSION}` and
  `/sessions/archive {id: OTHER, archived: true}` with the server's own origin, and closes it. Task 2 adds a case.

- [ ] **Step 1: Write the characterization test**

```ts
const SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

it.each(['codex', 'omp'] as const)('a %s window keeps its data under providers/<p> (env-chosen, today)', async (p) => {
  process.env.NOTA_BENE_AGENT = p;
  await run({});
  const own = path.join(home, 'providers', p);
  expect(fs.existsSync(path.join(own, 'seen-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(own, 'archived-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(home, 'seen-sessions.json'))).toBe(false);
  expect(fs.existsSync(path.join(home, 'archived-sessions.json'))).toBe(false);
});

it('a claude window keeps its data in the base folder', async () => {
  process.env.NOTA_BENE_AGENT = 'claude';
  await run({});
  expect(fs.existsSync(path.join(home, 'seen-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(home, 'providers'))).toBe(false);
});
```

`beforeEach` makes `home` with `fs.mkdtempSync` and sets `NOTA_BENE_HOME`; `afterEach` restores `NOTA_BENE_HOME` and
`NOTA_BENE_AGENT` (vitest.config.ts sets it to `claude`) and moves nothing outside `home`.

- [ ] **Step 2: Run it**

Run: `rtk test npx vitest run server/src/stateLayout.test.ts`
Expected: PASS (3 tests). It pins behaviour that exists; if it fails, the test is wrong, not the code.

- [ ] **Step 3: Commit**

```bash
git add server/src/stateLayout.test.ts
git commit -m "gh-383: pin where a window of each provider keeps its data"
```

### Task 2: An explicit agent context for the per-agent objects

**Files:**
- Modify: `server/src/state.ts` (context, session memory), `server/src/seen.ts`, `server/src/archivedSessions.ts`,
  `server/src/server.ts`, `server/src/session.ts`, `server/src/system.ts`, `server/src/agent/codex/backend.ts`,
  `server/src/main.ts`; their tests where a signature changed.
- Test: `server/src/stateLayout.test.ts`

**Interfaces:**
- Consumes: Task 1's `run(o)`.
- Produces (state.ts):
  - `export type AgentContext = { provider: AgentProvider; stateDir: string }`
  - `export function agentContext(provider: AgentProvider, base: string = stateBaseDir()): AgentContext`: the folder
    is `providerStateDir(base, provider)`, created and checked exactly as `stateDir()` does today (mode 700, owner,
    Windows profile ACL). Move that check into `function ensureStateDir(dir: string): string` and use it from both.
  - `export function envAgentContext(): AgentContext`: `agentContext(parseProvider(process.env.NOTA_BENE_AGENT))`.
    The only reader of that env var besides main.ts.
  - `lastSession(dir, projectDir)`, `saveSession(dir, projectDir, id)`, `forgetSession(dir, id)`: `dir` first, required.
- Produces elsewhere: `readSeen(dir)`, `markSeen(id, at, dir)`, `readArchived(dir)`, `setArchived(id, on, dir)` with
  `dir` required; `startServer({ agent?: AgentContext })`, default `envAgentContext()`;
  `createSessionManager({ stateDir: string })` required, used for its attachment, voice and history defaults;
  `systemRoutes({ stateDir: string })` for storage clean, history, trash and `/system/about`'s `stateDir`;
  `codexBackend({ stateDir?: string })`, default `envAgentContext().stateDir`.

- [ ] **Step 1: Write the failing test**

```ts
it('an explicit agent context wins over the env', async () => {
  process.env.NOTA_BENE_AGENT = 'claude';
  await run({ agent: agentContext('codex', home) });
  const own = path.join(home, 'providers', 'codex');
  expect(fs.existsSync(path.join(own, 'seen-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(own, 'archived-sessions.json'))).toBe(true);
  expect(fs.existsSync(path.join(home, 'seen-sessions.json'))).toBe(false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `rtk test npx vitest run server/src/stateLayout.test.ts`
Expected: FAIL, `agentContext` is not exported (or, once it is, `seen-sessions.json` lands in `home`).

- [ ] **Step 3: Implement**

In `startServer`, `const agent = o.agent ?? envAgentContext()` once, then use `agent.stateDir` for every store that
reads `stateDir()` today: attachments, history, turns-open, comments, prompts, compact-pending, `MarkFiles`'
`stateDir: () => agent.stateDir`, seen and archived reads and writes, `forgetSession`; `agent.provider` for
`projectRoutes({ provider })` and the `server-start` audit record. Pass `stateDir: agent.stateDir` to
`createSessionManager` and `systemRoutes`. In main.ts build `const agent = agentContext(parseProvider(args.agent))`
before the first `lastSession`, use it for `lastSession(agent.stateDir, …)`, pass it to `startServer` and its
`stateDir` to `codexBackend`. Keep `process.env.NOTA_BENE_AGENT = …` in main.ts: child launches still read it.
`npx tsc -b` lists every remaining caller of a changed signature; fix each, tests included.

- [ ] **Step 4: Run the tests**

Run: `npx tsc -b && rtk test npx vitest run server/src/stateLayout.test.ts server/src/state.test.ts server/src/server.test.ts server/src/system.test.ts`
Expected: tsc exit 0; all PASS (4 in stateLayout).

- [ ] **Step 5: Commit**

```bash
git add -A server/src
git commit -m "gh-383: a window's per-agent stores take their folder from an explicit agent context"
```

### Task 3: Name what stays process-wide, and guard it

**Files:**
- Modify: `server/src/state.ts`, `server/src/prefs.ts`, `server/src/auth.ts`, `server/src/stateGuard.ts`,
  `server/src/windows.ts`, `server/src/main.ts`; tests that call `stateDir()`.
- Test: `server/src/state.test.ts`

**Interfaces:**
- Consumes: Task 2's `envAgentContext()`.
- Produces: `export function serverStateDir(): string` (= `envAgentContext().stateDir`), doc comment: the window
  process's own folder for the token, control token, prefs and window registry; step 2b moves each to the server.
  `stateDir()` is removed.

- [ ] **Step 1: Write the failing test**

```ts
it('only process-wide modules use the env-chosen folder', () => {
  const src = path.resolve(import.meta.dirname);
  const files = fs.readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const using = (re: RegExp) => files.filter((f) => re.test(fs.readFileSync(path.join(src, f), 'utf8'))).sort();
  expect(using(/\bstateDir\(\)/)).toEqual([]);
  expect(using(/\bserverStateDir\(/)).toEqual(['auth.ts', 'main.ts', 'prefs.ts', 'state.ts', 'stateGuard.ts', 'windows.ts']);
  expect(using(/process\.env\.NOTA_BENE_AGENT\b/)).toEqual(['main.ts', 'state.ts']);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `rtk test npx vitest run server/src/state.test.ts`
Expected: FAIL, the first expectation lists the files still calling `stateDir()`.

- [ ] **Step 3: Rename `stateDir()` to `serverStateDir()`** in state.ts and its remaining callers (prefs, auth,
  stateGuard, windows, main), tests included. Adjust the second list only if a file there turns out to be per-agent,
  and then move it to the agent context instead.

- [ ] **Step 4: Run everything**

Run: `npx tsc -b`, then the full `npm test` under the shared lock (Global Constraints).
Expected: tsc exit 0; `exit=0`.

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add -A server/src
git commit -m "gh-383: name the window's process-wide state folder and guard its users"
git push -u origin gh-383-agent-context
gh pr create --title "gh-383: explicit agent context (phase 2a)" --body "Part of #383

Per-agent stores take their folder from an explicit AgentContext; process-wide ones use serverStateDir(). No path on disk changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
