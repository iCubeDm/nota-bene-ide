# Chat-feed UX patterns in mobile messaging and AI-assistant apps (as of Nov 2026)

Method note: roughly 16 searches/fetches. Primary sources were reachable only for Telegram. Most other findings come from search summaries of third-party articles, forum posts and teardowns, so treat them as lower confidence. Several fetches failed (NN/g article 404, Android Authority 403, TechRadar truncated, claudeissues.com unresolvable). Many questions in the brief (Signal, WhatsApp partial quote, unread markers, scroll-to-bottom, date separators, Le Chat, Copilot, streaming/stop button, tool-call display, evidence on chunked answers) were NOT covered. They are listed under Gaps rather than filled from memory.

## Messaging apps: bubbles/rows, swipe-to-reply, long-press menus, reactions, partial quote, threads, jump-to-message

### Takeaway
Telegram (since Oct 2023) is the one messaging app with a confirmed, primary-sourced fragment-level reply: select text inside a message, choose "Quote", and tapping the quote later jumps to the exact spot. WhatsApp and Discord use swipe or long-press to reply to a whole message. Discord on mobile has no swipe-to-reply. Slack gained a long-press "Explain" action for dense messages.

### Cited Findings
- Telegram "Replies 2.0" shipped Oct 2023. Quote a fragment: tap the message (on iOS press and hold), then press-hold and drag to select text, then choose "Quote". Several quotes can be used in one reply, and quote formatting is available on any text. — [Telegram blog](https://telegram.org/blog/reply-revolution)
- Tapping a quote in Telegram navigates to the exact location in the original message with an animation. A reply can also be sent into a different chat via the reply bar ("Reply in Another Chat"). Tapping that reply from the other chat opens the original message in its source chat if the user has access. — [Telegram blog](https://telegram.org/blog/reply-revolution)
- The Telegram blog page states no size limit for quotes. This is an absence of information, not proof there is no limit. — [Telegram blog](https://telegram.org/blog/reply-revolution)
- Telegram users had requested partial replies for years via the bug tracker; one request was marked fixed in 10.1.0. Secondary report: Android 10.1.3+. — [Telegram bug tracker](https://bugs.telegram.org/c/1050/32); [SamMobile](https://www.sammobile.com/news/telegram-adds-quote-formatting-name-colors-revised-reply-more/)
- WhatsApp: swipe right on a message highlights it and opens the reply field; long-press also works. Long-press opens a reaction bar (six default emoji, plus a "+" for any emoji in newer versions). Double-tap to react was added. Group "Reply privately" is under long-press > More. — [Android Central](https://androidcentral.com/apps-software/whatsapp-is-making-it-a-snap-to-react-with-a-double-tap); [SlashGear](https://www.slashgear.com/862191/how-to-use-whatsapp-emoji-reactions/); [NewsBytes](https://www.newsbytesapp.com/news/science/whatsapp-s-secret-swipe-feature-will-save-you-precious-time/story). All third-party, not WhatsApp's help centre.
- WhatsApp a11y bug: a VoiceOver user reports the long-press menu closing before an item can be selected on iOS 26. One report, unverified. — [AppleVis](https://www.applevis.com/comment/195702)
- Discord mobile: long-press a message, then tap Reply. Reply pings on by default and can be turned off. No swipe-to-reply: users request it, citing WhatsApp and Telegram. — [Discord support](https://support.discord.com/hc/fr/articles/360057382374); [Discord feedback post](https://support.discord.com/hc/de/community/posts/4405717362967-Shortcut-to-Reply-to-Message-in-Mobile-Application)
- Slack mobile: tap-and-hold shows the desktop hover actions (react, reply, edit); the Android menu also has Mark Unread and Star (2019 tips post, old). — [Slack blog](https://slack.com/blog/productivity/get-more-from-slack-on-mobile)
- Slack Dec 2025 feature drop: refreshed message action menus (clearer grouping, new icons) and a long-press "Explain" action giving a contextual breakdown of jargon or dense messages. — [Slack blog](https://slack.com/blog/news/feature-drop-dec25)
- Slack Activity (fall 2023 redesign, updated again Jan 2026) collects DMs, mentions, threads, reactions in one feed with top tabs; swipe left on an item clears it. — [Slack Design](https://slack.design/articles/no-small-task-evolving-the-way-millions-catch-up-in-slack/); [Engadget](https://www.engadget.com/slacks-latest-redesign-has-a-dedicated-dm-tab-and-a-discord-style-activity-view-130032154.html); [Slack help](https://slack.com/intl/en-in/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack)
- Google Messages (reference, not requested): the long-press menu was redesigned from a top toolbar to a floating list close to the selected bubble. — [Android Central](https://www.androidcentral.com/apps-software/google-messages-gets-a-major-gesture-and-menu-refresh)

### Inferences
- Telegram's flow (select, Quote, tap-to-jump) is the closest messaging precedent for the fragment-level comments the companion app needs. Its entry is a text selection, not a bubble gesture.
- Whole-message swipe-to-reply is a fast path made for short messages. It does not scale to long multi-topic replies, which matches the device-testing finding.
- Slack's "Explain" on long-press shows that long-press on a dense message can carry content-aware actions, not only reply/react.

### Gaps
- No official source found for WhatsApp, Signal, Slack or Discord on: partial/fragment quote, bubble vs full-width layout, message grouping, unread markers, scroll-to-bottom button, date separators, sizes and gesture thresholds. WhatsApp's 2016 quote-testing report is old and not about current UI. Slack thread UI on mobile and Discord threads were not verified.
- Signal: no usable result at all.

## AI-assistant apps: rendering, long-answer structure, per-answer actions, text selection, quoting into the next prompt

### Takeaway
No evidence that ChatGPT or Claude mobile support selecting a fragment and replying to it natively. This is a repeatedly requested feature. Gemini has a native "Select text" and "Ask Gemini" in testing or rollout (unconfirmed). Perplexity is the strongest document-style answer with inline citations and optional detail layers.

### Cited Findings
- OpenAI community has many feature requests for quote/reply to a specific passage; one says users "may need to copy and paste the text or explain which section they mean". Another requests inline anchored annotations and contextual threads. — [OpenAI community: Interactive text selection](https://community.openai.com/t/interactive-text-selection/1413759); [Inline anchored annotations](https://community.openai.com/t/feature-request-inline-anchored-annotations-and-contextual-threads-for-chatgpt-responses/1390620); [Quote/reply to specific segments](https://community.openai.com/t/feature-suggestion-quote-reply-to-specific-text-segments/1378659)
- A web "Ask ChatGPT" tooltip on highlight exists on the browser version per community posts, and a bug report says the reference chip above the input shows raw markdown. I found no confirmation of this on the mobile app. — [OpenAI community: Ask ChatGPT tooltips](https://community.openai.com/t/more-ask-chatgpt-tooltips-for-broswer-based-chatgpt-to-improve-ux/1380953); [markdown bug](https://community.openai.com/t/unrendered-markdown-in-the-ask-chatgpt-reply-feature/1388930)
- ChatGPT mobile text selection complaints exist ("iPhone Air users: is text selection acting weird"). Only the title was seen. — [OpenAI community](https://community.openai.com/t/iphone-air-users-is-chatgpt-text-selection-acting-weird-for-you-too/1378815)
- ChatGPT branching: long-press a message on mobile, choose "Branch in new chat" (labels vary by source). Launched on web first (reported Sept 2025), mobile reported rolling out around Jan 2026. Dates and wording from secondary sources. — [TechRadar](https://techradar.com/ai-platforms-assistants/chatgpt/the-chatgpt-app-just-got-a-big-upgrade-on-ios-and-android-to-stop-your-chats-spiraling-out-of-control) (headline only fetched); [Google Groups post](https://groups.google.com/g/onecooltip/c/Vpt26NLriCI)
- Claude mobile/desktop: GitHub-style issue-tracker reports say the copy action copies the whole message and users ask for selective copy; copy in Remote Control (Code tab) sessions on mobile is reported broken; one iPad report says selecting text in a long session auto-scrolls to top and deselects. User reports, not Anthropic docs. — [claudeissues.com 75155](https://claudeissues.com/issue/75155-feature-request-selective-text-copy-within-messages-mobile-app-desktop-not-only); [71718](https://claudeissues.com/issue/71718-bug-cannot-copy-text-correctly-from-code-tab-remote-control-session-on-mobile-ap); [72190](https://claudeissues.com/issue/72190-ipados-app-selecting-text-in-a-long-remote-macos-session-auto-scrolls-to-top-and)
- Relevant to this product: a Claude Code Remote Control mobile session already has these selection/copy issues. — same sources.
- Gemini: Android Authority reported a "Select text" option in Gemini for Android to copy part of a response. An APK teardown reported an "Ask Gemini" action after selection. Neither had a confirmed release date. The web app has a pencil/sparkle "Modify selected text". A Product Hunt page (Jan 29, 2026) says Gemini lacked native quote-a-fragment, hence Chrome extensions. — [Android Authority](https://www.androidauthority.com/gemini-select-text-3436270) (not fetchable; search summary only); [Product Hunt](https://www.producthunt.com/products/quote-reply-for-gemini); [9to5Google](https://9to5google.com/?p=608855)
- Perplexity (third-party teardowns): answer first, then sources strip (favicon cards), then related-question chips; inline numbered citations at the claim; collapsed "Reviewed sources"; expandable "Completed N steps" before the answer; action row with share/copy/rewrite. Teardown claims highlighting offers "add to follow-up" and "check sources" (unverified against the app). — [925 Studios teardown](https://www.925studios.co/blog/perplexity-design-breakdown); [aiuxplayground](https://aiuxplayground.com/teardowns/perplexity/citations); [Blake Crosley](https://blakecrosley.com/guides/design/perplexity)
- Perplexity criticisms: citation markers and source cards crowd small screens and push the answer below the fold; all sources look equally authoritative; follow-up chips sometimes generic. — [925 Studios](https://www.925studios.co/blog/perplexity-design-breakdown)

### Inferences
- The gap in ChatGPT/Claude/Gemini mobile (no native fragment reply) is the same pain device testing found, and the volume of feature requests suggests demand. A companion app that makes fragment actions primary would differentiate.
- Perplexity's layered structure (answer, evidence, exploration) shows that sections of an answer can carry different affordances, a model for per-section actions.

### Gaps
- Not found: official help-centre details for per-answer actions (copy, regenerate, read aloud, share, edit) in ChatGPT, Claude, Gemini, Copilot, Le Chat; bubble vs full-width rendering per app; streaming display and stop-button behaviour; thinking/tool-call display; canvas/artifacts mobile behaviour; Copilot and Le Chat entirely. ChatGPT's release note on selecting text in memory summary was seen only as a snippet and is not about chat replies.

## Splitting one AI answer into several messages / acting on paragraphs; evidence on chunked vs monolithic answers

### Takeaway
I found no app that splits one AI answer into separate messages, and no hard evidence comparing chunked and monolithic answers. Related patterns: ChatGPT branching (whole-conversation fork at a message), Slack "Explain" on a message, Perplexity's section layers, and requests for threaded replies.

### Cited Findings
- OpenAI community requests for "Threaded replies for long conversations" and anchored annotations/contextual threads on a response. — [Threaded replies](https://community.openai.com/t/threaded-replies-for-long-conversations/1385480); [Anchored annotations](https://community.openai.com/t/feature-request-inline-anchored-annotations-and-contextual-threads-for-chatgpt-responses/1390620)
- Summaries of NN/g chatbot research say the core problem is getting lost scrolling through streams of replies, worsened by lengthy outputs; NN/g's review of Google AI Mode lists long unformatted answers as a problem; NN/g advises direct, scannable answers that are easy to expand. These come from secondary write-ups; the NN/g primary page was not retrieved. — [Experientia summary](https://blog.experientia.com/?p=20115); [Search Engine World](https://www.searchengineworld.com/influential-nielsen-norman-group-tees-off-on-google-ai-google-ai-mode); [NN/g author page](https://www.nngroup.com/articles/author/georgia-kenderova/)
- The NN/g chatbot study had 8 US participants (5 mobile, 3 desktop), so it is small-sample. A Jakob Nielsen summary of a ChatGPT study describes "apple-picking": scrolling back through long chats to find points. — [Jakob Nielsen substack](https://jakobnielsenphd.substack.com/p/ux-news-20230925)

### Inferences
- Splitting into units is unproven but consistent with NN/g's scroll-and-lose-place findings and with the requests for anchored/threaded replies. It would need its own testing.
- Whether to chunk at generation time (agent emits several messages) or at render time (client splits by heading/paragraph/tool call) is a design choice the research does not settle.

### Gaps
- No empirical comparison of chunked vs monolithic AI answers. No product found that splits answers.

## Known complaints and praised patterns

### Takeaway
Recurring complaints: verbosity and scrolling, selection/copy friction on mobile, and mobile density of citations. Praised: Telegram's quote-with-jump, Perplexity's answer-first layering.

### Cited Findings
- Reddit complaints (Mar 2026) that simple questions get walls of text; another thread about "answers too long, verbose" (115 points, 52 comments); workarounds are prompt length limits. Thin sourcing; OpenAI reportedly made answers more direct (secondary). — [Reddit snapshot](https://reddit.sentinel-team.org/posts/1rxxltp/snapshots/2026-03-20T14%3A50%3A06.156883Z); [ai-productivity](https://ai-productivity.pages.dev/news/chatgpt-verbosity-complaints-growing-2026/)
- Telegram quote praised in news coverage for tap-to-jump. — [AlternativeTo](https://alternativeto.net/news/2023/10/telegram-rolls-out-major-update-with-improved-replies-and-enhanced-stories)
- Selection and copy friction on mobile for Claude sessions (see above). — [claudeissues.com 75155](https://claudeissues.com/issue/75155-feature-request-selective-text-copy-within-messages-mobile-app-desktop-not-only)

### Inferences
- Selection is the weakest part of mobile AI chat today; a design that does not rely on native OS text selection (explicit per-paragraph targets) avoids a known pain point.

### Gaps
- No systematic app-store review analysis of message-action UX was found.
