# Flow board review, round 1

Product decisions and comments from the review of `flows.html` (2026-11-10), in five rounds. Items marked *decided* are settled; others were proposals, agreed as noted. The agreed design, without the history, is drawn in `design.html`.

## Decided before the board

- **Comment by paragraph first** (7.1-7.4). A tap on a paragraph of a final reply targets it for a comment; selecting part of the text inside is secondary. No splitting of answers into bubbles. Device testing showed the current selection drops from time to time.
- **"Quote" becomes Pin** (7.2): the fragment action that puts a passage above the composer is a pin.
- **Push notifications later** (2.1): postponed, not dropped; they return after the chat work.

## Round 1: comments on the board

| # | Screens | Comment | Proposal |
|---|---|---|---|
| 1 | 2.1, 3.1 | Host name is the first project's folder, says nothing about the computer | Host sends its computer name (`os.hostname()`, minus `.local`) at pairing; phone uses it as default label, Rename on host row (long-press) and in Settings. A user name is the same on every machine. Fingerprint prefix stays as fallback for hosts sending no name |
| 2 | 2.1 | Pull down to refresh the session list | Pull-to-refresh reconnects every host link (skipping backoff) and re-requests windows; indicator stays until every host answered or timed out. A connecting host shows a skeleton row |
| 3 | 4.1, 4.2 | Group tool lines as the web does | Port web `ToolGroup` (`web/src/feed/ToolGroup.tsx`): consecutive actions of the agent and subagents fold into "▸ N actions", plus "· N errors"/"· N comments"; while running and last, the latest action shows under the head; tap opens all lines, each expandable to output |
| 4 | 4.1, 6.1 | "Working…" is messenger "typing…": put it by the mode in the header pill; use free space right of the pill as context indicator, tap changes mode | Pill's second line becomes the presence line: "working…" (animated, accent) during a turn, else the mode; status bar under the tabs goes. Right of pill, 40 dp round context ring (percent inside, colour by level). Tap opens a small mode menu, not a cycle, so a stray tap cannot switch to Auto or full access |
| 5 | 7.2 | Selection drops; comment on a paragraph by tapping | Tap a paragraph: highlight and compact action bar (Comment, Pin, quick label, Select text). Links, code blocks, diagrams keep their own taps; tapping the paragraph again or outside clears the target |
| 6 | 7.1 | Quick-label emoji as one expandable bubble above the menu, like Telegram reactions | One rounded bubble with the five first labels and a chevron; chevron grows it into the full grid of eleven, with the label name under each emoji (today only a tooltip) |
| 7 | 6.1 | Composer icons must line up; secondary ones grey | Stop, attach, action button share one baseline and 48 dp size; Stop and attach muted, only the action button (Send/mic) filled. Stop moves away from Send or gets a gap of at least 16 dp |
| 8 | 13.1 | Connection state belongs in the header pill | Presence line also carries connection: "connecting…", "offline · seen 4 min ago", "computer asleep" (like "last seen"). Status bar removed in every state |
| 9 | 13.3 | "Window closed or restarted; waiting" to the centre | Centred over the feed like the occupied overlay (13.2), spinner, Restart action after 30 s; feed visible but dimmed |

## Agreed in round 2

Items 1, 2, 4 (mode menu on the ring, not a cycle), 5, 6, 8, 9 agreed as proposed. Item 7 agreed in principle, to check on the drawn layout (A: Stop next to Send with 16 dp gap; B: Stop at left edge). Proposed screens are sections 14-17 of `flows.html`, ids 14.1-17.2.

## Round 2: comments on the drawn proposals

