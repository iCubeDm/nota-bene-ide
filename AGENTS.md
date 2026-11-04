# Nota Bene — agent instructions

Shared project instructions for Claude Code, Codex and other coding agents.
Load the reference relevant to the task; do not read every document at startup.

## Project map

- `shared/`: browser/server protocol and normalized agent events.
- `server/`: Node server, SessionManager, agent backends, files/auth/persistence.
- `web/`: React/Redux UI. `bin/`: launcher. `plugin/`: Claude Code `/nb` plugin.
- Architecture: [docs/architecture.md](docs/architecture.md).
- Development, launcher and packaging: [agent reference](docs/agent-reference.md#rebuild-root).
- Auth, state, socket and protocol invariants: [agent reference](docs/agent-reference.md#access-token).
- Running inside a Nota Bene window: [runtime precautions](docs/agent-reference.md#you-may-be-running-inside-this-tool).
- Why a window did something (a stopped turn, a dropped socket): its [audit log](docs/agent-reference.md#audit-log).
- User-facing behavior: [docs/guide.md](docs/guide.md).
- Release checks and packaging: [agent reference](docs/agent-reference.md#releasing).

## Development constraints

- Checkout requires Node >=23.6; it runs server TypeScript directly. Published package supports Node >=22.
- Preserve existing Claude, Codex and omp features and behavior. All three backends are shipped;
  omp runs on the generic ACP adapter (`server/src/agent/acp/`), so another ACP agent is a profile there.
- Keep provider SDK shapes inside their adapters. Use the shared event contract and explicit capabilities.
- Prefer focused changes and composition; preserve persistence and session-generation invariants.
- Every feature merged into `main` supports every UI language: user-visible text goes through `web/src/i18n`, and each
  new or changed string gets a real translation in all of `LANGS` in the same change. `i18n.test.ts` catches a missing key,
  not a string hard-coded in a component, so check that by hand.
- `main` takes only squash-merged pull requests tied to an issue: [workflow](docs/agent-reference.md#workflow).
- This repository is public: use neutral fixtures/examples. Keep personal paths, real session ids,
  private project details and review artifacts out of tracked files and commit messages.

## Validation and live processes

- Unit tests: `npm test` (Vitest isolates the invoking NB provider and launcher flags;
  provider-specific tests choose their provider explicitly). Types: `npx tsc -b`. UI build: `npm run build -w web`.
- E2E: `npm run e2e`; media fixtures need ffmpeg. Use checks appropriate to the actual change.
- Full suites across checkouts share ports: serialize them. Trust the test process exit code;
  a successful log filter is not evidence that the tests passed.
- Tests/manual smoke use only 4790–4795; 4790 is for manual smoke. Dev uses 4780/5173.
  Use a temporary project, `NOTA_BENE_HOME` and `CLAUDE_JOURNAL_VAULT` for real-agent smoke tests.
- If working through a live Nota Bene window, never kill, restart or probe its own server.
  Validate on a separate test instance before requesting a restart; verify the restart read-only.
- Web edits need a build and page reload; server/shared edits need a server restart.
  The ↻ Agent button restarts the agent; the server restart is in its adjacent menu.
- Parse-check Mermaid before showing or committing diagrams; inspect visual output from current code.

Keep personal workflow preferences and session memory outside this public repository.
