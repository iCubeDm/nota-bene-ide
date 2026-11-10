# Mobile UX for code, files, diffs and remote coding-agent sessions (state as of Nov 2026)

## 1. How code, diffs and PR review are presented on phones (GitHub Mobile and others)

### Takeaway
GitHub Mobile's review UX is the baseline: a "jump to file" control, a line-wrap toggle, long-press multi-line selection for comments, and (Feb 2026) comments on unchanged lines. The newer entrants (Cursor iOS, Linear) go further toward "summary first, then file by file" and deliberately omit editors and file browsers. Coverage of GitLab, Bitbucket, Gitea clients, vscode.dev and Codespaces on phones was not found (see Gaps).

### Cited Findings
- GitHub Mobile code review (Oct 2020, updated May 2021): a "Jump To" icon moves between files in large reviews. A toggle turns off line wrapping, which GitHub called the community's top request. Long-press enters multi-select for commenting on a line range. — [GitHub blog](https://github.blog/news-insights/product-news/even-better-code-review-in-github-for-mobile/)
- GitHub's own article acknowledges that reading code on a phone is painful when lines keep wrapping (search-result paraphrase; the fetched page confirms the wrap toggle) — [GitHub blog](https://github.blog/news-insights/product-news/even-better-code-review-in-github-for-mobile/)
- 3 Feb 2026: GitHub Mobile (iOS and Android) lets you expand a diff to reveal unchanged lines and comment or suggest edits on them. Comments made that way on github.com show up in the app. Previously comments were limited to lines near a change. — [GitHub changelog](https://github.blog/changelog/2026-02-03-github-mobile-comment-on-unchanged-lines-in-pull-request-files)
- GitHub Mobile text sizing: a July 2024 changelog says monospace text now scales with font settings. An iOS v1.102.0 regression made code oversized after a Dynamic Type change, and a user found an "Override System Font Size" setting in the diff view. A Feb 2025 changelog lists improved line wrapping in the Code view. — [Jul 2024 changelog](https://github.blog/changelog/2024-07-08-whats-new-in-mobile-june-update), [community thread](https://www.Github.com/orgs/community/discussions/48916), [Feb 2025 changelog](https://github.blog/changelog/2025-02-28-mobile-monthly-februarys-general-availability-and-more/)
- GitHub Mobile has syntax highlighting for popular languages (2020 GA coverage), and added Haskell highlighting in 2024. — [The Register](https://www.theregister.com/2020/03/18/github_mobile_app_ga/)
- Known GitHub Mobile bug report: scrolling to the end of a diff sends the user back to the previous screen. — [GitHub community #122068](https://www.Github.com/orgs/community/discussions/122068)
- Linear mobile "Diffs": "Guided Reviews" split a PR into sections starting with what the change does and why, so a large PR can be reviewed "one section at a time" on a phone. Reviewers can reply to threads and send a fix back to a coding agent from the same screen. Viewed-file state syncs between phone and desktop. Preview links open from the diff. (30 Jul 2026 changelog: "coding sessions on mobile".) — [Linear](https://linear.app/now/mobile-diffs), [Linear changelog](https://linear.app/changelog/2026-07-30-coding-sessions-on-mobile)
- Cursor for iOS: shows changed files in a diff view (full-file diffs and commits). iPad shows diffs at full width. There is deliberately no editor, terminal or file browser. PR actions: comments, approvals, checks, request an agent to resolve review comments or fix a failing check, squash-merge, mark ready, update branch, auto-merge. — [Cursor docs](https://cursor.com/docs/cloud-agents/mobile)
- Working Copy (iOS): diff viewer for text and images plus a hex-dump mode; editor supports 50+ languages with per-file-type theme memory (from App Store listing; highlighting in diffs not confirmed). — [App Store](https://apps.apple.com/us/app/896694807)
- Vendor guidance (Happier, marketing source): summary and changed-file list first, then Review; collapse each file once done; treat phone review as a first pass and use a laptop or second agent for high-risk changes. Doesn't discuss unified vs split. — [Happier guide](https://guides.happier.dev/how-to-review-diffs-from-your-phone)
- Pitfalls named by several (mostly vendor) writers: the GitHub app can't run tests or see uncommitted local changes, and phone review invites rushed approvals. — [Cosyra](https://cosyra.com/guides/review-pull-requests-from-phone.html), [Grass](https://codeongrass.com/blog/review-agent-code-changes-phone/), [Hyrax](https://hyrax.dev/blog/cursor-iphone-mobile-code-review-risk)
- Gitea client GitNex: pinch-to-zoom for images (not code). — [GitNex issue](https://codeberg.org/gitnex/GitNex/issues/1534)

### Inferences
- Pattern consensus: file list/jump control, wrap toggle (wrap default, horizontal scroll opt-in), range selection by long-press, collapse/viewed state. Summary-first ordering and "viewed" sync are the newest ideas.
- Leaving out editor/terminal/file browser (Cursor, Codex) is an explicit design stance: the phone is for oversight. A companion with a file tree and viewers is broader than those.
- Unified (single column) diff is the only practical layout on a phone; none of the sources describes a split diff on phone widths, and tablets (Cursor iPad) get full width.

### Gaps
- No sourced facts on GitLab mobile/web, Bitbucket, Forgejo/Gitea clients' diff layout, vscode.dev/Codespaces on phones, minimap, or pinch-zoom of code in GitHub Mobile.
- No hard user-satisfaction data for GitHub Mobile's diff view beyond anecdotes.

## 2. Remote and mobile AI coding-agent supervision

### Takeaway
By Nov 2026 every major agent has a phone surface built around the same loop: a session list, a streaming chat, push notification when the agent finishes or needs input, approve/deny, and steering by follow-up. Two architectures exist: cloud sessions (keep running with the phone away) and relayed control of a session on the user's own computer (Claude Remote Control, Codex via ChatGPT app, Cursor Remote Control).

### Cited Findings
**Claude Code**
- No separate app: the Claude iOS/Android app has a Code tab showing cloud sessions, projects, Remote Control sessions on your machine, and Dispatch tasks to Desktop. `/mobile` (also `/ios`, `/android`) shows a QR code to install the app. — [Claude Code docs](https://code.claude.com/docs/en/mobile)
- Remote Control: execution and filesystem stay local; start with `claude remote-control` or `/remote-control`, scan QR or pick from the Code tab; reconnects after the machine sleeps; photos attach and are saved under `~/.claude/uploads/`. — [Claude Code docs](https://code.claude.com/docs/en/mobile)
- Push notifications when a long task finishes or a decision is needed, plus "notify me when X" in a prompt. — [Claude Code docs](https://code.claude.com/docs/en/mobile)
- Limits: terminal-only commands (`/plugin`, `/resume`) don't work; permission modes on mobile are Manual, Accept edits, Plan, Auto (cloud: no Manual); Bypass is not selectable from the app. — [Claude Code docs](https://code.claude.com/docs/en/mobile)
- Sessions persist across devices; Claude can watch a PR and fix CI failures/review comments. — [Claude Code docs](https://code.claude.com/docs/en/mobile)
- Teleport (`claude --teleport`, `/teleport`) pulls a cloud session into the terminal; requirements (clean git state, same account) come only from third-party posts. — [codeongrass](https://codeongrass.com/blog/claude-code-teleport-hand-off-phone/)
- Criticism: a GitHub issue reports Remote Control iOS permission prompts show only about the first 100 characters of a command (approve blind or deny). Other issues request actionable Approve/Deny in the push notification with default-deny on timeout, and say prompts don't propagate to remote sessions. Issue status unverified (site not fetchable). — [issue 37235](https://claudeissues.com/issue/37235-feature-remote-control-allow-expanding-permission-prompts-on-ios-to-see-the-full), [issue 62458](https://claudeissues.com/issue/62458-feature-request-actionable-approve-deny-on-mobile-push-for-permission-prompts), [issue 38061](https://claudeissues.com/issue/38061-permission-prompts-dont-propagate-to-remote-mobile-sessions) (search snippets only)
- A blogger argues the phone bottleneck is permission prompts, not screen size. — [mejba.me](https://www.mejba.me/blog/claude-code-remote-control-phone)

**Codex (ChatGPT app)**
- Preview launched 14 May 2026 on iOS/Android; phone connects to the Codex desktop app on macOS (Windows "coming soon"). — [Android Authority](https://www.androidauthority.com/codex-smartphone-control-3665256/), [Daniel Vaughan](https://codex.danielvaughan.com/2026/05/15/codex-mobile-chatgpt-app-relay-architecture-remote-agent-control/)
- Shows threads with full history, steering, approvals with desktop gates, syntax-highlighted diffs, test results, screenshots; `/model` and `/effort`; push for approval gates; host picker for multiple hosts. No direct file edit or shell; plugins/MCP/config desktop-only. — [Daniel Vaughan](https://codex.danielvaughan.com/2026/05/15/codex-mobile-chatgpt-app-relay-architecture-remote-agent-control/) (third-party analysis, not OpenAI docs)
- Relay is OpenAI-operated; QR pairing carries the host Ed25519 key; X25519 handshake; AES-256-GCM session traffic; relay can't read prompts/diffs/approvals; revoke requires re-pairing. — same source
- Reports differ on exact launch details; verify against OpenAI docs. — [letsdatascience](https://letsdatascience.com/news/openai-adds-codex-remote-control-to-chatgpt-mobile-18bf45b0)

**GitHub Copilot**
- Coding agent in GitHub Mobile since Jun 2025 (assign issues). — [changelog](https://github.blog/changelog/2025-06-03-github-copilot-coding-agent-now-available-on-github-mobile)
- 26 Feb 2026: Live Notifications track agent progress; 8 Jul 2026 extended to Copilot CLI sessions. — [changelog](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications), [changelog](https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions)
- 8 Apr 2026: research the codebase, plan, review the diff of a branch, iterate, then open a PR from the phone. — [changelog](https://github.blog/changelog/2026-04-08-github-mobile-research-and-code-with-copilot-cloud-agent-anywhere)
- Jul 2026: "Fix with Copilot" on merge conflicts, review comments, failing Actions checks. — [Jul 8](https://github.blog/changelog/2026-07-08-github-mobile-fix-merge-conflicts-with-copilot-cloud-agent), [Jul 17](https://github.blog/changelog/2026-07-17-github-mobile-fix-pull-request-comments-with-copilot-cloud-agent), [Jul 23](https://github.blog/changelog/2026-07-23-github-mobile-fix-failing-actions-checks-with-copilot-cloud-agent)

**Cursor**
- iOS native app (beta, iOS 26+; Android not available, PWA workaround). Inbox of all agents from any surface; iPad sidebar; streaming chat with follow-ups and subagent transcript cards; push on turn end; Live Activities/Dynamic Island for up to 8 agents; cache-first. Remote Control needs desktop 3.9.8+ with the computer awake. Editor, terminal, file browser, MCP management are web-only. — [Cursor docs](https://cursor.com/docs/cloud-agents/mobile)

**Others**
- Replit: mobile app has Agent, editor, publishing; notifications when Agent needs help or is done. A forum user says Plan/Build states are hard to tell apart on iOS and plan approval is only passively signalled. — [Replit docs](https://docs.replit.com/platforms/mobile-app), [forum](https://replit.discourse.group/t/plan-vs-build-in-the-new-replit-ui/10062)
- Devin: release notes (2026.10.07) mention a notification inbox with per-type push choice; an iPhone app beta is reported only by an aggregator. — [Havoptic](https://www.havoptic.com/r/devin-2026-10-07), [hermes-ai](https://hermes-ai.net/news/cognition-brings-devin-mobile-to-iphone-so-developers-code-on-the-go/)
- Third-party apps exist for approval from phone (Happier, Tactic Remote, Moshi, Grass); all vendor sources. — [Tactic Remote](https://tacticremote.com/blog/2026-02-28-best-ios-apps-for-remote-ai-coding-agents)

### Inferences
- Table stakes: notification on done/needs-input, approve/deny with full action visible, follow-up steering, session inbox across devices.
- Reported failure mode to avoid: truncated command in approval prompt; approval from the notification itself is wanted.
- Companion apps omit config/plugin management; relay with end-to-end encryption and QR pairing is the emerging norm.
- A local-first companion (like the user's) maps to Remote Control / Codex relay, not the cloud-session model.

### Gaps
- Jules and Warp mobile: nothing found. Devin app details unverified against Cognition docs.
- Claude's `claude.ai/code` mobile diff and tool-call rendering not described in docs fetched; no screenshots/UX details of tool-call cards or todo lists in any app.
- Multi-session UX beyond Cursor inbox/Live Activities not detailed.

## 3. Terminal/SSH apps (Termius, Blink, JuiceSSH)

### Takeaway
Little first-party evidence; terminals are generic and not agent-aware, which is why agent-specific clients emerged.

### Cited Findings
- Blink and Termius auto-reconnect; Blink has stronger mosh support (sources conflict on whether Termius supports mosh). Neither is agent-aware, and Termius has no push notifications. — [Moshi comparison (vendor)](https://getmoshi.app/compare/termius), [Cosyra](https://cosyra.com/guides/ssh-from-phone.html)

### Inferences
- Reason agent apps abandon raw terminals: long output and approval prompts are buried in scrollback; structured events fix this.

### Gaps
- Extra-key rows, long-output handling, JuiceSSH: no sourced detail found.

## 4. Criticisms and mitigations

### Takeaway
Pain: wrapped long lines, small screens, no execution/tests, rushed approvals, truncated approval prompts. Mitigations: wrap toggle, jump-to-file, summary-first, collapse/viewed, agent-assisted "fix this" actions, automated review before human review.

### Cited Findings
- Writers advise phone review for triage and small diffs only, reviewing intent rather than hunting bugs. — [Grass](https://codeongrass.com/blog/review-agent-code-changes-phone/), [Junction](https://junctionpanel.dev/blog/review-ai-agent-diffs-from-your-phone/)
- Argument that automated review should run first (not in parallel) before human mobile review; a Cursor forum request asks for risk-ranked diffs, with no evidence it exists. — [Hyrax, 30 Jun 2026](https://hyrax.dev/blog/cursor-iphone-mobile-code-review-risk), [Cursor forum](https://forum.cursor.com/t/mobile-code-review-for-cursor-changes/166889)
- Most criticism sources are competing-product marketing; GitHub-specific complaints are anecdotal. — see above

### Inferences
- Design implication for the user's app: provide change summary and risk ordering, show the full command in permission prompts, make wrap toggle and file jump first-class, and persist viewed state.

### Gaps
- No systematic user survey; Reddit threads were only visible as snippets via mirrors.
