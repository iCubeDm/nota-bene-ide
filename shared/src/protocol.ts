import type { WireAgentEvent } from './agent.ts';
import type { ThemeId, UiLang, UiScale } from './lang.ts';
import { isAbsPath } from './paths.ts';

/** A tool-use id as the wire carries it (the Agent call's id, `agent` of a source, `tool` of `/subagent`): ids only, never path pieces. */
export const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A task id as the wire carries it (`task-stop`, `/task-output?task=`): the CLI's own ids (`b4k2x9...`), never a path piece. */
export const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A `! cmd` run's id (`shell-run`, `shell-stop`, the `shell-*` events): the client's uuid. */
export const SHELL_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The longest `cmd` of `shell-run` the server takes, in bytes (decimal: the UI says 32 kB, issue 469). */
export const SHELL_CMD_MAX = 32_000;
/** The last `cap` characters of `s`, never starting inside a surrogate pair. */
export function cutTail(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const t = s.slice(s.length - cap);
  const c = t.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff ? t.slice(1) : t;
}
/** What a `! cmd` run keeps of its output (in the feed, and for the agent): the last 64 000 characters, the cut marked `truncated`. */
export const SHELL_OUTPUT_CAP = 64_000;

/** `ref`: the branch a file comes from when it is not this window's checkout (a branch, or a worktree's branch). */
export type AnchorSource = { kind: 'message'; id: string; /** the toolUseId of the subagent whose conversation holds the item (protocol 7); absent: the main chat */ agent?: string } | { kind: 'file'; path: string; ref?: string };
export type FileSource = Extract<AnchorSource, { kind: 'file' }>;
export const MARK_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff'] as const;
export type MarkColor = (typeof MARK_COLORS)[number];
/** the largest mark image (`/marks`) the server takes */
export const MARK_MAX_BYTES = 25 * 1024 * 1024;
/** the most values (x and y each count) a pen stroke may carry */
export const PEN_MAX_VALUES = 20000;
/** the most points (x, y pairs) a polygon may carry (issue 447); the fewest is 3 */
export const POLYGON_MAX_POINTS = 500;
/**
 * All coordinates are relative to the media's natural size, 0..1. `polygon` (protocol 24, issue 447): a closed shape,
 * `points` x, y pairs; a media comment with polygons also has `mask.png` beside its frame (white inside any polygon,
 * nonzero rule, black outside).
 */
export type MediaShape =
  | { kind: 'rect' | 'ellipse'; color: MarkColor; x: number; y: number; w: number; h: number }
  | { kind: 'arrow'; color: MarkColor; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'pen'; color: MarkColor; points: number[] }
  | { kind: 'polygon'; color: MarkColor; points: number[] };
export type MediaAnchor = {
  kind: 'media'; source: FileSource; width: number; height: number;
  /** seconds at the pause (video only), ms precision */
  time?: number;
  /** the /file ETag when drawn */
  version?: string;
  /** set only when the frame and layer files were downscaled to fit MARK_MAX_BYTES (0 < scale < 1; both files) */
  scale?: number;
  /** empty (protocol 25, issue 494): a comment on the whole picture, as the phone makes one */
  shapes: MediaShape[];
};
export type TextAnchor = { source: AnchorSource; start: number; end: number; quote: string; prefix: string; suffix: string };
/** the most entries a page anchor's `trail` and `near` may carry, and the longest of each */
export const PAGE_LIST_MAX = 12;
export const PAGE_TEXT_MAX = 300;
/** the longest element path (`selector`) */
export const PAGE_SELECTOR_MAX = 2000;
/**
 * A place on a rendered HTML page (protocol 13): an element, or an area of an inline SVG. `selector`: the element by its
 * child positions from `body` (an area: its `svg`). `trail`: how it reads, outermost first, the element itself last;
 * also how it is found again when the page changed. `box`: the area in the SVG's own user units (its viewBox).
 * `near`: what an area covers or lies next to.
 */
export type PageAnchor = {
  kind: 'page'; source: FileSource; selector: string; trail: string[];
  box?: { x: number; y: number; w: number; h: number };
  near?: string[];
};
/**
 * Marks on an image attached to the unsent message (protocol 17): `image` is the composer's ImageRef id. Coordinates as in
 * MediaAnchor. Sent only in the message that carries that image.
 */
export type AttachmentAnchor = { kind: 'attachment'; image: string; width: number; height: number; scale?: number; shapes: MediaShape[] };
/** the longest clip id and track id of a cut anchor, its track name, and its `src` */
export const CUT_ID_MAX = 200;
export const CUT_NAME_MAX = 300;
export const CUT_SRC_MAX = 4096;
/**
 * The clip a cut comment is pinned to (protocol 23), as it stood when last seen in the editor: its id, its track's id and
 * name, its `src`, and `srcTime`, the comment's moment in the source in seconds (`in` + the offset into the clip; a photo:
 * the offset into its showing).
 */
export type CutAnchorClip = { id: string; track: string; trackName?: string; src: string; srcTime: number };
/**
 * A place on a video edit's timeline (`*.nbcut.json`, protocol 23): a clip at a moment of it, or (no `clip`) a moment of the
 * timeline. `time`: seconds on the timeline, ms precision. The editor keeps a pending comment on its clip by id: after a
 * move or a trim it updates `time` (and the track and src) through an `edit` op, `srcTime` staying.
 */
export type CutAnchor = { kind: 'cut'; source: FileSource; time: number; clip?: CutAnchorClip };
export type Anchor = TextAnchor | MediaAnchor | PageAnchor | AttachmentAnchor | CutAnchor;
export const isMediaAnchor = (a: Anchor): a is MediaAnchor => (a as MediaAnchor).kind === 'media';
export const isPageAnchor = (a: Anchor): a is PageAnchor => (a as PageAnchor).kind === 'page';
export const isAttachmentAnchor = (a: Anchor): a is AttachmentAnchor => (a as AttachmentAnchor).kind === 'attachment';
export const isCutAnchor = (a: Anchor): a is CutAnchor => (a as CutAnchor).kind === 'cut';
/** Where an anchor points in a file or message; none for an attachment anchor, which belongs to the unsent message. */
export const anchorSource = (a: Anchor): AnchorSource | undefined => (isAttachmentAnchor(a) ? undefined : a.source);
export const isTextAnchor = (a: Anchor): a is TextAnchor => !('kind' in a);
export const QUICK_LABEL_IDS = ['looks-good', 'fire', 'clarify', 'verify', 'example', 'overview', 'patterns',
  'alternatives', 'no-regression', 'out-of-scope', 'needs-tests'] as const;
