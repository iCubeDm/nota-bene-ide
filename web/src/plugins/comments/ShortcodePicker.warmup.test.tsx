import { act, cleanup, render, screen } from '@testing-library/react';
import { createRef, useState, type RefObject } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { select, setValue, valueOf } from '@/core/testing';
import { EditorField } from '@/core/components/field/EditorField.tsx';
import type { Field } from '@/sdk';
import { ShortcodePicker } from './ShortcodePicker.tsx';

let release!: () => void;
vi.mock('./emoji.ts', () => ({
  loadEmoji: () => new Promise<void>((r) => { release = r; }),
  searchShortcodes: (q: string) => (q === '+1' ? [{ code: '+1', emoji: '👍' }] : []),
}));
afterEach(cleanup);

function Host({ fieldRef }: { fieldRef: RefObject<Field | null> }) {
  const [value, setV] = useState('');
  return <><EditorField fieldRef={fieldRef} value={value} onChange={setV} newline="Enter" ariaLabel="box" /><ShortcodePicker target={fieldRef} /></>;
}

it('a caret moved onto a closed :+1: while emoji data loads is not replaced', async () => {
  const ref = createRef<Field | null>();
  render(<Host fieldRef={ref} />);
  const box = screen.getByRole('textbox', { name: 'box' });
  box.focus();
  setValue(box, ':+1: x :sm'); // starts the (pending) load
  select(box, 4); // user moves the caret right after ":+1:"
  await act(async () => release());
  expect(valueOf(box)).toBe(':+1: x :sm');
  expect(screen.queryByRole('listbox')).toBeNull();
});
