import { anchorSource, generatedImages, isAttachmentAnchor, isCutAnchor, isMediaAnchor, type AnchorSource, type Comment, type ImageRef } from '@nota-bene/shared';
import { mediaTypeOf } from '../attachments/image.ts';
import { getLang, t, tIn, type Lang, type RootState, chat, cutWhere, mediaTime, TOOL_SRC, type SendPart, instructionOf, labelOf } from '@/sdk';
import { composeBatch } from './compose.ts';
import { selectImages } from '../composer/slice.ts';
import { createSelector } from '@reduxjs/toolkit';
import { markSending, selectComments, selectPending, unmarkSending } from './slice.ts';
import { selectFileVersion } from '../files/slice.ts';
import { liveCutState } from '../cut/live.ts';
import { agentName, itemsOf } from '../subagent/slice.ts';
import { buildComposites, frameGroups, type FrameGroup } from './frameGroups.ts';

/** A file source as the batch and the card name it: `path`, or `path @ ref` for another branch or worktree (M3-16). */
export const whereOfFile = (src: Extract<AnchorSource, { kind: 'file' }>): string => (src.ref ? `${src.path} @ ${src.ref}` : src.path);

/** The images of a comment that go out on their own: a media comment's frame (images[0]; its layer.png stays on disk) and every pasted image. */
const ownImages = (c: Comment): string[] => {
  const all = c.images ?? [], gen = generatedImages(c);
  return [...all.slice(0, Math.min(1, gen)), ...all.slice(gen)];
};
/** Pasted images only (a grouped media comment sends the shared composite instead of its frame). */
const pastedImages = (c: Comment): string[] => (c.images ?? []).slice(generatedImages(c));

const ARG_CUT = 60;

/**
 * Where a comment's source sits: "reply #n" for a FINAL assistant item (n = 1-based among final
 * assistant items in feed order), "my message" for a user item, "<name> command (arg)" for an action, null otherwise; `plain` (the batch text) names a reply just "reply", no number. The feed keeps no time per assistant
 * item, so the " · time" part of `reply` is dropped rather than invented.
 */
export const selectReplyLabel = (s: RootState, messageId: string, plain = false, agent?: string): string | null => {
  if (agent) return agentLabel(s, messageId, agent);
  if (messageId.startsWith(TOOL_SRC)) {
    // an agent action's command or output (R-M7-20): "Bash command (npm test)", the arg cut to 60 characters
    const id = messageId.slice(TOOL_SRC.length);
    const it = s.feed.items.find((x) => x.kind === 'tool' && x.id === id);
    if (it?.kind !== 'tool') return null;
    return t('srcTool', it.name, it.arg.length > ARG_CUT ? `${it.arg.slice(0, ARG_CUT)}…` : it.arg);
  }
  if (messageId.startsWith('plan:')) return s.feed.items.some((it) => it.kind === 'permission' && `plan:${it.id}` === messageId) ? t('mode_plan') : null;
  let n = 0;
  for (const it of s.feed.items) {
    if (it.kind === 'assistant' && it.final) n++;
    if ((it.kind === 'assistant' || it.kind === 'user') && it.id === messageId) {
      if (it.kind === 'user') return t('srcMine');
      if (!it.final) return null;
      return plain ? t('replyPlain') : t('reply', n, '').replace(/\s*·\s*$/, '');
    }
  }
  return null;
};

/**
 * The label of a place inside a subagent's conversation (no numbers, like the plain `reply`; the quote is the locator):
 * "subagent reply «description»", and for an action "Bash command (npm test) · subagent «description»". An action the
 * conversation does not (yet) hold is unknown (null); a reply is named even before the conversation is loaded, so a
 * batch never calls it a chat message.
 */
function agentLabel(s: RootState, messageId: string, agent: string): string | null {
  const name = agentName(s, agent);
  if (messageId.startsWith(TOOL_SRC)) {
    const id = messageId.slice(TOOL_SRC.length);
    // not loaded (a reload with the tab closed): the same call forwarded into the chat names it, if it is there
    const it = (itemsOf(s, agent) ?? s.feed.items).find((x) => x.kind === 'tool' && x.id === id);
    if (it?.kind !== 'tool') return null;
    return t('srcAgentTool', t('srcTool', it.name, it.arg.length > ARG_CUT ? `${it.arg.slice(0, ARG_CUT)}…` : it.arg), name);
  }
  return t('srcAgentReply', name);
}

/** Where a comment's fragment lives, for the batch line: the reply label, "my message", or the file. */
export function whereOf(
  c: Comment, st?: Parameters<typeof selectReplyLabel>[0],
  /** an attachment comment: the message-wide number of its image among the composer's (undefined = not in this send) */
  attNo?: (imageId: string) => number | undefined, lang: Lang = getLang(),
): string {
  const src = anchorSource(c.anchor);
  const a = c.anchor;
  if (isMediaAnchor(a)) return `${whereOfFile(a.source)}${a.time !== undefined ? ` @ ${mediaTime(a.time)}` : ''} · ${a.width}×${a.height}`;
  if (isCutAnchor(a)) return cutWhere(a, whereOfFile(a.source), lang);
  if (isAttachmentAnchor(a)) return tIn(lang, 'srcAttachment', attNo?.(a.image) ?? 0, a.width, a.height);
  if (!src) return t('srcChat');
  if (src.kind === 'file') return whereOfFile(src);
  // the batch text names a reply plainly: its number is the index in the CURRENT feed (restarts after a compaction, shifts when earlier history is shown); the quote is the locator
  // a subagent's reply or action is named with the subagent (no numbers); one the loaded conversation does not hold still is not "chat"
  if (src.agent) return (st && selectReplyLabel(st, src.id, true, src.agent)) ?? t('srcAgentReply', st ? agentName(st, src.agent) : '');
  return (st && selectReplyLabel(st, src.id, true)) ?? t('srcChat');
}