export type QuickLabelId = (typeof QUICK_LABEL_IDS)[number];
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** id = sha256 hex (64 chars) of the stored bytes */
export type ImageRef = { id: string; mediaType: ImageType; label: string };
/** A stored recording (POST /voice): id = sha256 hex of the WAV, ms = its length, wave = VOICE_BARS bars of 0..31 (loudest = 31). */
export type Voice = { id: string; ms: number; wave: number[] };
/** A recording of a comment with its transcript. */
export type VoiceClip = Voice & { text: string };
export const VOICE_BARS = 48;
/** The recorders stop at 10 minutes; a little slack for the header and the stop's last buffer. */
export const VOICE_MAX_MS = 602_000;
export const VOICE_MAX_CLIPS = 10;
export const VOICE_CLIP_TEXT_MAX = 20_000;
/** Why a voice message has no transcript: Whisper went off, it heard nothing, or it failed. */
export type VoiceError = 'off' | 'empty' | 'failed';
export type TreeEntry = { name: string; dir: boolean };
/** `GET /complete?q=`: up to 30 project-relative paths, a folder with a trailing `/`. */
export type CompleteAnswer = string[];
/** `PUT /project-icon`: the stored picture's version. */
export type ProjectIconAnswer = { icon: string };
/**
 * Where files are read from (M3-16, read-only). Stable ids (persisted in tabs and tree state): 'here' (this window's
 * checkout), `ref:<branch>` (any other local branch), `dir:<12 hex of sha1(realpath)>` (a detached worktree).
 * `kind`/`dir` describe how it is served NOW: 'worktree' = from that live folder (absolute, realpath), 'branch' = from
 * git blobs. `ref`: the branch name ('' for a non-repo or a detached `here`; `(detached) <folder>` for a detached
 * worktree). `alias`: 'here' as the server was started with, when that differs from its realpath.
 */
export type Source = { id: string; kind: 'checkout' | 'worktree' | 'branch'; label: string; ref: string; dir?: string; alias?: string };
export type Comment = {
  id: string; anchor: Anchor; text: string; label?: QuickLabelId;
  status: 'pending' | 'sent'; createdAt: number;
  /** id of the user message that carried it */
  sentIn?: string;
  /** attachment ids; labels are assigned at send time */
  images?: string[];
  /** media comments: how many leading `images` the app generated (the frame, plus the transparent layer in old comments); the rest were pasted. Absent = 2 (old comments). An attachment comment (protocol 17) generates 1 (the marked image). */
  genImages?: number;
  /** protocol 14: recordings with their transcripts, at most VOICE_MAX_CLIPS; the batch carries their texts after `text` */
  voice?: VoiceClip[];
};

/** The number of leading generated images of a comment (0 for a non-media one); the pasted ones follow. */
export const generatedImages = (c: Comment): number => (isMediaAnchor(c.anchor) ? c.genImages ?? 2 : isAttachmentAnchor(c.anchor) ? c.genImages ?? 1 : 0);

export { FEATURES, has, type Feature } from './features.ts';
/** The protocol this server speaks, announced in `hello`: the largest entry of `FEATURES`, where each number's additions are. */
export const PROTOCOL = 29;

/** protocol 27: a send the server holds behind a pending restart or compaction (issue 499), as the feed shows it */
export type HeldSend = { id: string; text: string; ts: number; images?: ImageRef[]; voice?: Voice };

/** A paired device (a phone or another computer) as the Remote tab lists it (protocol 20). */
export type RemoteDevice = { id: string; name?: string; fingerprint: string; online: boolean; pairedAt: number };
/** The link to a paired computer: `failing` while its retries get no channel, `revoked` when it refused this one. */
export type RemoteHostState = 'online' | 'connecting' | 'failing' | 'revoked';
/** A computer this one is paired with as a device (protocol 28); `fingerprint` is its host key's. */
export type RemoteHost = { id: string; name?: string; fingerprint: string; state: RemoteHostState; pairedAt: number };

/**
 * Why a `/remote` route refused (issue 507): its answer carries this as `code` beside the English `error` (what the CLI
 * prints), and `detail` when the text needs a value (the relay's close code of `relayUnreachable`). The page says it in its
 * language; an older server sends only `error`, shown as it is.
 */
export type RemoteRefusalCode =
  | 'notPairCode' | 'pairCodeVersion' | 'ownPairCode' | 'hostSilent' | 'codeRefused' | 'hostOffline' | 'hostFull' | 'relayUnreachable'
  | 'notUrl' | 'relayNotWss' | 'phoneCodeNotKey' | 'badAccessKey' | 'noRelay' | 'legacy' | 'notRunning' | 'unavailable';

/** What a window knows of the remote-access connector (`nota-bene remote`), shared by every window of the user. */
export type RemoteState = {
  /** a relay address is saved */
  configured: boolean;
  /** access is not turned off */
  enabled: boolean;
  /** the connector answers on its control socket */
  running: boolean;
  /** the connector is connected to the relay */
  online: boolean;
  relay: string | null;
  hostFingerprint: string | null;
  devices: RemoteDevice[];
  /** a pairing code is valid; `mine`: this window started it (only that one shows the code) */
  pairing: { expiresAt: number; mine: boolean } | null;
  /** the connector was started in a terminal by an older version: it cannot be switched from a window */
  legacy: boolean;
  /** the relay refused the host: for good (4402 and the like: the connector stopped), or 4405 while it retries (the access key is on the most computers allowed) */
  lastError: { code: number; message: string; at: number } | null;
  /** protocol 21: an access key for the relay is saved (the key itself never leaves the server) */
  accessKey: boolean;
  /** a window tried to start the connector and it did not come up (no relay refusal explains it) */
  startFailed: boolean;
  /** protocol 28: the computers this one connects to as a device (an older server sends none) */
  hosts?: RemoteHost[];
};

