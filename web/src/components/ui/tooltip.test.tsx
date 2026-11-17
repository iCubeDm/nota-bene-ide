import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.tsx';

afterEach(cleanup);

const bar = (disabled: boolean) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" disabled={disabled} className="disabled:pointer-events-none">Undo</button>
      </TooltipTrigger>
      <TooltipContent>Undo (⌘Z)</TooltipContent>
    </Tooltip>
  </TooltipProvider>
);
const show = (disabled: boolean) => render(bar(disabled));

it('a disabled button still shows its tooltip on hover: the trigger is a span around it (issue 463)', async () => {
  show(true);
  const btn = screen.getByRole('button', { name: 'Undo' });
  expect(btn.parentElement!.tagName).toBe('SPAN');
  await userEvent.hover(btn.parentElement!);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Undo (⌘Z)');
});

it('the button stays the same element, focus kept, as it is disabled and enabled again (the wrapper is there whenever it can be disabled)', () => {
  const { rerender } = show(false);
  const btn = screen.getByRole('button', { name: 'Undo' });
  btn.focus();
  rerender(bar(true));
  rerender(bar(false));
  expect(screen.getByRole('button', { name: 'Undo' })).toBe(btn);
  expect(document.activeElement).toBe(btn);
  rerender(bar(true));
  expect(screen.getByRole('button', { name: 'Undo' })).toBe(btn);
});

it('a button with no disabled prop is the trigger itself', async () => {
  render(
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild><button type="button">Redo</button></TooltipTrigger>
        <TooltipContent>Redo</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  const btn = screen.getByRole('button', { name: 'Redo' });
  expect(btn.parentElement!.tagName).not.toBe('SPAN');
  await userEvent.hover(btn);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Redo');
});
