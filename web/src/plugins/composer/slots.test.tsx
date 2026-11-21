// The composer's slots (issue 545): a plugin's parts land in the composer's status line, its tools row and at the row's
// end, and its pickers serve both message fields, the composer's and a comment popup's.
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect, type FC, type ReactElement } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { PLUGINS } from '@/plugins.ts';
import { definePlugin, useComposerField, type PendingComment, type SlotName } from '@/sdk';
import { makeStore } from '@/testing';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import { Composer } from './Composer.tsx';

beforeEach(() => setLang('en'));
afterEach(() => { cleanup(); field = null; });

const mark = (at: string) => () => <i data-probe={at} />;
let field: HTMLTextAreaElement | null = null;
function Picker() {
  const host = useComposerField();
  useEffect(() => void (field = host.field.current)); // after the commit: the host's ref is set by then
  return <i data-probe="picker" data-kind={host.kind} />;
}
const at = (slot: SlotName, render: FC) => ({ slot, order: 99, render });
const probe = definePlugin({
  id: 'probe',
  slots: [at('composer.status', mark('status')), at('composer.tools', mark('tools')), at('composer.end', mark('end')), at('composer.pickers', Picker)],
});

function setup(ui: ReactElement) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }), plugins: [...PLUGINS, probe] });
  render(<Provider store={store}><TooltipProvider>{ui}</TooltipProvider></Provider>);
}
const probes = (name: string) => document.querySelectorAll<HTMLElement>(`[data-probe="${name}"]`);

it('the composer places each slot\'s parts where its own pills were, and its pickers get its field', () => {
  setup(<Composer />);
  const row = document.querySelector('[data-tools-row]')!;
  const items = [...row.children];
  const attach = screen.getByRole('button', { name: /attach/i });
  // after the mode pill, before the attach button; the end's after the compaction control, last in the row
  expect(items.indexOf(probes('tools')[0]!)).toBe(items.indexOf(attach) - 1);
  expect(items.at(-1)).toBe(probes('end')[0]);
  // the status line: the composer's first row, after its own notes
  expect(probes('status')[0]!.parentElement).toBe(row.parentElement!.firstElementChild);
  const [picker] = probes('picker');
  expect(picker).toHaveAttribute('data-kind', 'chat');
  expect(field).toBe(document.getElementById('composer-input'));
});

it('a comment popup\'s field gets the same pickers, and none of the composer\'s pills', () => {
  const pending = { anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 1, quote: 'h', prefix: '', suffix: '' }, rect: new DOMRect(10, 20, 40, 20) } as PendingComment;
  setup(<CommentPopup pending={pending} onClose={() => {}} />);
  const [picker] = probes('picker');
  expect(picker).toHaveAttribute('data-kind', 'comment');
  expect(screen.getByRole('dialog')).toContainElement(picker as HTMLElement);
  expect(field).toBe(screen.getByRole('textbox'));
  expect([...probes('status'), ...probes('tools'), ...probes('end')]).toEqual([]);
});