export type RemotePairResult = 'paired' | 'refused' | 'expired' | 'cancelled';

/** close code the owner gets when another tab takes the window over (R-M7-5/8); the page never reconnects after it by itself */
export const TAKEN_OVER_CODE = 4001;

export const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export const CODEX_MODES = ['codex-configured', 'codex-read-only', 'codex-workspace', 'codex-full-access'] as const;
export const OMP_MODES = ['omp-yolo', 'omp-write', 'omp-ask', 'omp-plan'] as const;
export const ALL_MODES = [...MODES, ...CODEX_MODES, ...OMP_MODES] as const;
export type Mode = (typeof MODES)[number];
export type AgentMode = (typeof ALL_MODES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal'] as const;
export type AgentEffort = (typeof EFFORT_LEVELS)[number];
export type EffortLevel = Exclude<AgentEffort, 'none' | 'minimal'>;
/**
 * A model the agent offers. `value` is what is sent back to pick it (an alias such as `sonnet`); `resolved` the full id
 * the agent reports for it once running (`claude-…`), to match the two; `efforts` only for a model that has effort levels.
 */
export type ModelOption = { value: string; name: string; description: string; resolved?: string; efforts?: AgentEffort[]; defaultEffort?: AgentEffort };
/**
 * A slash command or skill the composer's `/` menu offers (already filtered by the server: nothing bound to a terminal).
 * `hint` is the argument hint (`[name]`), `aliases` other names that run it; `builtin`: the agent's own, not the user's or a plugin's.
 */
export type SlashCommand = { name: string; description: string; hint?: string; aliases?: string[]; builtin?: boolean };
/** a model with its effort; the model alone when the effort is the model's default */
export type ModelChoice = { model: string; effort?: AgentEffort };

/**
 * What the agent behind the server can do (R-M7-15), announced in `hello`; the UI hides a control whose capability is
 * false and the server refuses the matching client message. `modes`: the permission modes it offers (empty: no mode pill).
 * `models`: it lists models and switches model and effort on a running session (the server refuses the `model` message otherwise).
 */
export type Capabilities = {
  compact: boolean; clear: boolean; modes: AgentMode[]; usage: boolean; fileSuggestions: boolean; fork: boolean; idleCompact: boolean; models: boolean;
  /** speech to text runs on the host (Whisper installed, ready and switched on); absent: not offered. Set by the server, not by the agent. */
  dictation?: 'whisper';
  provider?: 'claude' | 'codex' | 'omp';
  taskBackground?: boolean;
  taskOutput?: boolean;
  /** the agent deletes a stored session for good (POST /sessions/delete); absent: the Sessions menu offers no delete */
  deleteSession?: boolean;
  /** the video editor's export: true = ffmpeg was found on the host (`/cut/export` renders an edit), false = this server can
   * export but found no ffmpeg (the page explains how to install it); absent: a server without the export routes. Set by
   * the server, not by the agent. */
  ffmpeg?: boolean;
};
/** Claude Code's set; the web assumes it when `hello` carries none (a server older than protocol 5). */
export const CLAUDE_CAPABILITIES: Capabilities = {
  compact: true, clear: true, modes: [...MODES], usage: true, fileSuggestions: true, fork: true, idleCompact: true, models: true,
};
/** percent 0..100 */
export type Limit = { utilization: number; resets_at: string | null };
export type Stats = {
  context: { used: number; max: number; pct: number } | null;
  limits: { five_hour: Limit | null; seven_day: Limit | null } | null;
  cost: number | null;
  windows?: (Limit & { label: string; minutes: number | null })[];
  /** extra usage in this billing period, in minor units of `currency` */
  extra?: { used: number; limit: number | null; currency: string | null };
};

export type Interaction = {
  title: string;
  /** the tool the ask is for, when the title is not its name; the audit log and the permission event's toolName use it */
  tool?: string;
  choices: { id: string; label: string; allow?: boolean }[];
  /** `header`: a short tag over the label; `notes[i]`: the description of `options[i]`; `multi`: several options may be picked (the value is their labels, comma-separated) */
  fields?: { id: string; label: string; secret?: boolean; options?: string[]; required?: boolean; header?: string; notes?: string[]; multi?: boolean }[];
  url?: string;
};
export type InteractionAnswer = { choice: string; values?: Record<string, string> };

/**
 * One change to a session's comments (protocol 19). `add` of a stored id changes nothing (a resent op); it goes before the
 * comment `before` names (appended when absent or not stored), and `restore` (the Undo of a deletion) may bring back a
 * deleted id. `edit` carries the comment as edited, of which the server takes the text, label, images, recordings and
 * generated-image count; `remove` leaves the id deleted, so no later add brings it back except a `restore`.
 */
export type CommentOp =
  | { op: 'add'; comment: Comment; before?: string; restore?: true }
  | { op: 'edit'; comment: Comment }
  | { op: 'remove'; id: string };
/** gone: the comment was deleted, or is missing for an edit; sent: a sent comment cannot change (the client drops the op);
 * failed: the server could not store it (the client keeps the op and sends it again) */
export type CommentRefusal = 'gone' | 'sent' | 'failed' | 'invalid';
/** at most this many ops in one `comment-op` */
export const COMMENT_OPS_MAX = 50;

export type ClientMessage =
  /** protocol 14 (comments riding along: 16): with `voice`, `text` is '' and there are no `images` or `commentIds`, unless pending comments ride along (protocol 16): then `commentIds` is not empty, `text` is their batch (what a typed send carries after the typed words) and `images` theirs; the agent gets the transcript, then the batch. `force` works as for text (the turn is interrupted once the transcript is in); the server transcribes it in `lang` (ISO 639) and the agent gets the text */
  | { type: 'send'; id: string; text: string; force?: boolean; commentIds?: string[]; images?: ImageRef[]; voice?: Voice; lang?: string; /** protocol 18, voice only: detect the spoken language (`lang` is the fallback when unsure); absent = transcribe in `lang` */ detect?: true }
  /** full replacement of this session's comment set */
  | { type: 'comments'; sessionId: string | null; items: Comment[] }
  /** protocol 19: applied to `sessionId`'s set (null: the window's current one), all or none */
  | { type: 'comment-op'; opId: string; sessionId: string | null; ops: CommentOp[] }
  | { type: 'interrupt' }
  /** `input` is ignored by the server (an allow always runs the original input); no client sends it. */
  | { type: 'permission'; id: string; allow: boolean; response?: InteractionAnswer }
  /** `id`: echoed back as the `mode` event's `ack`, so the sender can tell its own echo from the others */
  | { type: 'mode'; mode: AgentMode; id?: string }
  /** `model` is a `ModelOption.value`; no `effort` = the model's default. `id`: echoed as the `model` event's `ack` */
  | { type: 'model'; model: string; effort?: AgentEffort; id?: string }
  | { type: 'command'; name: 'compact' | 'clear' }
  /** protocol 27: drop the pending compaction; the held sends go (unless a restart is still pending) */
  | { type: 'compact-cancel' }
  /** id null = a new session in dir; dir is absolute */
  | { type: 'switch'; id: string | null; dir: string }
  | { type: 'restart' }
  /** the user touched the UI (throttled by the client): the idle-compaction clock starts again */
  | { type: 'activity' }
  /** idle compaction on or off for this project */
  | { type: 'idle-compact'; on: boolean }
  /** from an occupied socket (R-M7-5): the window moves here; the old owner is closed with 4001 */
  | { type: 'takeover' }
  /** protocol 8: stop the running task `id` (a task_id); a refusal comes back as a `server-error` */
  | { type: 'task-stop'; id: string }
  /** protocol 8: move the foreground task started by the tool call `toolUseId` to the background; a refusal (or no match) comes back as a `server-error` */
  | { type: 'task-background'; toolUseId: string }
  /** protocol 11: run `cmd` (at most SHELL_CMD_MAX bytes) as a shell command in the project folder, outside the agent; a refusal comes back as a `server-error` */
  | { type: 'shell-run'; id: string; cmd: string }
  /** protocol 11: stop the run `id` (TERM, then KILL); no match is no news */
  | { type: 'shell-stop'; id: string };

/**
 * Idle compaction of this window's project. `on` is the project's setting; `blocked`: `"idleCompaction": false` in the
 * user's Claude Code settings.json keeps it off whatever `on` says.
 */
/** `minutes` after the last turn, if the window saw no activity for `awayMinutes` */
export type IdleCompact = { on: boolean; blocked: boolean; minutes: number; awayMinutes: number; minTokens: number };

export type ServerEvent =
  /** another tab owns the window (R-M7-5): to a later socket only, followed by `hello`; no replay, no state */
  | { kind: 'occupied' }
  /** to the owner just before it is closed with code 4001: another tab took the window over */
  | { kind: 'taken-over' }
  /** right after the replay on every connection (servers before it send none: protocol 0) */
  | { kind: 'hello'; protocol: number; capabilities?: Capabilities; /** the UI language chosen on any window (server prefs.json); absent = none chosen yet */ lang?: UiLang; /** the interface scale chosen on any window, the same way; absent = none chosen (1) */ uiScale?: UiScale; /** the colour theme chosen on any window, the same way; absent = none chosen (the default theme) */ theme?: ThemeId; /** the temp folders (real and as named) whose images /tmpimage serves; the page links a path under one of them */ tmpDirs?: string[]; /** protocol 18: where the user chose the spoken language of dictation (server prefs.json): `auto` or an ISO 639 code; absent = none chosen (auto) */ dictationLang?: string }
  /** `earlier`: how many segments of this conversation, from before its compactions, `/history` holds (R-M7-4); absent for none */
  | { kind: 'replay'; events: ServerEvent[]; earlier?: number }
  /** what the agent said (R-M7-14); `init` and `rate-limit` are server-internal and never sent */
  | { kind: 'agent'; e: WireAgentEvent; ts: number }
  /** `idle`: a `/compact` the server sent itself after the session sat idle */
  /** `voice`: a voice message; its `text` is '' until the `voice-text` event (a replayed history has the transcript in it) */
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; historic?: boolean; images?: ImageRef[]; idle?: boolean; voice?: Voice; /** protocol 18: the language a replayed voice message was transcribed in, when known */ voiceLang?: string }
  /** protocol 14, stored: the transcript of the voice message `id`, or why there is none (then the agent got nothing) */
  | { kind: 'voice-text'; id: string; text?: string; error?: VoiceError; /** protocol 18: the language the transcript was made in (the detected one with `send.detect`) */ lang?: string; ts: number }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; prompt?: Interaction; ts: number }
  | { kind: 'permission-done'; id: string; allow: boolean; ts: number }
  /** full comment set; never stored in history, so no ts */
  /** protocol 19: `rev` grows with every change of the set; `ack` names the `comment-op`s this change applied */
  | { kind: 'comments'; items: Comment[]; rev?: number; ack?: string[] }
  /** protocol 19, to the sender only: its `comment-op` was applied to a session the window does not show */
  | { kind: 'comment-ack'; opId: string }
  /** protocol 19, to the sender only: nothing of the `comment-op` was applied; `id` names the comment that refused it */
  | { kind: 'comment-refused'; opId: string; reason: CommentRefusal; id?: string }
  /** protocol 20: the connector's state, on attach and when it changes */
  | { kind: 'remote'; state: RemoteState }
  /** protocol 20: what became of the pairing this window started; `fingerprint`: a refused phone's */
  | { kind: 'remote-pair'; result: RemotePairResult; device?: RemoteDevice; fingerprint?: string }
  | { kind: 'session'; id: string | null; root: string; title: string | null; model: string | null }
  /** never stored in history */
  | { kind: 'stats'; stats: Stats }
  /** never stored in history */
  /** `ack`: the id of the `mode` message this answers (none when the mode changed otherwise) */
  | { kind: 'mode'; mode: AgentMode; ack?: string }
  /** the model the agent runs (null until known) and its effort when set; never stored. `ack`: the id of the `model` message this answers */
  | { kind: 'model'; model: string | null; effort?: AgentEffort; ack?: string }
  /** the models the agent offers; never stored */
  | { kind: 'models'; models: ModelOption[] }
  /** the slash commands and skills of the session (user's first), replacing the last list; never stored */
  | { kind: 'commands'; commands: SlashCommand[] }
  /** never stored in history */
  | { kind: 'idle-compact'; state: IdleCompact }
  /** stored once after the replayed transcript of a resumed session; the only source of the "resumed" notice */
  /** protocol 22, `cut`: the server stopped during a turn of this session (a forced restart, a stop, a crash); the page offers Continue */
  | { kind: 'resumed'; id: string; cut?: true }
  /** protocol 22, never stored: a server restart is waiting for the next pause (on attach and when it changes) */
  | { kind: 'restart-pending'; pending: boolean }
  /**
   * protocol 27, never stored: a compaction waits for the next pause (`pending`), and the sends held until a pending
   * restart and compaction went, oldest first (on attach and when either changes)
   */
  | { kind: 'compact-pending'; pending: boolean; held: HeldSend[] }
  /** protocol 27, to the asking socket only, never stored: its send is held (see `compact-pending`), or its typed `/compact` became the pending compaction; a `user` event follows when the send goes */
  | { kind: 'send-held'; id: string }
  | { kind: 'server-error'; where: string; message: string }
  /** to the asking socket only, never stored: a `send` the server did not take (the web side clears its pending state) */
  | { kind: 'send-refused'; id: string; reason: 'busy' | 'switching' | 'detached' }
  /** a `! cmd` run began (protocol 11); stored, so a reload shows the block */
  | { kind: 'shell-start'; id: string; cmd: string; ts: number }
  /**
   * the output of the run `id` so far, ANSI stripped, stdout and stderr merged: the last SHELL_OUTPUT_CAP characters, REPLACING what the
   * page shows (`truncated`: more came before). Sent at most about ten times a second, and not to a socket that is far behind, so
   * a flood cannot pile up in the server; live only. A new socket gets the output so far in one of these.
   */
  | { kind: 'shell-out'; id: string; text: string; truncated: boolean }
  /** to the asking socket only, never stored: a `shell-run` the server did not take (the page puts the draft back) */
  | { kind: 'shell-refused'; id: string; reason: 'running' | 'switching' }
  /**
   * the run `id` ended. `output`: its merged output, the last SHELL_OUTPUT_CAP characters (`truncated`: more came before).
   * `code`: the exit code (null: killed by a signal, or never started); `stop`: why the server stopped it (the user's
   * `shell-stop`, the timeout; a switch or a close stops quietly and ends nothing); `error`: it could not start. `cmd` again: the start may have been archived by then.
   */
  | { kind: 'shell-end'; id: string; cmd: string; output: string; truncated: boolean; code: number | null; stop?: ShellStop; error?: string; ts: number };

