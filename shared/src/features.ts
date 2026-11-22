/**
 * What a server understands beyond the base protocol, by name: each entry is the protocol that added it, announced in
 * `hello` on connect. Every window serves the one shared `web/dist`, so a reloaded page can be newer than its server
 * (until "Restart the server"): a client sends a newer message only to a server that announced it, `has(protocol, name)`,
 * and never compares protocol numbers itself. A protocol that added several gated things has several names with one
 * number. A protocol change adds an entry here and raises `PROTOCOL` (`protocol.ts`) to it.
 */
export const FEATURES = {
  /** `activity` and `idle-compact` */
  activity: 1,
  /** `mode` ids answered with `ack` */
  modeAck: 2,
  /** the `fire` quick label */
  fireLabel: 3,
  /** media anchors and `/marks` */
  mediaAnchors: 4,
  /**
   * the agent's output as `agent` events (AgentEvent) instead of raw SDK frames; `replay.earlier`; one tab per window
   * (`occupied`, `taken-over`, the client's `takeover`, close code 4001, `?tab=` and `?passive=1` on the ws url);
   * `hello.capabilities`
   */
  agentEvents: 5,
  /** the model and effort switch: the client's `model` (ids answered with `ack`), the server's `model` and `models` events, `capabilities.models` */
  models: 6,
  /** a message anchor may name a subagent (`source.agent`, the Agent call's tool-use id) and `GET /subagent` serves its conversation */
  subagentAnchors: 7,
  /** the client's `task-stop` and `task-background`, and `GET /task-output` (a shell task's output tail) */
  taskControl: 8,
  /** a media anchor may carry a `camera` (a comment on a 3D model view; the viewer was removed in 2.1.0, issue 470: a stored `camera` is ignored and dropped when the comment is next written) */
  camera: 9,
  /** the server's `commands` event (the slash menu's list); an older server sends none, so the menu stays closed */
  commands: 10,
  /**
   * `! cmd` in the composer: the client's `shell-run` and `shell-stop`, the server's `shell-start`, `shell-out` and
   * `shell-end` events. An older server would send `! cmd` to the agent, so the page runs it as a shell command only from 11.
   */
  shellRun: 11,
  /** provider modes/descriptors, structured interaction answers and variable-duration usage windows */
  providerModes: 12,
  /** page anchors (a comment on an element or an SVG area of an HTML page); an older server would refuse the comment */
  pageAnchors: 13,
  /** voice messages (`send.voice` and `send.lang`, `user.voice`, the `voice-text` event, `/voice`) and voice clips of comments (`Comment.voice`) */
  voice: 14,
  /**
   * the project icon: the project folder's picture (`/project-icon`, set from the phone; `/info.icon` is its version or
   * null). (Other additions to protocol 15, such as optional Interaction fields and the `task` event's optional `model`,
   * are listed beside them by their own changes.)
   */
  projectIcon: 15,
  /** a voice `send` may carry `commentIds` with their batch `text` and `images` (the pending comments ride along with a recording) */
  voiceComments: 16,
  /** attachment anchors (marks on an image attached to the unsent message) and the `detached` send refusal */
  attachmentAnchors: 17,
  /**
   * spoken-language detection: `send.detect` (a voice send asks the server to detect the language; `lang` is then the
   * hint), `voice-text.lang`, `user.voiceLang` (the language a replayed voice message was transcribed in) and
   * `hello.dictationLang` (the host's dictation language, `auto` or a code)
   */
  voiceDetect: 18,
  /**
   * comment ops: the client's `comment-op` (add / edit / remove, idempotent) answered by `comments.ack` or, for a session
   * the window does not show, `comment-ack`, or by `comment-refused`; `comments.rev`. An older server gets whole sets
   * (`comments`) as before.
   */
  commentOps: 19,
  /**
   * remote access from the window: the server's `remote` (the connector's state) and `remote-pair` events and the
   * `/remote` routes; an older server has neither, so the page shows no indicator and no Remote tab
   */
  remote: 20,
  /** relay access keys: `RemoteState.accessKey` (one is saved) and `POST /remote/config {accessKey}`; `lastError` may be a 4405 (the key's computer limit) while the connector retries */
  accessKeys: 21,
  /**
   * a server restart that waits for the agent (gh-422): the server's `restart-pending` event (on attach and when it
   * changes) and `resumed.cut` (the resume after a restart that cut a turn); `POST /restart-server {now}`,
   * `/restart-server/pause`, `/restart-server/cancel`, `/info.restartPending`. An older server restarts at once and sends
   * neither.
   */
  restartPending: 22,
  /**
   * cut anchors (a comment on a clip or a moment of a video edit's timeline, issue 430); an `edit` op of a pending cut
   * comment also takes its anchor when it is a cut anchor on the same file (the comment follows its clip). An older
   * server would refuse the comment.
   */
  cutAnchors: 23,
  /**
   * polygon media shapes (`MediaShape` kind `polygon`, issue 447) and `mask.png` beside a media comment's frame
   * (`/marks`). An older server would refuse the comment, so the page offers the Mask tool only from 24.
   */
  polygons: 24,
  /**
   * a media anchor may have no shapes (a comment on the whole picture, issue 494), and a `comment-op` that does not parse
   * is answered `comment-refused` `invalid`. An older server would refuse such a comment and answer nothing, so the phone
   * offers it only from 25.
   */
  wholePicture: 25,
  /** a comment's text may be empty when it has images (issue 497): pasted images or a drawing alone. An older server would refuse it, so the page and the phone offer it only from 26. */
  imagesAlone: 26,
  /**
   * a compaction ordered while the agent works waits for the next pause (issue 499): the client's `command` compact (or a
   * typed `/compact`) is then the pending compaction, `compact-cancel` drops it; the server's `compact-pending` event (on
   * attach and when it changes)
   */
  compactOrder: 27,
  /**
   * `send-held`: a page that says `held=1` on the ws url has its sends held behind a pending restart or compaction
   * (issue 499); an older one is refused and handed over as before
   */
  heldSends: 27,
  /**
   * this computer as a device of another (issue 297): `RemoteState.hosts` (the paired computers and their link) and
   * `POST /remote/connect {code}`, `/remote/forget {id}`. An older server has neither, so the page offers no Connect to
   * a computer.
   */
  remoteHosts: 28,
  /**
   * another computer's projects in this one's switcher (issue 297): `GET /system/projects` rows may carry `remote: {host,
   * name}`, `POST /system/remote/open {host, port}` opens a desktop proxy for one, and `GET /system/remote/page` is
   * `{host, name}` on a page the proxy serves (a window has no such route); the channel's `public` stream. Both computers
   * need it: the flag comes from the proxy, the page from the other computer.
   */
  remoteProjects: 29,
  /**
   * `open-agent` (epic 383): a page that says `go=1` on the ws url follows the launcher; the server sends that event to the
   * last such page attached when `/control/open` opens an agent no such page shows. A server of an older protocol never sends it
   */
  openAgent: 30,
} as const;

export type Feature = keyof typeof FEATURES;

/** Whether a peer that announced `protocol` (none: an unknown or pre-protocol peer) understands `f`. */
export const has = (protocol: number | null | undefined, f: Feature): boolean => (protocol ?? 0) >= FEATURES[f];
