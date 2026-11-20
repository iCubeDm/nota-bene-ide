# Desktop client over the relay (issue 297)

## Intent

One person, two computers: from laptop A, work in Nota Bene on laptop B as if its projects were local. Today only the
phone reaches another computer (relay, pairing, end-to-end channel). No teams, no shared hosts, no guest roles: a paired
computer is fully trusted by B, exactly like a paired phone.

## Goals

- A's project switcher (header menu) and project rail list B's running windows next to A's own, marked as remote
  (an icon badge, plus the computer's name in the row).
- Choosing one opens it in the same tab with the full UI (chat, files, editor, comments, video, voice, shell), as a local
  project opens; the switcher inside it still switches to A's projects and B's.
- Pairing and revoking as for the phone: B shows a code in its Remote tab, A pastes it; B lists A among its devices and
  can revoke it at once.
- Traffic stays end-to-end encrypted; the relay sees only ciphertext.
- A works as a pure client: no relay or access key of its own needed.

## Non-goals and anti-goals

- No browser-only client and no Flutter desktop build (see Approaches).
- No starting, creating or stopping B's projects from A in this step (the channel refuses `/system/projects`,
  `/system/folders`, `/system/agents`); A sees and uses what runs on B.
- No `/os` actions (Show in Finder) on B from A, as for the phone.
- No uploads over 32 MiB to B in this step (the channel buffers a request body, `MAX_BODY`); the user gets a clear
  message. Chunked uploads are a later step that also serves the phone.
- No change to the one-tab rule: opening B's project from A takes it over from B's tab and the phone ("Work here" takes
  it back), as today. Live sync of several tabs is issue 174.
- Anti-goal: B's page code obtaining credentials for A's own windows (A's shell and files). A trusts B's pages with B's
  projects only.

## Approaches

- **A. A's own `nota-bene` is a device (chosen).** A's connector pairs with B like a phone, keeps the channel and exposes
  each remote window on a local loopback listener as a proxy. The page and B's routes come from B over the channel, so
  the page always matches B's server. Reuses the TypeScript channel (`noise.ts`, `mux.ts`, relay admission) and the
  device side now used only by tests (`testPhone.ts`).
- B. Flutter desktop build of the phone app: reduced UI, another platform to maintain.
- C. Browser straight to the relay with crypto in JavaScript: no install, but whoever serves the page can read the traffic.

## Design

### Pairing (A as a device)

- B: Remote tab, **Pair a device** (today's "Pair a phone", renamed; same code as QR and text with Copy, same 5 minutes,
  same fingerprint).
- A: Remote tab, **Connect to a computer**: paste the code (`nbremote://pair?…`). A's connector runs the handshake as a
  device (Noise IK, pairing proof, A's computer name in message 1) with its own device key (`device.key`, beside
  `host.key`, `0600`) and saves the host (relay URL, host id, host static key, name).
- A's Remote tab lists paired computers with state (online, connecting, failing, revoked) and **Forget**.
- The device side lives in A's single connector (the relay keeps one live connection per host and device). A keeps a
  connector running while a relay is saved and access is on, or while at least one computer is paired.
- A computer counts against B's device limit (32), shared with phones.
- `/system/remote` (below) is added to the channel's refused paths, so a phone or a paired computer cannot open proxies
  on B.

### B's projects in A's switcher and rail

- The switcher and rail read `GET /system/projects` from A's window. A's window asks its connector (a new control op)
  for each paired computer's last `windows` list and merges them as rows with `remote: {host, name}`, the state mapped
  from `busy`/`pending`. Row ids are host-qualified (ports collide between A and B). An offline computer's rows
  disappear.
- Choosing a remote row: `POST /system/remote/open {host, port}` on A's window (key tier, as the switcher's other routes)
  asks the connector for a listener and returns its URL with a login; the tab navigates there.

### The proxy listener

- One loopback listener per opened remote window, on a port outside the window range (launcher `--scan` and window
  proving never meet it), on host name **`localhost`**, while A's own windows stay on `127.0.0.1`: cookies are scoped by
  host, not port, so B's pages and A's windows never share cookies, and they are different sites for `SameSite`.
- The proxy runs its own auth, as a window does: it answers `POST /auth` and the login itself (its own token, cookie and
  key), checks the key header, the `nb.<key>` WebSocket subprotocol and the Origin, and strips them. B sees only the
  helper bearer the channel adds.
- Everything else becomes an `http` stream (HTTP) or a `ws` stream (`/ws`) to that port on B.
- The proxy answers itself, never forwarding:
  - `GET /system/remote/page` → `{host, name}`: the page asks it at start; a page that gets it is remote (this replaces
    the hostname test of `isLocalPage()` in every relay-aware branch: Show in Finder, the 32 MiB check on attachments,
    Open folder…, New project…, Remote access are hidden or checked).
  - `GET /system/projects`: A's merged list (fetched by the connector from A's window), so the switcher inside a remote
    page lists both computers.
  - Switching from a remote page goes by top-level navigation to a proxy route that redirects: to another listener's
    login for a remote row, or to A's own window for a local row. Page code never sees a credential for A's windows
    (builder: verify the redirect, including fragments, is unreadable to `fetch`; else make local rows plain links to
    A's window that log in through A's own page).
  - Other refused paths (`/system/folders`, `/system/agents`, `/os`, `/remote`, `/control`) answer 403.
- A listener closes a minute after its last socket closed; the connector stays up while any listener has a tab.
- All of A's tabs on one computer share one channel (64 streams, 512 KiB window): fine for one person, noted.

## Phasing

1. Device side in production code (from `testPhone.ts`), A's device key, pairing from A's Remote tab, paired-computer
   list, connector kept while a computer is paired, "Pair a device" rename. Tested end to end against the test relay
   with two temporary homes.
2. Remote rows in the switcher and rail; the proxy listener with its auth; `/system/remote/*`; the remote-page flag and
   its UI branches; i18n in all languages; guide section; protocol bump.

## Risks and what would change the plan

- Issue 383 phase 2 (one server, agents under `/a/<id>`) changes window addressing: listeners per remote window become
  one per remote computer with the agent path. Contained in the proxy and the row.
- A listener port reused later for another window keeps origin-scoped storage (`nb.updated.<port>`): use a fresh port per
  open, not a reused one.
- Both computers need this version (the remote-page flag comes from the proxy, the page from B).

## Left to the builder

Port range for listeners; the badge icon; wording; reconnect timings (the phone's); the control op's shape; test layout.
