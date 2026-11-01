import { expect, test } from '@playwright/test';

// The Usage tab in a real browser, over the transcript e2e/serve.mjs seeds: a task, its calls, a limit hit, a reset.
test('the Usage tab reports a task and a limit hit, and a reset keeps the data under All time @chat', async ({ page }) => {
  await page.goto('/');
  await page.locator('#usageBtn').click();
  await expect(page.getByRole('tablist').locator('[aria-selected="true"]')).toHaveAttribute('data-tab', 'usage');

  const task = page.getByRole('button', { name: /Review the parser/ });
  await expect(task).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Week', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'demo' }).first()).toBeVisible();
  await task.click();
  await expect(page.getByText('Costliest calls')).toBeVisible();

  await page.getByRole('button', { name: 'Codex' }).click();
  await expect(page.getByText('No usage in this period.')).toBeVisible();
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  await expect(task).toBeVisible();

  await page.getByRole('button', { name: 'Reset the counter' }).click();
  await page.getByRole('button', { name: 'Reset the counter' }).nth(1).click();
  await page.getByRole('button', { name: 'Since reset' }).click();
  await expect(page.getByText('No usage in this period.')).toBeVisible();
  await expect(task).toBeHidden();
  await page.getByRole('button', { name: 'All time' }).click();
  await expect(task).toBeVisible();

  await page.locator('#toggleTree').click();
  await page.locator('#toggleComments').click();
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(task).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('usage-720.png') });
  const clipped = await page.locator('table').evaluateAll((all) => all.filter((t) => t.getBoundingClientRect().right > innerWidth).length);
  expect(clipped).toBe(0);
});