export type ShellStop = 'user' | 'timeout';

type Obj = Record<string, unknown>;

function isSend(o: Obj): o is Obj & ClientMessage {
  const plain = typeof o.id === 'string' && typeof o.text === 'string'
    && (o.force === undefined || typeof o.force === 'boolean')
    && (o.commentIds === undefined || isStringArray(o.commentIds))
    && (o.images === undefined || (Array.isArray(o.images) && o.images.every(isImageRef)));
  if (!plain) return false;
  if (o.detect !== undefined && typeof o.detect !== 'boolean') return false;
  if (o.voice === undefined) return o.lang === undefined && o.detect === undefined;
  // a voice message is only the voice, plus the pending comments that ride along (their batch text and images)
  const rides = Array.isArray(o.commentIds) && o.commentIds.length > 0;
  return isVoice(o.voice) && (rides || (o.text === '' && o.images === undefined && o.commentIds === undefined))
    && typeof o.lang === 'string' && LANG.test(o.lang);
}

/** An ISO 639 language code, as Whisper takes it (en, ru, yue). */
const LANG = /^[a-z]{2,3}$/;

export function isVoice(v: unknown): v is Voice {
  return isObj(v) && isImageId(v.id) && Number.isInteger(v.ms) && (v.ms as number) > 0 && (v.ms as number) <= VOICE_MAX_MS
    && Array.isArray(v.wave) && v.wave.length === VOICE_BARS && v.wave.every((b) => Number.isInteger(b) && b >= 0 && b <= 31);
}

