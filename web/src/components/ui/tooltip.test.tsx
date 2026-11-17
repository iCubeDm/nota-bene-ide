import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.tsx';

afterEach(cleanup);

const show = (disabled: boolean) => render(
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" disabled={disabled} className="disabled:pointer-events-none">Undo</button>
      </TooltipTrigger>
      <TooltipContent>Undo (⌘Z)</TooltipContent>
    </Tooltip>
  </TooltipProvider>,
);

it('a disabled button still shows its tooltip on hover: the trigger is a span around it (issue 463)', async () => {
  show(true);
  const btn = screen.getByRole('button', { name: 'Undo' });
  expect(btn.parentElement!.tagName).toBe('SPAN');
  await userEvent.hover(btn.parentElement!);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Undo (⌘Z)');
});

it('an enabled button is the trigger itself', async () => {
  show(false);
  const btn = screen.getByRole('button', { name: 'Undo' });
  expect(btn.parentElement!.tagName).not.toBe('SPAN');
  await userEvent.hover(btn);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Undo (⌘Z)');
});
