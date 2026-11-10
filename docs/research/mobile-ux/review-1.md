# Flow board review, round 1

Product decisions and comments from the first review of `flows.html` (2026-11-10). Each item names the screens it
touches, what the reviewer asked for, and the proposed change. Items marked *decided* are settled; the rest are
proposals awaiting agreement.

## Decided before the board

- **Comment by paragraph first** (7.1-7.4). A tap on a paragraph of a final reply makes it the target of a comment;
  selecting part of the text inside that paragraph is the secondary path. Splitting answers into several bubbles is
  not needed. Device testing showed the current selection drops from time to time.
- **"Quote" becomes Pin** (7.2). The fragment action that puts a passage above the composer is a pin, not a quote.
- **Push notifications later** (2.1). Postponed, not dropped; they come back after the chat work.

## Comments on the board

| # | Screens | Comment | Proposal |
|---|---|---|---|
| 1 | 2.1, 3.1 | The host name is the folder of the first (or one) project, which says nothing about the computer. Use the user name, or let the user rename it. | The host sends its computer name (`os.hostname()`, cleaned of `.local`) when it pairs; the phone uses it as the default label and offers Rename on the host row (long-press) and in Settings. A user name is the same on every machine, so it does not tell hosts apart. The current fallback (the fingerprint prefix) stays for hosts that send no name. |
| 2 | 2.1 | Pull down on the session list to refresh, with a loading state while it runs. | Pull-to-refresh reconnects every host link at once (skipping the backoff wait) and asks each online host for its windows again; the indicator stays until every host answered or timed out. A host that is still connecting shows a skeleton row instead of an empty group. |
| 3 | 4.1, 4.2 | Group tool lines the way the web does. | Port the web's `ToolGroup` (`web/src/feed/ToolGroup.tsx`): consecutive actions of the agent and its subagents fold into one line "▸ N actions", with "· N errors" and "· N comments" when present; while the turn runs and the group is last, the latest action shows under the head; tap opens every line, each still expandable to its output. |
| 4 | 4.1, 6.1 | "Working…" is the messenger's "typing…": put it next to the mode in the header pill, or redesign that line. Use the free space right of the header pill as the context indicator; a tap on it changes the agent's mode. | The pill's second line becomes the presence line: "working…" (animated, accent) while a turn runs, the mode otherwise; the status bar under the tabs goes away. Right of the pill, a 40 dp round context ring (percent inside, colour by level). A tap on the ring opens a small mode menu rather than cycling modes, because one stray tap must not switch to Auto or full access. |
| 5 | 7.2 | Selection drops from time to time; comment on a paragraph by default, by tapping it. | Same as the first decision above. Tap a paragraph: it gets a highlight and a compact action bar (Comment, Pin, quick label, Select text). Links, code blocks and diagrams keep their own taps; a tap on the highlighted paragraph again or outside it clears the target. |
| 6 | 7.1 | The quick-label emoji should be one expandable bubble above the menu, as in Telegram's reactions. | One rounded bubble with the five first labels and a chevron inside it; the chevron grows the same bubble into the full grid of eleven, with the label's name under each emoji (today the name is only a tooltip). |
| 7 | 6.1 | Composer icons must line up; the secondary ones are grey. | Stop, attach and the action button share one baseline and one 48 dp size; Stop and attach use the muted colour, only the action button (Send or mic) is filled. Stop moves away from Send (see 4 for the presence line) or gets a gap of at least 16 dp. |
| 8 | 13.1 | Same messenger principle for the header pill: connection state belongs there. | The presence line of item 4 also carries the connection: "connecting…", "offline · seen 4 min ago", "computer asleep", as a messenger shows "last seen". The status bar is removed in every state. |
| 9 | 13.3 | "The window closed or restarted; waiting for it to come back" can go to the centre. | Shown centred over the feed like the occupied overlay (13.2), with a spinner and, after 30 s, a Restart action; the feed stays visible but dimmed. |

## Agreed in round 2

Items 1, 2, 4 (mode menu on the ring instead of a cycle), 5, 6, 8 and 9 are agreed as proposed. Item 7 is agreed in
principle, to be checked on the drawn layout (variant A: Stop next to Send with a 16 dp gap; variant B: Stop at the left
edge). The proposed screens are sections 14-17 of `flows.html`, ids 14.1-17.2.

## Comments on the drawn proposals

