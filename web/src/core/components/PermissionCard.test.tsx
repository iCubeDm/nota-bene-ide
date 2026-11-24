// Issue 651: the permission card answers through its `onAnswer`: the chat sends the socket's message, the home page's
// inbox posts to the agent.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/core/i18n/index.ts';
import { PermissionCard } from './PermissionCard.tsx';

beforeEach(() => setLang('en'));
afterEach(cleanup);

const ASK = { id: 'p1', toolName: 'Bash', input: { command: 'ls' } };

it('Allow and Deny call onAnswer', () => {
  const onAnswer = vi.fn();
  render(<PermissionCard ask={ASK} onAnswer={onAnswer} />);
  expect(screen.getByText('ls')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  expect(onAnswer.mock.calls).toEqual([[true], [false]]);
});

it('a prompt\'s choice calls onAnswer with its id and the fields', () => {
  const onAnswer = vi.fn();
  const prompt = { title: 'Question', choices: [{ id: 'accept', label: 'Accept' }], fields: [{ id: 'q', label: 'Name' }] };
  render(<PermissionCard ask={{ ...ASK, prompt }} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'yes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  expect(onAnswer).toHaveBeenCalledWith(true, { choice: 'accept', values: { q: 'yes' } });
});

it('an answered ask shows Allowed and no buttons', () => {
  render(<PermissionCard ask={ASK} answer onAnswer={() => {}} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('✓ allowed')).toBeTruthy();
});
