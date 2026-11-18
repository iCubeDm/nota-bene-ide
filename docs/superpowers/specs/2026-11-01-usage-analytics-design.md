# Usage analytics

A separate tab, opened like Settings, with exact token accounting. It answers: (1) a limit was hit, roughly how many tokens was that and which tasks ate most; (2) which models ran and how much each took (an expensive model is wasted on plain parsing, earns its cost on review/architecture); (3) is a vendor's 100% worth fewer tokens than before (affects planning).

Non-goals: modelling the vendor's limit formula, prices in code, sending anything off the machine.

## Sources

Transcripts, not live window events: they cover Nota Bene windows and the plain CLI alike, with history from day one.

- Claude: `<config>/projects/**/*.jsonl`, `usage` per API call. A call spans several lines with final counts on the last, so calls merge by `message.id` taking the maximum of each field; forks copy calls into other files, so the merge is global. Subagents: `<session>/subagents/agent-*.jsonl` plus `.meta.json`.
- Codex: `<CODEX_HOME>/sessions` and `archived_sessions`. `token_usage_record` per call keyed by `response_id`, tied to the task by `root_turn_id`; `input_tokens` includes cached.
- Limit readings: Codex keeps them in `token_count.rate_limits` (has history). Claude keeps none, so the server records what it already reads for the meters; that series starts with this feature and has gaps while no window is open.
- Live limit hits: the SDK's rejected `rate_limit_event`, one per window (`resets`). With extra usage on, work continues and the transcript is silent, so an open window is the only witness (limit readings come the same way).
- Extra usage: tokens from such a hit to its reset (a one-model limit does not count: the others stay free) plus the vendor's cumulative `extra_usage.used_credits`. Dollars are real, never computed from tokens.
- Transcript hits: Claude's synthetic "You've hit your ... limit" message by the CLI's limit names (session and 5-hour; weekly, Opus, Sonnet, Fable are 7-day). Spend, budget, fast and credit limits share the wording and are no limit window. Codex `rate_limit_reached_type` is `rate_limit_reached` and does not name the window, so the fullest wins; `workspace_*` reasons are not counted.
- Records under a temporary folder (smoke runs, tests) are skipped.

## Store

`<NOTA_BENE_HOME>/usage/`, one store for all projects and windows; project is a field.

- `<provider>.jsonl` (600): append-only normalized records; numbers and short labels only (task label = first 64 chars of its prompt; subagent = description). No other conversation text.
- `<provider>.state.json`: per-transcript byte offset and parser context (incremental import).
- `trips.json`: reset point per provider; a reset moves the marker, deletes nothing.

The store outlives transcripts. One window imports at a time (lock directory); others read. Records are idempotent (a crash between append and offset save re-reads; the merge absorbs it). The first import reads everything in the background in chunks yielding to the event loop; the report answers at once and says it is still importing. Raising `PARSE_VERSION` re-reads every transcript. A task label skips the heading of a sent comment batch (the words above it, else its first comment).

## Report

Claude and Codex have separate counters and resets. Periods: since reset, 7 days, 30 days, all.

Comparison number is weighted tokens: input x1, cache write x1.25, cache read x0.1, output x5, same for every model (a raw sum would be almost only cache reads). A yardstick, not a price; raw counts sit beside it.

- Meter: weighted tokens (raw in a tooltip); bar of the top two models and the rest, calls, subagent share.
- Limit hits: two charts with hover tips, then a table. Five-hour windows: a hit closes its own window (the five hours before it); others open with the first call outside a window and are an estimate (vendor start unknown). Weeks: all time, idle too, red for weekly hits only. Row: tokens in the window before the hit (5 h, or the weekly window from its known start, else 7 days), calls, top projects, three costliest tasks on click. Hits within two hours are one event.
- Tank: weighted tokens per 1% of the weekly limit, per limit window, one line (window needs >= 1%). Falling means the 100% shrank.
- Where it went: costliest tasks or projects, five rows then all. A task = one user message and all agent work until the reply, subagents included; expands to subagents and costliest calls. A project = the folder the session started in (agents wander into subfolders/worktrees).
- Empty blocks are left out.

## API and web

- `GET /usage?provider=claude|codex&period=trip|7d|30d|all` (starts an import if none runs); `POST /usage/reset {provider}`. Both in the key tier. Shape `UsageReport` in `shared/src/usage.ts`.
- Tab kind `usage`, from a header button, one per window, not saved with file tabs, loads only while active, polls while importing. English and Russian.
