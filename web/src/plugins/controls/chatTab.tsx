import { useState, type Ref } from 'react';
import { selectSession, toast, useAppSelector, useT, type TabView, renameSession } from '@/sdk';
import { AgentIcon, ICONS, Svg } from '@/sdk/ui';
import { SessionPicker } from './SessionPicker.tsx';

/** The session's title being edited. Enter saves, Esc or a click elsewhere cancels; a failed save stays open. */
function RenameInput({ ref, done }: { ref: Ref<HTMLInputElement>; done: (back: boolean) => void }) {
  const t = useT();
  const id = useAppSelector((s) => selectSession(s)?.id ?? null);
  const title = useAppSelector((s) => selectSession(s)?.title ?? '');
  const [text, setText] = useState(title);
  const save = async () => {
    const name = text.trim();
    if (!id || !name || name === title) return done(true);
    const failed = await renameSession(id, name);
    if (failed === null) done(true);
    else toast(t('renameSess'), t('renameFail') + failed);
  };
  return (
    <input
      ref={ref}
      value={text}
      maxLength={200}
      aria-label={t('renameSess')}
      placeholder={t('untitled')}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      // another app taking the focus is no click elsewhere: the title may be copied from there
      onBlur={() => { if (document.hasFocus()) done(false); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(true); } // prevented: the document hotkeys skip it
        else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
      }}
      className="w-44 min-w-0 rounded border border-primary bg-transparent px-1 text-[0.78125rem] font-medium text-foreground outline-none"
    />
  );
}

/** The chat's icon: its agent's vendor mark (issue 644), the chat's own icon until the hello names the agent. */
function ChatIcon() {
  const caps = useAppSelector((s) => s.controls.capabilities);
  return caps ? <AgentIcon provider={caps.provider ?? 'claude'} /> : <Svg>{ICONS.chat}</Svg>; // Claude's capabilities name none
}

/** The chat's tab: its agent's mark, the session's title, its sessions menu, and a rename of the session from the tab's menu. */
export const chatTab: TabView<'chat'> = {
  kind: 'chat',
  label: (_tab, t, s) => selectSession(s)?.title || t('chat'),
  Icon: ChatIcon,
  Extra: () => <SessionPicker />,
  edit: { when: (s) => !!selectSession(s)?.id, label: 'renameSess', Input: ({ ref, done }) => <RenameInput ref={ref} done={done} /> },
};
