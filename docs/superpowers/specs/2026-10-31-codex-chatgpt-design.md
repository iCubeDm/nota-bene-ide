# Codex / ChatGPT support alongside Claude

Status: proposed design for review. Branch: `feat/codex-chatgpt`.

## Intent

Use Codex with a ChatGPT account in Nota Bene's review workflow (chat, comment batches, files, media, sessions, agent controls, work inspection) while keeping Claude and every Claude feature working. The user prefers a common interface, possibly ACP, without reducing functionality. The transport recommendation is an engineering proposal; launch ownership and provider-bound browser behavior were clarified by the user.

## Architecture

- Keep `AgentBackend` / `AgentSession` and normalized `AgentEvent` as the common interface. Add a Codex backend speaking to `codex app-server` over stdio. The Claude SDK backend stays default and is not rewritten or moved to ACP; do not modify `server/src/agent/claude/**`.
- Why native Codex first: App Server exposes session lifecycle, streaming, steering, approvals, model discovery and account rate-limit APIs. The codex-acp bridge wraps App Server, but rich features depend on experimental extensions or the JetBrains AIR client profile; baseline ACP does not prove full parity. No separate OpenAI model API loop.
- ACP is a future separate transport backend behind the same interface; the app must not depend on one vendor's wire protocol.
- Alternative if ACP now: a generic ACP backend plus a version-pinned codex-acp profile with explicit extension negotiation. Account limits, background-task controls and other gaps still need proven implementations; do not advertise capabilities not implemented. Revisit if a released ACP profile covers the whole acceptance matrix without provider-specific side channels.

## Launch and session experience (confirmed by the user)

The invoking CLI determines the provider; invocation from Codex Desktop is also wanted. Nota Bene is a skill, not a provider picker: no Claude/Codex switch inside a running window.

- Claude `/nb`, `/nb new`, `/nb fork` and its background-task lifecycle stay unchanged; omitting a provider means Claude.
- A separate Codex-compatible `nb` skill for Codex CLI and local Codex Desktop invokes the launcher with an explicit Codex provider. Do not reuse Claude Skill-tool syntax or plugin variables; install in a Codex-specific discovery root so it does not shadow Claude's `nb`; ship with the checkout/package; document the host's real invocation syntax rather than promising literal `/nb`.
- Codex CLI: use its background process/task mechanism with bounded readiness checks; stopping the owning task stops the window.
- Codex Desktop: launcher's supervised detached mode; ending the response, switching chats or closing the panel does not kill the window; closing a browser tab does not terminate work; explicit stop/shutdown ends it. Repeated invocation focuses the same `(Codex, folder)` window; no resident duplicate per prompt; no dependency on a short-lived tool shell.
- Desktop needs local workspace execution; otherwise report clearly, never silently create a remote window or other provider session. Explicit `fork` uses the workspace folder and owning Codex thread id when the host provides it; never guess by taking the last transcript; if the source is unknown, fail clearly.
- `--agent codex` on the launcher/server is the explicit equivalent; default `--agent claude`. No provider UI.
- One fixed provider/backend per window lifetime; the session picker lists only that provider's sessions (grouping, titles, ordering kept). `/nb` resumes the provider's last session for the folder or starts fresh; `new` starts fresh; `fork` carries the calling conversation into a provider-native branch so terminal and browser never append to one transcript.
- Existing busy/pending-comment protections on switches; agent and supervised server restart keep provider/session identity.
- One window per `(provider, folder)` so Claude and Codex coexist; invoking Codex must not focus a Claude window. Legacy lock/registry entries without a provider field mean Claude.
- Controls expose only the provider's real models and permission profiles; provider shown as identity, not selector.
- Reuse the invoking Codex account/config. On missing/expired auth offer an explicit sign-in/retry via App Server; do not parse/copy auth files or require API keys for ChatGPT login; keep configured API-key accounts.
- Missing executable or init failure is clear and retryable; Claude windows stay usable.

## Shared integration boundary

- A small startup backend catalog/factory and provider-owned session identity; the launcher picks the provider once; HTTP/WebSocket routes keep single-backend composition. A Codex window never calls Claude history/session APIs. The single-backend server/test entry point stays as a compatibility path.
- Old client messages and persisted state without a provider mean Claude. New protocol fields are versioned; old clients must not operate a Codex session under Claude rules.
- Capabilities and controls describe the fixed provider and session; publish before enabling controls; refresh commands/models/stats on session switch. Permission profiles stay distinct: never map Claude `auto`/`acceptEdits` onto a Codex sandbox/approval combination because labels look alike.
- Provider-neutral metadata for tool categories, child conversations and task controls; keep legacy Claude rendering and tool names; do not infer Codex subagents from Claude's `Agent`/`Task` names.
- Codex wire types stay inside the adapter. A versioned JSON-RPC transport owns framing, request ids, handshake, cancellation, timeouts, server-initiated requests and bounded stderr. Subprocesses use argument arrays, no shell. Never expose credentials in messages, logs, URLs or exports.

## State and concurrency

