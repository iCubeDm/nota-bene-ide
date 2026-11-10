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

## Order of work this suggests

1. Header presence line and context ring (items 4, 8), with the status bar removed and window-gone centred (item 9).
2. Comment by paragraph, Pin, the label bubble (items 5, 6 and the decisions).
3. Tool groups (item 3) and composer alignment (item 7).
4. Host names and pull-to-refresh (items 1, 2).
