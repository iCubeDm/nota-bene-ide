import { BATCH_HEAD, isMediaAnchor, isPageAnchor } from '@nota-bene/shared';
import { pageQuote } from '@/page/quote.ts';
import { Attachments } from '@/attachments/Attachments.tsx';
import { getLang, useT } from '@/i18n/index.ts';
import { mediaTime } from '@/media/markup/geometry.ts';
import { useContext } from 'react';
import { Markdown } from './Markdown.tsx';
import { FeedScope } from './scope.ts';
import { escapeMentions } from '@/refs/refs.ts';
import { labelOf } from '@/comments/labels.ts';
import { selectSentFor } from '@/comments/slice.ts';
import type { FeedItem } from '@/store/feed.ts';
import { useAppSelector } from '@/store/store.ts';
import { VoiceBubble } from '@/voice/VoiceBubble.tsx';

export const timeOf = (ts: number): string =>
  new Date(ts).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });

export function UserMessage({ item }: { item: Extract<FeedItem, { kind: 'user' }> }) {
  const t = useT();
  const inAgent = !!useContext(FeedScope).agent; // a subagent's tab: the first message is the prompt it was given, not the user's
  const sent = useAppSelector((s) => selectSentFor(s, item.id));
  // replayed transcript events carry ts 0: historic bubbles show no time
  const time = item.ts === 0 ? '' : ' · ' + timeOf(item.ts);
  const mode = item.force ? t('youForced') : item.duringWork ? t('youBusy') : '';
  const m = BATCH_HEAD.exec(item.text);
  // a voice message: `text` is '' until the host's transcript arrives (a replayed history has it there at once)
  const general = item.voice ? '' : m ? item.text.slice(0, m.index) : item.text;
  const raw = m ? item.text.slice(m.index + m[0].length) : '';
  return (
    <div
      data-kind="user"
      data-item-id={item.id}
      className="my-2.5 rounded-[10px] border border-border-soft bg-muted/55 px-3 py-2"
    >
      <div data-anchor-skip className="mb-0.5 font-mono text-[0.65625rem] text-muted-foreground">
        {inAgent ? t('agentPrompt') : t('you')}
        {time}
        {mode}
      </div>
      {item.voice && <VoiceBubble voice={item.voice} text={item.voiceText ?? (item.text || undefined)} error={item.voiceError} />}
      {general && (
        <div className="md-tight">
          <Markdown text={escapeMentions(general)} final breaks mentions noHtml />
        </div>
      )}
      {item.images && <Attachments ids={item.images.map((i) => i.id)} />}
      {(sent.length > 0 || raw) && (
        <details data-anchor-skip className="mt-1.5 text-[0.8125rem] text-muted-foreground">
          <summary className="cursor-pointer">{sent.length ? t('nComments', sent.length) : t('commentsLc')}</summary>
          {sent.length
            ? sent.map((c) => (
                <div key={c.id} className="mt-1.5">
                  {/* the quote is text the user selected in rendered output: plain, never re-read as markdown */}
                  <blockquote className="whitespace-pre-wrap border-l-2 border-nb-accent pl-2">{isMediaAnchor(c.anchor) ? `${c.anchor.source.path.slice(c.anchor.source.path.lastIndexOf('/') + 1)}${c.anchor.time !== undefined ? ` @ ${mediaTime(c.anchor.time)}` : ''} · ${t('markShapes', c.anchor.shapes.length)}` : isPageAnchor(c.anchor) ? pageQuote(c.anchor, getLang()) : c.anchor.quote}</blockquote>
                  <div className="md-tight flex items-baseline gap-1">
                    <span className="flex-none">→</span>
                    {c.label && <span className="flex-none rounded bg-muted px-1">{labelOf(c)}</span>}
                    <div className="min-w-0 flex-1"><Markdown text={c.text} final={false} breaks noHtml /></div>
                  </div>
                </div>
              ))
            : <div className="md-tight mt-1.5"><Markdown text={raw} final={false} breaks noHtml /></div>}
        </details>
      )}
    </div>
  );
}