- Provider-qualify new conversation identity, last-session selection, model/mode prefs, comment stores and compaction archives; existing Claude paths stay readable; never rewrite native Claude transcripts.
- Provider session ids are opaque; validate the public reference and map safely for storage; do not weaken path checks.
- Codex discovery/replay uses its APIs with pagination; never scan `~/.claude/projects` for Codex. Deterministic source-item-based message/tool ids so anchors survive replay.
- Keep generations, permission cancellation, send accounting and stale-event rejection on transitions; late events or approvals must not reach the new session; a failed target lookup leaves the current session intact.
- Match each sent message to real provider acceptance/completion; steering/completion races must not duplicate prompts, settle later sends or leave them pending.
- If another client holds a Codex thread, report it and keep the window usable; never silently take over.

## Feature preservation and Codex acceptance matrix

Claude rows stay unchanged. Codex implements the same workflow where supported.

| Feature | Codex requirement |
| --- | --- |
| Streamed chat, tools, errors, stop | Normalize App Server items; reconcile final content without duplicate text |
| Send while working; force-send | Native steering; interrupt then send for force; verify races |
| Comment batches (text/file/media) | Existing batch assembly and attachments; keep labels, quotes, image order |
| Tree, viewers, markup, branch/worktree views | Existing app services, independent of transport |
| `!` shell commands | Existing ShellRunner and safeguards; adapt delivery to Codex input without changing Claude formatting |
| File mentions | Codex search when supported; bounded local fallback |
| Commands and skills | Discover Codex commands/skills (incl. shared grill-me, Superpowers, lavish); do not advertise terminal-only actions |
| Launch/new/fork; resume/list/switch/title | Fixed-provider session APIs, stable replay ids, namespace-safe state, provider-scoped window discovery |
| Clear | New conversation with existing safeguards; never send `/clear` as a prompt |
| Compaction (manual/auto), history | Normalize real boundaries; keep archived segments and anchors; idle compaction uses provider-owned settings |
| Model, effort, permissions | Live discovery; per-provider confirmed settings; report refused changes accurately |
| Context and plan-limit meters | Token data and native account limits; show real limit-window durations, not Claude's 5h/7d |
| Subagent tabs incl. nested | Normalize child-thread associations; read history without a new model turn |
| Background tasks, output, stop | Track real task/process ids and output; targeted native controls only where available |
| Pending comments, reconnect, takeover, restart | Existing ownership/auth/replay; test switches, two-provider coexistence, failed opens |
| English/Russian UI | Provider-neutral text plus accurate agent-specific labels and capability explanations |

### Parity gates (verify, never hide)

- Forcing a foreground tool to background: native API has background-terminal list/terminate behind experimental support but no proven equivalent of Claude `backgroundTasks(toolUseId)`. Prove it or bring the gap to the user; do not relabel interrupt as background.
- Prompt prediction: no extra paid model call to imitate it; verify native support or agree the gap with the user.
- Session cost: a ChatGPT account has no meaningful per-session USD; show unavailable truthfully, keep context/limit meters.
- Compaction counts/duration and child-task observability may be absent: keep unknown values, never fabricate.
- Async questions/structured elicitation and rich permission choices need a real answer path; an unanswered request must not hang a turn.

No Claude control is removed because Codex lacks an operation. An unresolved gate blocks a "full parity" claim and is reported with the affected workflow.

## Verification and delivery

- Baseline unit suite before changes; serialize suites sharing ports; distinguish sandbox `listen EPERM` from product failures.
- Contract tests: caller-bound provider selection, same-folder coexistence, backward-compatible Claude lookup, state isolation; Codex CLI task ownership vs Desktop detached lifetime and repeated invocation.
- Codex transport against a scripted local JSON-RPC process: handshake, out-of-order responses, malformed data, disconnects, late events, pending approvals.
- Event/replay tests: deterministic ids, comments/images, steering/interrupt races, compaction, child histories, task lifecycle; no paid model in unit tests. UI/E2E with scripted providers; Claude suites unchanged.
- Real Codex process in a disposable project/vault/state dir with an isolated session, existing ChatGPT login and fresh login; never resume the conversation controlling the implementation.
- Validate types, UI build and package launch selection. Deliver on the feature branch; no merge, deploy or publish; record verified behavior and remaining gates.

## Scope boundaries

No Claude backend rewrite, model API reimplementation, ChatGPT web automation, browser provider switching, cross-provider transcript conversion, plugin-management UI or new cloud runtime. Generic ACP is a separate later stage reusing the same registry, event contract and capability model.

## Evidence

Existing `server/src/agent/types.ts`, `shared/src/agent.ts`, protocol, session manager, state checks, server composition, session picker, model/mode controls; local Codex CLI 0.166.0 generated JSON schemas (temporary artifacts); [App Server docs](https://learn.chatgpt.com/docs/app-server); [skill docs](https://learn.chatgpt.com/docs/build-skills); [codex-acp README](https://github.com/agentclientprotocol/codex-acp/blob/main/README.md), [steering](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/steering.md), [AIR extensions](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/air-extensions.md). Remote main-branch capabilities are design evidence, not a promise that a released package or installed Codex supports every method; pin and verify the runtime contract and test capability negotiation.
