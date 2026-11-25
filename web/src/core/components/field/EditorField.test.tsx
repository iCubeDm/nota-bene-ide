import { cleanup, render, screen } from '@testing-library/react';
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { EditorField } from './EditorField.tsx';
import type { Field } from './field.ts';

afterEach(cleanup);

function setup(value = '', extra: { readOnly?: boolean } = {}) {
  const ref = createRef<Field>();
  const onChange = vi.fn();
  const ui = (v: string) => <EditorField fieldRef={ref} id="composer-input" ariaLabel="Message" value={v} onChange={onChange} newline="Shift-Enter" {...extra} />;
  const r = render(ui(value));
  return { field: () => ref.current!, onChange, rerender: (v: string) => r.rerender(ui(v)) };
}

const viewOf = (f: Field) => EditorView.findFromDOM(f.element)!;

it('typing updates the value', () => {
  const { field, onChange } = setup();
  field().replace(0, 0, 'hi');
  expect(onChange).toHaveBeenLastCalledWith('hi');
});

it('an outside value replaces the text and puts the caret at its end, without onChange', () => {
  const { field, onChange, rerender } = setup();
  rerender('abc');
  expect(field().text()).toBe('abc');
  expect(field().selection()).toEqual({ from: 3, to: 3 });
  expect(onChange).not.toHaveBeenCalled();
});

it('one undo takes back one replace', () => {
  const { field } = setup();
  field().replace(0, 0, 'a');
  field().replace(1, 1, ' path');
  undo(viewOf(field()));
  expect(field().text()).toBe('a');
});

it('the element is a labelled multiline textbox', () => {
  setup();
  const box = screen.getByRole('textbox', { name: 'Message' });
  expect(box.id).toBe('composer-input');
  expect(box.getAttribute('aria-multiline')).toBe('true');
});

it('readOnly refuses typing', () => {
  const { field } = setup('', { readOnly: true });
  expect(viewOf(field()).state.readOnly).toBe(true);
});
