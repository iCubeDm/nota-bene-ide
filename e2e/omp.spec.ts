import { test, expect } from '@playwright/test';
// Separate config reuses the serial test port after the Claude suite has shut down.
test('omp browser: ACP questions, an approval after a mode respawn, stable replay @omp', async ({ page }) => {
  await page.goto('/');
  const composer = page.getByPlaceholder(/Message the agent/);
  const pill = page.getByRole('button', { name: /mode/i }).filter({ hasText: /^Write$/ }); // a new project starts in Write, not omp's own Yolo
  await expect(pill).toBeVisible();
  await composer.fill('question'); await composer.press('Enter');
  await expect(page.getByLabel('Which colour?')).toBeVisible();
  await page.getByLabel('Which colour?').fill('Blue');
  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByText('Answer: Blue', { exact: true })).toBeVisible();

  await pill.click();
  await page.getByRole('menuitem', { name: /^Ask/ }).click();
  await expect(page.getByRole('button', { name: /mode/i }).filter({ hasText: /^Ask$/ })).toBeVisible();
  await composer.fill('run'); await composer.press('Enter');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('ran it', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText('Answer: Blue', { exact: true })).toBeVisible();
  await expect(page.getByText('ran it', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Which colour?')).toHaveCount(0);
});
