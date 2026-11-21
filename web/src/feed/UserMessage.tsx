import { BATCH_HEAD } from '@nota-bene/shared';
import { getLang, useT, escapeMentions, useRegistry, type FeedItem, type Held } from '@/sdk';
import { memo, useContext } from 'react';
import { Markdown } from './Markdown.tsx';
import { MsgTime } from './MsgTime.tsx';
import { clockTime } from './time.ts';
import { FeedScope } from './scope.ts';

type User = Extract<FeedItem, { kind: 'user' }>;

/** A line's time in the UI language: `14:32` today, with its date on another day (see time.ts); '' for ts 0. */
export const timeOf = (ts: number): string => (ts > 0 ? clockTime(ts, getLang()) : '');

/** `held` (issue 499): a send the server holds behind a pending restart or compaction; the line says what it waits for */
export const UserMessage = memo(function UserMessage({ item, held }: { item: User; held?: Held }) {
  const t = useT();
  const inAgent = !!useContext(FeedScope).agent; // a subagent's tab: the first message is the prompt it was given, not the user's
  const parts = useRegistry().userParts; // the body under the header: a recording, the text, the images, the comments (issue 511)
  const mode = held ? t(held === 'restart' ? 'youHeldRestart' : 'youHeldCompact') : item.force ? t('youForced') : item.duringWork ? t('youBusy') : '';
  return (
    <div
      data-kind="user"
      data-item-id={item.id}
      data-held={held}
      className={`my-2.5 rounded-[10px] border border-border-soft bg-muted/55 px-3 py-2${held ? ' border-dashed opacity-70' : ''}`}
    >
      <div data-anchor-skip className="mb-0.5 font-mono text-[0.65625rem] text-muted-foreground">
        {inAgent ? t('agentPrompt') : t('you')}
        {/* an old replay may know no time (ts 0): then none rather than a wrong one */}
        {item.ts > 0 && <> · <MsgTime ts={item.ts} /></>}
        {mode}
      </div>
      {parts.map(({ id, render: Part }) => <Part key={id} item={item} />)}
    </div>
  );
});

/** The message's own words: its text before the comment batch (a voice message's transcript is the recording's). */
export function UserText({ item }: { item: User }) {
  const m = BATCH_HEAD.exec(item.text);
  // a voice message: `text` is '' until the host's transcript arrives (a replayed history has it there at once)
  const general = item.voice ? '' : m ? item.text.slice(0, m.index) : item.text;
  return general ? (
    <div className="md-tight">
      <Markdown text={escapeMentions(general)} final breaks mentions noHtml />
    </div>
  ) : null;
}