// keys sorted: the client and the server's echo build the same anchor with its keys in a different order
const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
  : v;
const printOf = (c: Comment): string => JSON.stringify(stable([c.text, c.label, c.anchor, c.images, c.genImages, c.voice]));
/**
 * The pending comments a send would take: an attachment comment goes only with its image, so one whose image is not in this
 * composer stays pending ("detached") and is neither counted on Send nor sent.
 */
export const selectSendable = createSelector([selectPending, selectImages], (pending, own) =>
  pending.filter(({ anchor: a }) => !isAttachmentAnchor(a) || own.some((im) => im.id === a.image)));

/**
 * The comments' part of a send (issue 511): the sendable comments, taken at the click and marked as sending; they go back
 * to pending when the send fails or is refused (pending → sent happens only via the server echo). A recording takes them
 * without the composer's images, so without its attachment comments, and each with its own frame (nothing waits).
 * Otherwise media comments on one source frame (with a live connection) first get one composite image each group
 * (`composites`: group key → attachment id; a group without one falls back to each comment's own frame). Their images are
 * numbered after the composer's, each comment's in order; still the same send when every comment is still pending and
 * unchanged.
 */
export const commentsPart: SendPart = {
  id: 'comments',
  order: 30,
  count: (s) => selectSendable(s).length,
  waiting: (s) => selectPending(s).length > 0,
  take: (st, d, { voice, registry }) => {
    const pending = voice ? selectSendable(st).filter((c) => !isAttachmentAnchor(c.anchor)) : selectSendable(st);
    if (!pending.length) return null;
    const ids = pending.map((c) => c.id), prints = pending.map(printOf);
    d(markSending(ids));
    const groups = frameGroups(pending);
    const draw = registry.anchorViews.get('media')?.composite;
    let composites = new Map<string, string>();
    return {
      ...(!voice && groups.length && st.conn.state === 'open' && draw && {
        ready: buildComposites(pending, groups, draw).then((m) => void (composites = m)),
      }),
      unchanged: (s) => pending.every((c, i) => {
        const now = selectComments(s).find((x) => x.id === c.id);
        return now?.status === 'pending' && printOf(now) === prints[i];
      }),
      compose: ({ s, lang, images: before }) => {
        const images: ImageRef[] = [...before];
        const push = (id: string, label: (k: number) => string): number => (images.push({ id, mediaType: mediaTypeOf(id), label: label(images.length + 1) }), images.length);
        const shared: ({ k: number; cs: number[] } | undefined)[] = [];
        const groupOf = new Map<number, FrameGroup>();
        for (const g of groups) if (composites.has(g.key)) for (const i of g.idx) groupOf.set(i, g);
        const sharedK = new Map<string, number>(); // group key → its image number, once pushed
        const refs = pending.map((c, i) => {
          const g = groupOf.get(i);
          const mine = (list: string[]) => list.map((id) => push(id, (k) => tIn(lang, 'imgLabelC', k, i + 1)));
          if (!g) return mine(ownImages(c));
          const cs = g.idx.map((j) => j + 1);
          if (!sharedK.has(g.key)) sharedK.set(g.key, push(composites.get(g.key)!, (k) => tIn(lang, 'imgLabelG', k, cs)));
          shared[i] = { k: sharedK.get(g.key)!, cs };
          return [shared[i]!.k, ...mine(pastedImages(c))];
        });
        const text = composeBatch(
          '', pending, lang, (c) => labelOf(c, lang),
          (c) => whereOf(c, s, (id) => { const k = before.findIndex((im) => im.id === id); return k < 0 ? undefined : k + 1; }),
          instructionOf, refs,
          // "changed": only when the current version is known (a tab has it loaded) and differs from the one drawn on
          (c) => {
            const a = c.anchor;
            if (!isMediaAnchor(a) || a.version === undefined) return false;
            const cur = selectFileVersion(s, a.source.path, a.source.ref);
            return cur !== undefined && cur !== a.version;
          },
          shared,
          // a cut comment: its clip gone, or its moment trimmed out of it, as the edit's open tab shows it
          (c) => { const x = isCutAnchor(c.anchor) ? liveCutState(c.anchor) : undefined; return x === 'ok' ? undefined : x; },
        );
        return { text, images: images.slice(before.length), commentIds: ids };
      },
      released: () => void d(unmarkSending(ids)),
    };
  },
};

/** The comments panel's Send: the message with everything the composer holds, as the composer's Send. */
export const sendBatch = (force: boolean) => chat.send('', { force });
