# Home page: the frame, a project tree and an inbox that answers agents (issue 651)

Part of epic 383 (agents and swarms across projects). Follows issue 639, which made the server's top (`/`) its home page.

## Intent

The home page is where a swarm is run from. Today it is a bare project list outside the app's frame. It should look
like the rest of the app (header, project rail, tool strips, side panels, footer, the chosen theme) and show first
what the agents need from the person, so a waiting agent is unblocked without opening it.

Chosen from three HTML mockups (cards with an activity feed; an inbox; tabs with a composer): the inbox.

## Goals

- The home page keeps the app's frame: header, project rail, left and right tool strips with their panels, footer,
  theme, UI scale, settings. The header has no agent controls (model, restart); the rail's first tile is Home, shown
  on agent pages too, so the person can always get back.
- **Left panel: Projects.** A tree: project → its agents (provider mark, state dot, unseen count), then Recent. A click
  on an agent moves to it; on a Recent project, opens it. It is a panel of the left strip, so it can be closed.
- **Centre: Inbox**, one column, grouped by what the agent needs from the person, in this order:
  1. Waiting for you: the agent's open request in full (the command, the file, a question's fields).
  2. Done, unread: the last reply's text.
  3. Working: the title or last line.
  4. Idle.

  Each group shows its count. An empty group is hidden. With no agents at all, the inbox shows Open folder and
  New project.
- **An answer in place.** A request is answered in the inbox with the same choices the agent page offers: allow,
  allow always or for the session, deny, a question's fields. It is the same card as in the chat. After the answer,
  the item leaves Waiting on the next refresh.
- **Footer:** how many agents are working, waiting and idle.
- Every new string in all UI languages.

## Non-goals

- Sessions in the tree. An agent's other sessions are a later step; this needs a per-agent session list the home
  page cannot read today.
- A composer on the home page that starts an agent with a task (mockup C). Planned next.
- The agent bus in a panel (M8).
- Answering an agent of another server or another computer. Those rows show the request and "Open agent".
- The phone. It already lists waiting agents.

## Anti-goals

- The home page does not open an agent's socket. A socket makes the page a client of that agent and can take its
  window from the person's own tab (OneTab).
- No second permission path. An answer from the inbox goes through the same `SessionManager.answer` call as the
  chat's, and the audit log records it the same way.
- No agent plugin breaks on a page with no agent.

## Approaches considered

1. **An HTTP answer route on the agent, its request in `/info` (chosen).** `/a/<id>/info` carries the open request.
   The projects list passes it through. The page posts the answer to `/a/<id>/permission` on its own server. The list
   already polls every 3 s, so nothing new keeps the page up to date.
2. **The home page subscribes to each waiting agent's socket.** Live updates and the existing client message, but it
   is the OneTab conflict above, and one socket per agent.
3. **Only "Open agent".** The least work, but the inbox would only point at the problem, not solve it.

## Decisions

- **The open request in `/info`.** Each agent's `/info` gets `ask`: its oldest open request, as the chat's
  `permission` event carries it (`id`, `toolName`, `input`, `prompt`). The field is absent when nothing is open.
  `input` is the agent's own tool input, and `/info` already needs the agent's bearer. The projects row passes `ask`
  through for rows of this server only.
- **The answer route.** `POST /a/<id>/permission` (the window's own agent at `/permission`) takes
  `{ id, allow, response? }`, validated as the client message `permission` is. It calls the same `answer`, behind the
  same auth as the agent's other routes. An unknown or settled id is a 409; the page refreshes the list.
- **The frame on the home page.** The page renders the app's frame. A plugin part shows there only when it says it
  works without an agent: an explicit opt-in on the slot entry. Agent plugins stay off the home page by default, so
  none of them meets a store with no agent. The home page's own parts are:
  - the header's title (Nota Bene, with the count of open projects and agents);
  - the settings and stop buttons;
  - the rail;
  - the Projects panel;
  - the inbox;
  - the footer counts.
- **One card.** The chat's permission card takes how it answers as a prop. In the chat it sends the socket message,
  in the inbox it posts the route. The labels, fields and choices stay in one place.

## Left to the builder

- The exact names of the slot opt-in and of the inbox component.
- Whether Home on agent pages is the rail's first tile or an entry of the switcher: the rail tile is the mockup's.
- How a long command is clipped in the inbox. The card already caps its height.
- Tests: route (answer, wrong id, auth); `/info` and the projects row carry `ask`; inbox grouping and order; the
  card answers through the route; agent plugins absent on the home page.

Mockups: `.superpowers/design/dashboard-variants.html` (not committed), variant B.
