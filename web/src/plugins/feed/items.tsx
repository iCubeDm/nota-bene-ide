import { memo } from 'react';
import { chat, useAppDispatch, type AnyFeedRenderer, type FeedItem, type Held } from '@/sdk';
import { DoneLine, IdleCompactLine, MarkerLine, NoticeLine } from './DoneLine.tsx';
import { MsgTime } from './MsgTime.tsx';
import { PlanCard } from './PlanCard.tsx';
import { UserMessage } from './UserMessage.tsx';
import { Markdown, PermissionCard } from '@/sdk/ui';

type Of<K extends FeedItem['kind']> = Extract<FeedItem, { kind: K }>;

/** A user's line: the server's own idle /compact is a line of its own, anything else a message. */
const UserLine = memo(function UserLine({ item, held }: { item: Of<'user'>; held?: Held }) {
  return item.idle ? <IdleCompactLine item={item} /> : <UserMessage item={item} held={held} />;
});

/** An agent reply; like every feed item's element, memoized: a streamed token re-renders only the reply it extends (issue 471). */
const Reply = memo(function Reply({ item: it }: { item: Of<'assistant'> }) {
  return (
    <div data-kind="assistant" data-item-id={it.id} data-final={String(it.final)} className="group/reply relative my-2.5">
      {/* in the gap above the reply, shown on hover: a reply has no header line of its own to carry it */}
      <MsgTime ts={it.ts} anchorSkip className="absolute -top-2.5 right-0 select-none font-mono text-[0.625rem] leading-none text-muted-foreground opacity-0 transition-opacity group-hover/reply:opacity-100" />
      <Markdown text={it.text} final={it.final} />
    </div>
  );
});

/** The chat's ask: answered over the socket. */
function ChatPermission({ item }: { item: Of<'permission'> }) {
  const d = useAppDispatch();
  return <PermissionCard ask={item} answer={item.answer} archived={item.archived} onAnswer={(allow, r) => d(chat.answer(item.id, allow, r))} />;
}

/** A permission request: a plan to approve is a card of its own. */
const Permission = memo(function Permission({ item }: { item: Of<'permission'> }) {
  return item.toolName === 'ExitPlanMode' && typeof item.input.plan === 'string' ? <PlanCard item={item} /> : <ChatPermission item={item} />;
});

/** How the feed draws its own kinds (issue 511): every kind but actions, which `Feed` draws in runs, and `! cmd` runs, the composer's. */
export const FEED_RENDERERS: AnyFeedRenderer[] = [
  { kind: 'user', render: UserLine },
  { kind: 'assistant', render: Reply },
  { kind: 'done', render: DoneLine },
  { kind: 'permission', render: Permission },
  { kind: 'marker', render: MarkerLine },
  { kind: 'notice', render: NoticeLine },
];