| # | Screens | Comment | Change |
|---|---|---|---|
| 10 | 3.1 | Group the themes: dark first, then light. | Two headings, Dark themes and Light themes (17.3); the web picker gets the same order. |
| 11 | 14.x | Right of the pill, a short mode indicator instead of the context number. | The 40 dp button shows the mode's short name (Ask, Edit, Plan, Auto; Codex RO, WS, Full; omp Ask, Write, Plan, Yolo), red for modes without prompts. The context meter moves to the pill's second line when idle. |
| 12 | 14.4 | All context indicators would belong in the menu, but that duplicates the window sheet. | The menu holds modes only. Context, plan limits and Compact stay in the window sheet (5.1), opened by a tap on the pill. |
| 13 | 14.5 | The long composer placeholders are unwelcome. | The composer keeps “Message” in every state and accepts a draft; only Send greys out, since the header already says why. |
| 14 | 15.1 | 🔥 on tapping a paragraph. | Kept as drawn. |
| 15 | 15.4 | Pins go to the top of the chat, and the web needs them too. | Pin is a new cross-client feature: pinned passages sit in a bar under the tabs, as Telegram's pinned messages; tap jumps and steps to the next, ☰ lists them with Unpin. Pins are stored with the session on the host, so web and phones share them. Pin no longer puts a passage above the composer. |

## Round 3

| # | Screens | Comment | Change |
|---|---|---|---|
| 16 | 15.4 | Pins: open a feature request and skip for now. | Pins moved out of this round into their own issue (web and phone, stored with the session on the host). |
| 17 | 14.x | The mic belongs inside the message field. | Attach and mic sit inside the field. |
| 18 | 14.2, 14.3 | Typing hides attach and turns the mic into Send, also inside the field; Stop is a grey button above Send. | Drawn as said: Stop 44 dp, grey, 12 dp above the field's Send. Supersedes the A/B variants of item 7. |
| 19 | 15.5 | No selection of a fragment inside a paragraph; the agent understands from context; to quote words, Copy. | Paragraph is the only target; the action bar is Comment, Pin, Copy. 15.5 is removed. |
| 20 | 14.x | Put the mode under “Chat” in the tab pill and change it in the menu opened from the header pill. | The mode shows under “Chat”; the window sheet (14.4) lists modes first, then context, limits and tiles. The button right of the header pill is gone, superseding items 11 and 12. |

## Round 4

| # | Screens | Comment | Change |
|---|---|---|---|
| 21 | 14.x | Move the context into a circle right of the header pill; the pill's second line is the session state; a tap on the circle shows everything about the context. | A 40 dp context ring right of the pill (percent inside; accent from 70 %, red from 90 %). The second line says only what the session is doing (online, working, waiting for your answer, compacting, connecting, offline, computer asleep, waiting for the window). A tap on the ring opens a context sheet: context in tokens, 5-hour and weekly limits, session cost, idle compaction, Compact, Stats. The window sheet (tap on the pill) keeps model, modes, Clear and Restart. |
| 22 | design 1.1 | “Done in 2 min 14 s” under a reply repeats the pill. | The line goes; the pill's “online · done 12:04” says it. |
| 23 | design 1.1 | The ring needs no first-run hint; people learn it in use. | No onboarding for the ring. |

## Round 5

| # | Screens | Comment | Change |
|---|---|---|---|
| 24 | 2.1, 2.2 | Clear belongs with Compact and usage, not with the window's own controls. | Clear moves from the window sheet to the context sheet: Compact, Clear, Stats. Same confirmation, same conditions (off while the agent works, absent when the agent cannot). The window sheet keeps model, modes and Restart. |
| 25 | 4.1 | A list is one target; a person wants to comment on one item. | A tap on a list item targets that item (a nested item is its own target, a parent covers its nested items). Highlight, quote, Copy, comment badges and TalkBack actions work per item. |
| 26 | 1.2, 1.3 | The mic vanishes on an older computer and reads as a bug. | With nothing to send the mic stays, greyed; a tap says the computer's Nota Bene must be updated for voice messages. Send still appears once there is content. |
| 27 | 4.3 | A quick label shows on the paragraph already; the snackbar is noise. | No snackbar. The same label again on the same paragraph takes it back, as a reaction in a messenger does; a screen reader hears “label added” or “label removed”. The text of a label-only comment takes no tap of its own (a tap targets the paragraph); its badge opens it. Copy keeps its snackbar. |

The agreed design, without the history, is drawn in one board: `design.html`.

## Order of work this suggests

1. Header state line, context ring and the two sheets (items 4, 8, 20, 21), the message field (items 17, 18), the status bar removed and window-gone centred (item 9).
2. Comment by paragraph and the label bubble (items 5, 6, 19); Pin waits for its own issue.
3. Tool groups (item 3).
4. Host names, pull-to-refresh and grouped themes (items 1, 2, 10).
