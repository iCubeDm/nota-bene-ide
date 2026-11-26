import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../ui/tooltip.tsx';
import { EditorField } from './EditorField.tsx';
import type { Field } from './field.ts';

afterEach(cleanup);

function setup(value: string, plain = false) {
  const ref = createRef<Field>();
  render(<TooltipProvider><EditorField fieldRef={ref} ariaLabel="Message" value={value} onChange={vi.fn()} newline="Shift-Enter" plain={plain} /></TooltipProvider>);
  const f = ref.current!;
  act(() => f.focus());
  return f;
}
const select = (f: Field, from: number, to: number) => act(() => EditorView.findFromDOM(f.element)!.dispatch({ selection: { anchor: from, head: to } }));

it('a selection shows the format bar; a button formats it, the selection kept', () => {
  const f = setup('a word b');
  expect(screen.queryByRole('toolbar')).toBeNull();
  select(f, 2, 6);
  const bar = screen.getByRole('toolbar', { name: 'Format' });
  fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
  expect(f.text()).toBe('a **word** b');
  expect(f.selection()).toEqual({ from: 4, to: 8 });
  expect(bar).toBeTruthy();
});

it('the bar goes when the selection collapses, and never shows for a shell command', () => {
  const f = setup('a word b');
  select(f, 2, 6);
  expect(screen.getByRole('toolbar')).toBeTruthy();
  act(() => f.setCaret(1));
  expect(screen.queryByRole('toolbar')).toBeNull();
  cleanup();
  const g = setup('!ls -la', true);
  select(g, 1, 3);
  expect(screen.queryByRole('toolbar')).toBeNull();
});