| # | Screens | Comment | Change |
|---|---|---|---|
| 10 | 3.1 | Group themes: dark first, then light | Headings Dark themes / Light themes (17.3); web picker gets the same order |
| 11 | 14.x | Short mode indicator right of the pill instead of the context number | 40 dp button shows mode short name (Ask, Edit, Plan, Auto; Codex RO, WS, Full; omp Ask, Write, Plan, Yolo), red for modes without prompts; context meter moves to the pill's second line when idle |
| 12 | 14.4 | Context indicators in the menu duplicate the window sheet | Menu holds modes only; context, plan limits, Compact stay in the window sheet (5.1), opened by tapping the pill |
| 13 | 14.5 | Long composer placeholders unwelcome | Composer keeps "Message" in every state and accepts a draft; only Send greys out, the header says why |
| 14 | 15.1 | 🔥 on tapping a paragraph | Kept as drawn |
| 15 | 15.4 | Pins go to chat top; web needs them too | Pin is a cross-client feature: pinned passages in a bar under the tabs (as Telegram); tap jumps and steps to next, ☰ lists with Unpin; stored with the session on the host so web and phones share them. Pin no longer puts a passage above the composer |

## Round 3

| # | Screens | Comment | Change |
|---|---|---|---|
| 16 | 15.4 | Pins: open a feature request, skip for now | Pins moved to their own issue (web and phone, stored with session on host) |
| 17 | 14.x | Mic belongs inside the message field | Attach and mic sit inside the field |
| 18 | 14.2, 14.3 | Typing hides attach and turns mic into Send inside the field; Stop is a grey button above Send | Stop 44 dp, grey, 12 dp above Send. Supersedes A/B of item 7 |
| 19 | 15.5 | No fragment selection inside a paragraph; the agent understands from context; to quote words, Copy | Paragraph is the only target; action bar is Comment, Pin, Copy. 15.5 removed |
| 20 | 14.x | Mode under "Chat" in the tab pill, changed in the menu from the header pill | Mode shows under "Chat"; window sheet (14.4) lists modes, then context, limits, tiles. Button right of pill gone; supersedes 11 and 12 |

## Round 4

| # | Screens | Comment | Change |
|---|---|---|---|
| 21 | 14.x | Context in a circle right of the pill; pill's second line is session state; tap on circle shows all context | 40 dp context ring (percent inside; accent from 70 %, red from 90 %). Second line says only what the session is doing (online, working, waiting for your answer, compacting, connecting, offline, computer asleep, waiting for the window). Ring tap opens a context sheet: tokens, 5-hour and weekly limits, session cost, idle compaction, Compact, Stats. Window sheet (pill tap) keeps model, modes, Clear, Restart |
| 22 | design 1.1 | "Done in 2 min 14 s" repeats the pill | Line removed; pill's "online · done 12:04" says it |
| 23 | design 1.1 | Ring needs no first-run hint | No onboarding for the ring |

## Round 5

| # | Screens | Comment | Change |
|---|---|---|---|
| 24 | 2.1, 2.2 | Clear belongs with Compact and usage | Clear moves to the context sheet: Compact, Clear, Stats; same confirmation and conditions (off while agent works, absent when agent cannot). Window sheet keeps model, modes, Restart |
| 25 | 4.1 | A list is one target; people comment on one item | Tap on a list item targets it (nested item is its own target, parent covers nested items). Highlight, quote, Copy, badges, TalkBack actions work per item |
| 26 | 1.2, 1.3 | Mic vanishes on an older computer, reads as a bug | Mic stays greyed with nothing to send; tap says the computer's Nota Bene must be updated for voice. Send still appears once there is content |
| 27 | 4.3 | Quick label already shows on the paragraph; snackbar is noise | No snackbar. Same label again on the same paragraph removes it, like a messenger reaction; screen reader says "label added"/"label removed". A label-only comment's text takes no tap (tap targets the paragraph); its badge opens it. Copy keeps its snackbar |
| 28 | 1.2, 1.3 | Paperclip and mic crooked in the tall field; mic hugs the border | On one line the field equals action button height plus even inset (top, right, bottom); paperclip centred on the same axis, 8 dp from the button; as the field grows they stay on the bottom line |

## Order of work

1. Header state line, context ring and two sheets (4, 8, 20, 21), message field (17, 18), status bar removed, window-gone centred (9).
2. Comment by paragraph and label bubble (5, 6, 19); Pin waits for its own issue.
3. Tool groups (3).
4. Host names, pull-to-refresh, grouped themes (1, 2, 10).
