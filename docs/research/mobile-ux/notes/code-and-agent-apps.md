# Mobile UX for code, files, diffs and remote coding-agent sessions (state as of Nov 2026)

## 1. How code, diffs and PR review are presented on phones

**Takeaway.** GitHub Mobile's review UX is the baseline: "jump to file", a line-wrap toggle, long-press multi-line selection for comments, and (Feb 2026) comments on unchanged lines. Newer entrants (Cursor iOS, Linear) go "summary first, then file by file" and deliberately omit editors and file browsers.

**Findings**
- GitHub Mobile review (Oct 2020, updated May 2021): "Jump To" moves between files; a toggle turns off line wrapping (the community's top request); long press enters multi-select to comment on a line range ([GitHub](https://github.blog/news-insights/product-news/even-better-code-review-in-github-for-mobile/)).
- 3 Feb 2026: expand a diff to reveal unchanged lines and comment or suggest edits on them; previously limited to lines near a change ([changelog](https://github.blog/changelog/2026-02-03-github-mobile-comment-on-unchanged-lines-in-pull-request-files)).
- Text sizing: Jul 2024 monospace scales with font settings; an iOS v1.102.0 regression made code oversized after a Dynamic Type change, and users found an "Override System Font Size" setting in the diff view; Feb 2025 improved wrapping in Code view ([Jul 2024](https://github.blog/changelog/2024-07-08-whats-new-in-mobile-june-update), [thread](https://www.Github.com/orgs/community/discussions/48916), [Feb 2025](https://github.blog/changelog/2025-02-28-mobile-monthly-februarys-general-availability-and-more/)). Syntax highlighting since 2020, Haskell added 2024 ([Register](https://www.theregister.com/2020/03/18/github_mobile_app_ga/)). Bug report: scrolling to the end of a diff returns to the previous screen ([#122068](https://www.Github.com/orgs/community/discussions/122068)).
- Linear mobile "Diffs": "Guided Reviews" split a PR into sections starting with what and why, reviewed "one section at a time"; reply to threads and send a fix to a coding agent from the same screen; viewed state syncs phone/desktop; preview links open from the diff ([Linear](https://linear.app/now/mobile-diffs), [changelog](https://linear.app/changelog/2026-07-30-coding-sessions-on-mobile)).
- Cursor iOS: diff view of changed files (full-file diffs, commits), full width on iPad; deliberately no editor, terminal or file browser. PR actions: comments, approvals, checks, ask an agent to resolve comments or fix a failing check, squash-merge, mark ready, update branch, auto-merge ([Cursor](https://cursor.com/docs/cloud-agents/mobile)).
- Working Copy (iOS): diff viewer for text and images plus hex-dump mode; editor for 50+ languages (App Store listing; diff highlighting unconfirmed) ([App Store](https://apps.apple.com/us/app/896694807)). GitNex (Gitea): pinch-zoom for images only ([issue](https://codeberg.org/gitnex/GitNex/issues/1534)).
- Vendor writers (marketing): summary and file list first, collapse each file once done, treat phone review as a first pass ([Happier](https://guides.happier.dev/how-to-review-diffs-from-your-phone)). Pitfalls named: the GitHub app cannot run tests or see uncommitted local changes; phone review invites rushed approvals ([Cosyra](https://cosyra.com/guides/review-pull-requests-from-phone.html), [Grass](https://codeongrass.com/blog/review-agent-code-changes-phone/), [Hyrax](https://hyrax.dev/blog/cursor-iphone-mobile-code-review-risk)).

**Inferences**
- Consensus: file list/jump control, wrap toggle (wrap default, horizontal scroll opt-in), long-press range selection, collapse/viewed state. Newest: summary-first order and synced "viewed".
- Omitting editor/terminal/file browser (Cursor, Codex) is a stance: the phone is for oversight. A companion with a file tree and viewers is broader.
- Unified (single-column) diff is the only practical phone layout; no source describes a split diff at phone width.

**Gaps.** No sourced facts on GitLab, Bitbucket, Forgejo/Gitea clients' diff layout, vscode.dev/Codespaces on phones, minimap, or pinch-zoom of code in GitHub Mobile; no hard satisfaction data beyond anecdotes.

## 2. Remote and mobile AI coding-agent supervision

**Takeaway.** By Nov 2026 every major agent has a phone surface on one loop: session list, streaming chat, push when the agent finishes or needs input, approve/deny, steering by follow-up. Two architectures: cloud sessions (keep running with the phone away) and relayed control of a session on the user's computer (Claude Remote Control, Codex via ChatGPT app, Cursor Remote Control).

**Claude Code** ([docs](https://code.claude.com/docs/en/mobile) unless noted)
- No separate app: the Claude mobile app's Code tab shows cloud sessions, projects, Remote Control sessions and Dispatch tasks to Desktop; `/mobile` shows an install QR.
- Remote Control: execution and filesystem stay local; `claude remote-control` or `/remote-control`, scan QR or pick from the Code tab; reconnects after sleep; photos saved under `~/.claude/uploads/`.
- Push when a long task finishes or a decision is needed; "notify me when X" in a prompt.
- Limits: terminal-only commands (`/plugin`, `/resume`) fail; mobile permission modes are Manual, Accept edits, Plan, Auto (cloud: no Manual); Bypass not selectable. Sessions persist across devices; Claude can watch a PR and fix CI/review comments. Teleport (`claude --teleport`) pulls a cloud session to the terminal; requirements (clean git, same account) from third-party posts only ([codeongrass](https://codeongrass.com/blog/claude-code-teleport-hand-off-phone/)).
- Criticism (issue status unverified, snippets only): iOS Remote Control permission prompts show only ~100 characters of a command ([37235](https://claudeissues.com/issue/37235-feature-remote-control-allow-expanding-permission-prompts-on-ios-to-see-the-full)); requests for actionable Approve/Deny in the push with default-deny on timeout ([62458](https://claudeissues.com/issue/62458-feature-request-actionable-approve-deny-on-mobile-push-for-permission-prompts)); prompts do not propagate to remote sessions ([38061](https://claudeissues.com/issue/38061-permission-prompts-dont-propagate-to-remote-mobile-sessions)). A blogger argues the phone bottleneck is permission prompts, not screen size ([mejba.me](https://www.mejba.me/blog/claude-code-remote-control-phone)).

**Codex (ChatGPT app)** (third-party analysis, not OpenAI docs; reports differ on launch details)
- Preview 14 May 2026 on iOS/Android, connecting to the Codex desktop app on macOS (Windows "coming soon") ([Android Authority](https://www.androidauthority.com/codex-smartphone-control-3665256/), [Vaughan](https://codex.danielvaughan.com/2026/05/15/codex-mobile-chatgpt-app-relay-architecture-remote-agent-control/), [letsdatascience](https://letsdatascience.com/news/openai-adds-codex-remote-control-to-chatgpt-mobile-18bf45b0)).
- Threads with full history, steering, approvals with desktop gates, syntax-highlighted diffs, test results, screenshots; `/model`, `/effort`; push for approval gates; host picker. No direct file edit or shell; plugins/MCP/config desktop-only.
- OpenAI-operated relay; QR pairing carries host Ed25519 key; X25519 handshake; AES-256-GCM traffic; relay cannot read prompts/diffs/approvals; revoke requires re-pairing.

**GitHub Copilot**: coding agent in GitHub Mobile since Jun 2025 ([changelog](https://github.blog/changelog/2025-06-03-github-copilot-coding-agent-now-available-on-github-mobile)); 26 Feb 2026 Live Notifications for agent progress, extended 8 Jul 2026 to Copilot CLI sessions ([Feb](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications), [Jul](https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions)); 8 Apr 2026 research, plan, review branch diff, iterate, open a PR from the phone ([changelog](https://github.blog/changelog/2026-04-08-github-mobile-research-and-code-with-copilot-cloud-agent-anywhere)); Jul 2026 "Fix with Copilot" on merge conflicts, review comments, failing checks ([8 Jul](https://github.blog/changelog/2026-07-08-github-mobile-fix-merge-conflicts-with-copilot-cloud-agent), [17 Jul](https://github.blog/changelog/2026-07-17-github-mobile-fix-pull-request-comments-with-copilot-cloud-agent), [23 Jul](https://github.blog/changelog/2026-07-23-github-mobile-fix-failing-actions-checks-with-copilot-cloud-agent)).

**Cursor**: iOS native app (beta, iOS 26+; no Android, PWA workaround). Inbox of all agents from any surface; iPad sidebar; streaming chat with follow-ups and subagent transcript cards; push on turn end; Live Activities/Dynamic Island for up to 8 agents; cache-first. Remote Control needs desktop 3.9.8+ awake. Editor, terminal, file browser, MCP management are web-only ([Cursor](https://cursor.com/docs/cloud-agents/mobile)).

**Others**: Replit mobile has Agent, editor, publishing, notifications when Agent needs help or is done; a forum user finds Plan/Build states hard to tell apart on iOS and plan approval only passively signalled ([docs](https://docs.replit.com/platforms/mobile-app), [forum](https://replit.discourse.group/t/plan-vs-build-in-the-new-replit-ui/10062)). Devin: release notes 2026.10.07 mention a notification inbox with per-type push; iPhone beta reported only by an aggregator ([Havoptic](https://www.havoptic.com/r/devin-2026-10-07), [hermes-ai](https://hermes-ai.net/news/cognition-brings-devin-mobile-to-iphone-so-developers-code-on-the-go/)). Third-party approval apps (Happier, Tactic Remote, Moshi, Grass): vendor sources only ([Tactic Remote](https://tacticremote.com/blog/2026-02-28-best-ios-apps-for-remote-ai-coding-agents)).

**Inferences**
- Table stakes: notification on done/needs-input, approve/deny with the full action visible, follow-up steering, cross-device session inbox.
- Failure mode to avoid: truncated command in the approval prompt; approval from the notification itself is wanted.
- Companions omit config/plugin management; E2E-encrypted relay with QR pairing is the emerging norm. A local-first companion like this app maps to Remote Control / Codex relay, not cloud sessions.

**Gaps.** Jules and Warp mobile: nothing found. Devin app unverified against Cognition docs. No docs on Claude's `claude.ai/code` mobile diff and tool-call rendering; no UX detail on tool-call cards or todo lists in any app; multi-session UX beyond Cursor's inbox/Live Activities.

## 3. Terminal/SSH apps (Termius, Blink, JuiceSSH)

Little first-party evidence. Blink and Termius auto-reconnect; Blink has stronger mosh support (sources conflict on Termius mosh); neither is agent-aware and Termius has no push ([Moshi (vendor)](https://getmoshi.app/compare/termius), [Cosyra](https://cosyra.com/guides/ssh-from-phone.html)). Inference: agent apps abandon raw terminals because long output and approval prompts get buried in scrollback; structured events fix that. Gaps: extra-key rows, long-output handling, JuiceSSH.

## 4. Criticisms and mitigations

**Takeaway.** Pain: wrapped long lines, small screens, no execution/tests, rushed approvals, truncated approval prompts. Mitigations: wrap toggle, jump-to-file, summary-first, collapse/viewed, agent-assisted "fix this" actions, automated review before human review.

- Writers advise phone review for triage and small diffs, reviewing intent rather than hunting bugs ([Grass](https://codeongrass.com/blog/review-agent-code-changes-phone/), [Junction](https://junctionpanel.dev/blog/review-ai-agent-diffs-from-your-phone/)). Automated review should run first, not in parallel; a Cursor forum request asks for risk-ranked diffs, no evidence it exists ([Hyrax, 30 Jun 2026](https://hyrax.dev/blog/cursor-iphone-mobile-code-review-risk), [forum](https://forum.cursor.com/t/mobile-code-review-for-cursor-changes/166889)). Most criticism comes from competing-product marketing; GitHub complaints are anecdotal.
- Design implication: provide change summary and risk ordering, show the full command in permission prompts, make wrap toggle and file jump first-class, persist viewed state.
- Gap: no systematic user survey; Reddit threads visible only as mirror snippets.
