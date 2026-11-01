# Usage analytics

A separate tab, opened like Settings, with exact token accounting for tuning how work is spent.
It answers three questions:

1. A limit was hit: roughly how many tokens was that, and which tasks ate most of them?
2. Which models ran, and how much did each take? (An expensive model is wasted on plain text
   parsing and earns its cost on review and architecture.)
3. Is a vendor's 100% worth fewer tokens than it was? That changes project planning.

Non-goals: modelling the vendor's limit formula, prices in code, sending anything off the machine.

## Sources

Transcripts, not live window events: they cover Nota Bene windows and the plain CLI alike, and the
history is there on day one.

- Claude: `<config>/projects/**/*.jsonl`. `usage` per API call. One call spans several lines, the final
  counts are on the last one, so calls merge by `message.id` taking the maximum of each field. Forks copy
  calls into other files, so the merge is global. Subagents live in `<session>/subagents/agent-*.jsonl`
  with a `.meta.json` beside them.
- Codex: `<CODEX_HOME>/sessions` and `archived_sessions`. `token_usage_record` per call, keyed by
  `response_id`, tied to the task by `root_turn_id`. `input_tokens` includes the cached ones.
- Limit readings: Codex keeps them in `token_count.rate_limits`, so they have history. Claude keeps them
  nowhere, so the server records what it already reads for the meters; that series starts with this
  feature and has gaps while no window is open.
- Limit hits: Claude's synthetic "You've hit your ... limit" message, by the CLI's limit names (session and
  5-hour; weekly, Opus, Sonnet and Fable are 7-day). Spend, budget, fast and credit limits share the wording
  and are no limit window. Codex's `rate_limit_reached_type` is `rate_limit_reached` and does not name the
  window, so the fullest one decides; its `workspace_*` reasons are not counted.

Records under a temporary folder (smoke runs, tests) are skipped.

## Store

`<NOTA_BENE_HOME>/usage/`, one store for every project and window; the project is a field.

- `<provider>.jsonl` (600): append-only normalized records. Numbers and short labels: a task's label is
  the first 64 characters of its prompt, a subagent's its description. No other conversation text.
- `<provider>.state.json`: per-transcript byte offset and parser context, so imports are incremental.
- `trips.json`: the reset point per provider. A reset moves the marker and deletes nothing.

The store outlives the transcripts. One window imports at a time (a lock directory); another window just
reads. Records are idempotent: a crash between append and offset save re-reads and the merge absorbs it.
The first import reads everything, so it runs in the background, in chunks that yield to the event loop;
the report answers at once with what is there and says it is still importing.

## Report

Claude and Codex have separate counters and resets. Period: since the reset, 7 days, 30 days, all.

The comparison number is weighted tokens: input ×1, cache write ×1.25, cache read ×0.1, output ×5,
the same for every model. Raw sum would be almost only cache reads. It is a yardstick, not a price;
the raw counts stand beside it.

- Meter: weighted tokens, the raw counts in a tooltip. A bar of the two top models and the rest, calls and the
  subagents' share. Per-model raw counts in a tooltip.
- Limit hits: weighted per week, all time, idle weeks too, a week with a hit marked. Each hit: tokens in the
  window before it (5 hours or 7 days), by project and by model, and its three costliest tasks on a click.
  Hits within two hours are one event.
- Tank: weighted tokens per 1% of the weekly limit, per limit window, one line; a window needs at least 1%.
  Falling means the 100% shrank.
- Where it went: the costliest tasks or the projects, five rows, then all. A task is one user message and all
  the agent did until the reply, subagents included; it expands to its subagents and its costliest calls. A
  project is the folder its session started in: the agent wanders into subfolders and worktrees.
- A block with nothing to show is left out.

A task's label skips the heading of a sent batch of comments: the words above it, or else its first comment.
Raising `PARSE_VERSION` reads every transcript once more, so that a parser change reaches the store.

## API

- `GET /usage?provider=claude|codex&period=trip|7d|30d|all`, starts an import if none is running.
- `POST /usage/reset` `{ provider }`.

Both are in the key tier. The shape is `UsageReport` in `shared/src/usage.ts`.

## Web

A tab of kind `usage`, opened from a header button, one per window, not saved with the file tabs,
loading only while active and polling while the import runs. English and Russian.
