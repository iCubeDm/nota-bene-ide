# Codex / ChatGPT Implementation Plan

**Goal:** Run Nota Bene from Codex CLI and local Desktop using a provider-bound browser window, preserving all existing Claude behavior.

**Approach:** Keep the AgentBackend/AgentSession boundary. Add a native Codex App Server adapter (JSONL stdio JSON-RPC, installed Codex CLI, no separate model API client) and provider-scoped launch/state. Claude's adapter and skill stay unchanged; ACP is a later backend behind the same boundary.

**Spec:** `docs/superpowers/specs/2026-10-31-codex-chatgpt-design.md`

## Constraints

- No edits to `server/src/agent/claude/**` or `plugin/skills/nb/**`.
- Default/legacy provider is Claude. Each browser window is fixed to its invoking provider.
- Node >=23.6 for checkout, >=22 for the published package.
- No provider dropdown, no implicit cross-provider transcript conversion.
- Capabilities describe verified behavior; unknown cost/token/task facts stay unknown. No claim of full Codex parity before the gates are verified.
- Public artifacts contain no private paths, real session ids or personal project data.

## Review focus

- Claude and Codex launched in the same folder never share a window, settings or transcripts.
- A completion during steering/interrupt must not duplicate, lose or prematurely settle a send.
- Disconnect/switch/cancel retires permission and question requests; late answers cannot approve the next generation.
- Comment anchors stay on the same text/tools after paginated history replay and compaction.
- A Desktop launch survives tool-shell/turn completion without orphans; explicit shutdown ends its owned child.

## Tasks and decisions

1. **Provider-scoped launcher and state.** `server/src/agent/provider.ts`: `AgentProvider = 'claude' | 'codex'`, `parseProvider`, `providerStateDir(base, provider)`. `--agent claude|codex` defaults to Claude and survives detached launch and supervision. Provider scopes state and window discovery; Claude's base directory stays exact. Executable override `NOTA_BENE_CODEX`, else `codex` on PATH. Touches `state.ts`, `main.ts`, `bin/nota-bene.mjs`.
2. **Owned JSON-RPC process.** `server/src/agent/codex/rpc.ts`: `CodexRpc` with `request(method, params?, {signal, timeoutMs}?)`, `notify`, notification/request subscriptions, `close()`, `closed`. Initializes once with client metadata then `initialized`; server requests use a separate response path; bounded framing; no shell interpolation. Generated installed-runtime schemas used as research only.
3. **Event/input/history normalization.** `codex/map.ts`, `history.ts`: Codex item/turn mapper to existing AgentEvent plus optional neutral metadata; `codexInput(text, images)`; paginated history to ServerEvent[]. Message/tool ids derive from native item ids, identical live and replay. Tool categories and child/task identities are explicit, not inferred from Claude names. No fabricated timings/cost/usage, bounded output, no duplicate final text. Shared changes (`shared/src/agent.ts`, `tasks.ts`) are additive only.
4. **Backend lifecycle and controls.** `codex/backend.ts`, `session.ts`, `controls.ts`: `codexBackend(options?): AgentBackend`. Keeps the `startServer({backend})` / fake backend contract; adds optional session-validation/discovery hooks so Codex never falls back to Claude transcripts. Supports native thread new/resume/fork/list/read, pagination, turn start/steer/interrupt, compact/reset, model/effort discovery, skills/commands, context/limit reads, task control. Message ownership captured at actual acceptance; clear starts a new native conversation without losing comments or replay state. Safe provider-specific permission profiles; no credential file parsing.
5. **Provider-neutral controls, interactions, statistics.** Versioned optional provider identity, capability descriptors and variable-duration limit windows; legacy clients/state get exact Claude defaults. Explicit answer paths for native approval options and structured questions (never a fake acknowledgement). Server validates every operation against the fixed backend's capabilities and generation; the browser never sends arbitrary sandbox configuration. Web: ModePill, ModelPill, SessionPicker, ToolLine, subagent slice, i18n en/ru. Unavailable Codex facts are explained accurately.
6. **Codex nb skill, Desktop lifetime, distribution.** `codex/skills/nb/SKILL.md`, `open.mjs`, `scripts/codex-nb.test.ts`; packaging via `scripts/build-package.mjs`. Separately installable skill invokes the provider-aware launcher with `--agent codex`. Default/new/fork use the actual source thread id, never transcript mtime; a missing id makes fork fail clearly. Desktop uses supervised detached launch with bounded authenticated readiness; CLI uses owned background execution. Output is a plain URL only.
7. **Acceptance and parity audit.** Scripted Codex E2E under `e2e/`; docs carry the verified feature matrix. Real Codex run against a local scripted Responses endpoint (no paid calls); ChatGPT sign-in plumbing verified without touching the controlling thread. Foreground-to-background and prompt-suggestion gates resolved technically or reported for a user decision, never silently substituted. One fresh whole-branch review.

## Result

Completed on the feature branch (unmerged, unpublished). The review's six Important findings were reproduced and fixed: pending-start cancellation, compaction/archive reconciliation, late child metadata, process-local child liveness, sticky effort defaults, resumed child tasks. Decline semantics and Russian labels were also corrected.

Checks: TypeScript and web build passed; 2289 tests passed (the native contract is opt-in and passed separately); 86 existing browser scenarios plus one Codex scenario passed. The native contract uses a local Responses fixture covering a real command and shutdown of its running terminal.

Accepted Codex API gaps: force-background, terminal output tail, prompt suggestions. ACP remains future work. The Claude adapter and skill have no diff from the branch base. Global skill installation is documented, not performed.