function isClip(v: unknown): v is VoiceClip {
  return isVoice(v) && typeof (v as Obj).text === 'string' && ((v as Obj).text as string).length <= VOICE_CLIP_TEXT_MAX;
}

const toVoice = (v: Voice): Voice => ({ id: v.id, ms: v.ms, wave: [...v.wave] });

const IMAGE_ID = /^[0-9a-f]{64}$/;

function isImageId(v: unknown): v is string {
  return typeof v === 'string' && IMAGE_ID.test(v);
}

function isImageRef(v: unknown): v is ImageRef {
  return isObj(v) && isImageId(v.id) && (IMAGE_TYPES as readonly unknown[]).includes(v.mediaType)
    && typeof v.label === 'string';
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isOffset(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isFileSource(s: Obj): boolean {
  const refOk = s.ref === undefined || (typeof s.ref === 'string' && s.ref.length > 0 && s.ref.length <= 200);
  return s.kind === 'file' && typeof s.path === 'string' && refOk;
}

const isRel = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
/** Slack for a box that ends at the edge: its ends are rounded to 4 decimals independently. */
const EDGE_EPS = 1e-4;
const isMarkColor = (v: unknown): v is MarkColor => (MARK_COLORS as readonly unknown[]).includes(v);

function isMediaShape(v: unknown): v is MediaShape {
  if (!isObj(v) || !isMarkColor(v.color)) return false;
  switch (v.kind) {
    case 'rect':
    case 'ellipse':
      return isRel(v.x) && isRel(v.y) && isRel(v.w) && isRel(v.h) && v.w > 0 && v.h > 0
        && v.x + v.w <= 1 + EDGE_EPS && v.y + v.h <= 1 + EDGE_EPS; // inside the media
    case 'arrow':
      return isRel(v.x1) && isRel(v.y1) && isRel(v.x2) && isRel(v.y2);
    case 'pen':
      return Array.isArray(v.points) && v.points.length >= 2 && v.points.length <= PEN_MAX_VALUES
        && v.points.length % 2 === 0 && v.points.every(isRel);
    case 'polygon':
      return Array.isArray(v.points) && v.points.length >= 6 && v.points.length <= 2 * POLYGON_MAX_POINTS
        && v.points.length % 2 === 0 && v.points.every(isRel);
    default:
      return false;
  }
}

function isMediaAnchorShape(v: Obj): boolean {
  return isObj(v.source) && isFileSource(v.source) && isPos(v.width) && isPos(v.height)
    && (v.time === undefined || (typeof v.time === 'number' && Number.isFinite(v.time) && v.time >= 0))
    && (v.version === undefined || (typeof v.version === 'string' && v.version.length <= 200))
    && (v.scale === undefined || (typeof v.scale === 'number' && v.scale > 0 && v.scale < 1))
    && Array.isArray(v.shapes) && v.shapes.every(isMediaShape);
}

function isAttachmentAnchorShape(v: Obj): boolean {
  return isImageId(v.image) && isPos(v.width) && isPos(v.height)
    && (v.scale === undefined || (typeof v.scale === 'number' && v.scale > 0 && v.scale < 1))
    && Array.isArray(v.shapes) && v.shapes.length > 0 && v.shapes.every(isMediaShape);
}

const isPageText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= PAGE_TEXT_MAX;
const isPageList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= PAGE_LIST_MAX && v.every(isPageText);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isPageAnchorShape(v: Obj): boolean {
  const b = v.box;
  return isObj(v.source) && isFileSource(v.source) && typeof v.selector === 'string' && v.selector.length > 0 && v.selector.length <= PAGE_SELECTOR_MAX && isPageList(v.trail) && v.trail.length > 0
    && (b === undefined || (isObj(b) && isNum(b.x) && isNum(b.y) && isPos(b.w) && isPos(b.h)))
    && (v.near === undefined || isPageList(v.near));
}

// no control characters (a break, a tab): a cut anchor's fields go into one line of the batch's quote
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/\p{Cc}/u.test(v);
const isTime = (v: unknown): v is number => isNum(v) && v >= 0;

function isCutAnchorShape(v: Obj): boolean {
  const c = v.clip;
  return isObj(v.source) && isFileSource(v.source) && isTime(v.time)
    && (c === undefined || (isObj(c) && isStr(c.id, CUT_ID_MAX) && isStr(c.track, CUT_ID_MAX) && isStr(c.src, CUT_SRC_MAX) && isTime(c.srcTime)
      && (c.trackName === undefined || isStr(c.trackName, CUT_NAME_MAX))));
}

function isAnchor(v: unknown): v is Anchor {
  if (!isObj(v)) return false;
  if (v.kind === 'media') return isMediaAnchorShape(v);
  if (v.kind === 'page') return isPageAnchorShape(v);
  if (v.kind === 'attachment') return isAttachmentAnchorShape(v);
  if (v.kind === 'cut') return isCutAnchorShape(v);
  if (v.kind !== undefined) return false;
  if (!isObj(v.source)) return false;
  const s = v.source;
  const sourceOk = (s.kind === 'message' && typeof s.id === 'string' && (s.agent === undefined || (typeof s.agent === 'string' && TOOL_USE_ID.test(s.agent)))) || isFileSource(s);
  return sourceOk && isOffset(v.start) && isOffset(v.end) && v.end >= v.start
    && typeof v.quote === 'string' && typeof v.prefix === 'string' && typeof v.suffix === 'string';
}

/** A comment's fields with their checks, in order: the first that fails names what a refused op got wrong (issue 494). */
const COMMENT_FIELDS: [string, (v: Obj) => boolean][] = [
  ['id', (v) => typeof v.id === 'string'],
  ['anchor', (v) => isAnchor(v.anchor)],
  ['voice', (v) => v.voice === undefined || (Array.isArray(v.voice) && v.voice.length <= VOICE_MAX_CLIPS && v.voice.every(isClip))],
  ['label', (v) => v.label === undefined || (QUICK_LABEL_IDS as readonly unknown[]).includes(v.label)],
  // empty text is allowed only for a one-click quick label, with recordings, or with images (issue 497)
  ['text', (v) => typeof v.text === 'string' && (v.text !== '' || v.label !== undefined || [v.voice, v.images].some((l) => Array.isArray(l) && l.length > 0))],
  ['status', (v) => v.status === 'pending' || v.status === 'sent'],
  ['createdAt', (v) => isOffset(v.createdAt)],
  ['sentIn', (v) => v.sentIn === undefined || typeof v.sentIn === 'string'],
  ['images', (v) => v.images === undefined || (Array.isArray(v.images) && v.images.every(isImageId))],
  ['genImages', (v) => v.genImages === undefined || isOffset(v.genImages)],
];

function isComment(v: unknown): v is Comment {
  return isObj(v) && COMMENT_FIELDS.every(([, ok]) => ok(v));
}

/** Which op of [ops] fails, and where: `ops[1].comment.anchor`, or `ops[1]` for the op's own fields. */
function opFault(ops: unknown[]): string {
  const i = ops.findIndex((o) => !isCommentOp(o));
  const o = ops[i];
  const field = isObj(o) && isObj(o.comment) && (o.op === 'add' || o.op === 'edit') ? COMMENT_FIELDS.find(([, ok]) => !ok(o.comment as Obj))?.[0] : undefined;
  return `ops[${i}]${field ? `.comment.${field}` : ''}`;
}

function isCommentOp(v: unknown): v is CommentOp {
  if (!isObj(v)) return false;
  if (v.op === 'remove') return typeof v.id === 'string' && v.id !== '';
  if (v.op === 'add') {
    return isComment(v.comment) && (v.before === undefined || typeof v.before === 'string') && (v.restore === undefined || v.restore === true);
  }
  return v.op === 'edit' && isComment(v.comment);
}

function isPermission(o: Obj): boolean {
  return typeof o.id === 'string' && typeof o.allow === 'boolean';
}

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const isMode = (v: unknown): v is AgentMode => (ALL_MODES as readonly unknown[]).includes(v);
const isEffort = (v: unknown): v is AgentEffort => (EFFORT_LEVELS as readonly unknown[]).includes(v);
export const isSessionId = (v: unknown): v is string => typeof v === 'string' && SESSION_ID.test(v);

function toSource(s: AnchorSource): AnchorSource {
  if (s.kind === 'message') return s.agent === undefined ? { kind: 'message', id: s.id } : { kind: 'message', id: s.id, agent: s.agent };
  return s.ref === undefined ? { kind: 'file', path: s.path } : { kind: 'file', path: s.path, ref: s.ref };
}

function toShape(s: MediaShape): MediaShape {
  switch (s.kind) {
    case 'rect':
    case 'ellipse': return { kind: s.kind, color: s.color, x: s.x, y: s.y, w: s.w, h: s.h };
    case 'arrow': return { kind: 'arrow', color: s.color, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
    case 'pen':
    case 'polygon': return { kind: s.kind, color: s.color, points: [...s.points] };
  }
}

/** exported for tests */
export function toAnchor(a: Anchor): Anchor {
  if (isMediaAnchor(a)) {
    return {
      kind: 'media', source: toSource(a.source) as FileSource, width: a.width, height: a.height,
      ...(a.time === undefined ? {} : { time: a.time }),
      ...(a.version === undefined ? {} : { version: a.version }),
      ...(a.scale === undefined ? {} : { scale: a.scale }),
      shapes: a.shapes.map(toShape),
    };
  }
  if (isPageAnchor(a)) {
    return {
      kind: 'page', source: toSource(a.source) as FileSource, selector: a.selector, trail: [...a.trail],
      ...(a.box === undefined ? {} : { box: { x: a.box.x, y: a.box.y, w: a.box.w, h: a.box.h } }),
      ...(a.near === undefined ? {} : { near: [...a.near] }),
    };
  }
  if (isAttachmentAnchor(a)) {
    return {
      kind: 'attachment', image: a.image, width: a.width, height: a.height,
      ...(a.scale === undefined ? {} : { scale: a.scale }),
      shapes: a.shapes.map(toShape),
    };
  }
  if (isCutAnchor(a)) {
    const c = a.clip;
    return {
      kind: 'cut', source: toSource(a.source) as FileSource, time: a.time,
      ...(c === undefined ? {} : { clip: { id: c.id, track: c.track, ...(c.trackName === undefined ? {} : { trackName: c.trackName }), src: c.src, srcTime: c.srcTime } }),
    };
  }
  return { source: toSource(a.source), start: a.start, end: a.end, quote: a.quote, prefix: a.prefix, suffix: a.suffix };
}

/** rebuild from known fields only, so unknown keys never reach storage or rebroadcast */
function toComment(c: Comment): Comment {
  return {
    id: c.id, anchor: toAnchor(c.anchor), text: c.text,
    ...(c.label === undefined ? {} : { label: c.label }),
    status: c.status, createdAt: c.createdAt,
    ...(c.sentIn === undefined ? {} : { sentIn: c.sentIn }),
    ...(c.images === undefined ? {} : { images: [...c.images] }),
    ...(c.genImages === undefined ? {} : { genImages: c.genImages }),
    ...(c.voice === undefined ? {} : { voice: c.voice.map((v) => ({ ...toVoice(v), text: v.text })) }),
  };
}

function toCommentOp(o: CommentOp): CommentOp {
  if (o.op === 'remove') return { op: 'remove', id: o.id };
  if (o.op === 'edit') return { op: 'edit', comment: toComment(o.comment) };
  return { op: 'add', comment: toComment(o.comment), ...(o.before === undefined ? {} : { before: o.before }), ...(o.restore ? { restore: true } : {}) };
}

function toImageRef(i: ImageRef): ImageRef {
  return { id: i.id, mediaType: i.mediaType, label: i.label };
}

/** `opId`: a comment-op that did not parse, answered `comment-refused` `invalid`. */
export function parseClientMessage(raw: string): ClientMessage | { error: string; opId?: string } {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { error: 'message must be an object' };
  const m = o as Obj;
  switch (m.type) {
    case 'send':
      if (!isSend(m)) return { error: 'send needs string id, string text, optional boolean force and optional string[] commentIds and optional images: ImageRef[]; or a voice with lang (and optional boolean detect), and empty text and nothing else unless commentIds ride along' };
      return {
        type: 'send', id: m.id as string, text: m.text as string,
        ...(m.force === undefined ? {} : { force: m.force as boolean }),
        ...(m.commentIds === undefined ? {} : { commentIds: m.commentIds as string[] }),
        ...(m.images === undefined ? {} : { images: (m.images as ImageRef[]).map(toImageRef) }),
        ...(m.voice === undefined ? {} : { voice: toVoice(m.voice as Voice), lang: m.lang as string, ...(m.detect === true ? { detect: true as const } : {}) }),
      };
    case 'comments':
      if (m.sessionId !== null && typeof m.sessionId !== 'string') return { error: 'comments needs sessionId: string | null' };
      if (!Array.isArray(m.items) || !m.items.every(isComment)) return { error: 'comments needs items: valid Comment[]' };
      return { type: 'comments', sessionId: m.sessionId, items: (m.items as Comment[]).map(toComment) };
    case 'comment-op':
      if (typeof m.opId !== 'string' || m.opId === '' || m.opId.length > 100) return { error: 'comment-op needs opId: a short string' };
      // past here the opId is usable: the server answers it `invalid`, so the client does not keep the op forever (issue 494)
      if (m.sessionId !== null && typeof m.sessionId !== 'string') return { error: 'comment-op needs sessionId: string | null', opId: m.opId };
      if (!Array.isArray(m.ops) || m.ops.length === 0 || m.ops.length > COMMENT_OPS_MAX) return { error: 'comment-op needs ops: 1 to 50 valid CommentOp', opId: m.opId };
      if (!m.ops.every(isCommentOp)) return { error: `comment-op needs ops: 1 to 50 valid CommentOp; ${opFault(m.ops)} is not`, opId: m.opId };
      return { type: 'comment-op', opId: m.opId, sessionId: m.sessionId, ops: (m.ops as CommentOp[]).map(toCommentOp) };
    case 'interrupt':
      return { type: 'interrupt' };
    case 'permission':
      if (!isPermission(m) || (m.response !== undefined && (!isObj(m.response) || typeof m.response.choice !== 'string' || m.response.choice.length > 128 || (m.response.values !== undefined && (!isObj(m.response.values) || Object.keys(m.response.values).length > 100 || !Object.values(m.response.values).every((v) => typeof v === 'string' && v.length <= 32768)))))) return { error: 'permission needs string id and boolean allow' };
      return {
        type: 'permission', id: m.id as string, allow: m.allow as boolean,
        ...(m.response === undefined ? {} : { response: m.response as InteractionAnswer }),
      };
    case 'mode':
      if (!isMode(m.mode)) return { error: `mode must be one of ${MODES.join(', ')}` };
      if (m.id !== undefined && (typeof m.id !== 'string' || m.id.length > 64)) return { error: 'mode id must be a short string' };
      return { type: 'mode', mode: m.mode, ...(m.id !== undefined && { id: m.id }) };
    case 'model':
      if (typeof m.model !== 'string' || m.model === '' || m.model.length > 200) return { error: 'model needs a model id string' };
      if (m.effort !== undefined && !isEffort(m.effort)) return { error: `effort must be one of ${EFFORT_LEVELS.join(', ')}` };
      if (m.id !== undefined && (typeof m.id !== 'string' || m.id.length > 64)) return { error: 'model id must be a short string' };
      return { type: 'model', model: m.model, ...(m.effort !== undefined && { effort: m.effort }), ...(m.id !== undefined && { id: m.id }) };
    case 'command':
      if (m.name !== 'compact' && m.name !== 'clear') return { error: 'command name must be compact or clear' };
      return { type: 'command', name: m.name };
    case 'compact-cancel':
      return { type: 'compact-cancel' };
    case 'switch':
      if (m.id !== null && !isSessionId(m.id)) return { error: 'switch needs id: session uuid or null' };
      if (typeof m.dir !== 'string' || !isAbsPath(m.dir)) return { error: 'switch needs an absolute dir' };
      return { type: 'switch', id: m.id, dir: m.dir };
    case 'restart':
      return { type: 'restart' };
    case 'takeover':
      return { type: 'takeover' };
    case 'activity':
      return { type: 'activity' };
    case 'task-stop':
      if (typeof m.id !== 'string' || !TASK_ID.test(m.id)) return { error: 'task-stop needs a task id' };
      return { type: 'task-stop', id: m.id };
    case 'task-background':
      if (typeof m.toolUseId !== 'string' || !TOOL_USE_ID.test(m.toolUseId)) return { error: 'task-background needs a tool-use id' };
      return { type: 'task-background', toolUseId: m.toolUseId };
    case 'shell-run':
      if (typeof m.id !== 'string' || !SHELL_ID.test(m.id)) return { error: 'shell-run needs a run id' };
      if (typeof m.cmd !== 'string' || m.cmd.trim() === '') return { error: 'shell-run needs a command' };
      if (new TextEncoder().encode(m.cmd).length > SHELL_CMD_MAX) return { error: `shell-run command is longer than ${SHELL_CMD_MAX} bytes` };
      return { type: 'shell-run', id: m.id, cmd: m.cmd };
    case 'shell-stop':
      if (typeof m.id !== 'string' || !SHELL_ID.test(m.id)) return { error: 'shell-stop needs a run id' };
      return { type: 'shell-stop', id: m.id };
    case 'idle-compact':
      if (typeof m.on !== 'boolean') return { error: 'idle-compact needs boolean on' };
      return { type: 'idle-compact', on: m.on };
    default:
      return { error: `unknown message type: ${String(m.type)}` };
  }
}

export type { AgentEvent, StopReason, WireAgentEvent } from './agent.ts';
export { FINISHED_CAP, orderedTasks, reduceTasks, shortModel, taskKind, type Task, type TaskKind, type TasksState, type TaskStatus } from './tasks.ts';
export { BATCH_HEAD, BATCH_HEADS, DEFAULT_THEME, isThemeId, isUiLang, isUiScale, THEME_KIND, THEMES, UI_LANGS, UI_SCALES, type ThemeId, type UiLang, type UiScale } from './lang.ts';
export type { GitSwitchAnswer, GitSwitched, GitSwitchError, GitSwitchRefusal, VcsBaseHow, VcsBranch, VcsCommit, VcsCommitDetail, VcsDiff, VcsFile, VcsLog, VcsNoRepo, VcsPatch, VcsRepoDiff } from './vcs.ts';
export { USAGE_PERIODS, type TokenCounts, type UsageAgentRow, type UsageCallRow, type UsageExtra, type UsageHit, type UsagePeriod, type UsageProvider, type UsageReport, type UsageRow, type UsageTank, type UsageTaskRow } from './usage.ts';

/** `GET /subagent` (protocol 7): a subagent's conversation as feed events, whether it still runs, and what the Agent call named it. */
export type SubagentView = { events: ServerEvent[]; running: boolean; type: string; description: string };

/** `GET /task-output` (protocol 8): the end of a shell / Monitor task's output (at most 8 KiB, may hold escape sequences), its size, and whether it still runs. */
export type TaskOutputView = { output: string; totalBytes: number; truncated: boolean; running: boolean };
export { fuzzyScore } from './fuzzy.ts';
export { PROMPT_MAX, PROMPT_SRCS, type PromptEntry, type PromptSrc } from './prompts.ts';
