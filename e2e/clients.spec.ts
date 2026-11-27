import { expect, test, type Page } from '@playwright/test';

// issue 174: every client of a window is live at once (no owner, no Work here). Runs on the chat fixture (4791).
const composer = (page: Page) => page.locator('#composer-input');
let seq = 0;
const uniq = (label: string) => `${label} ${Date.now().toString(36)}-${process.pid}-${seq++}`;
const bubble = (page: Page, text: string) => page.locator('[data-kind="user"]').filter({ hasText: text });

async function open(page: Page) {
  await page.goto('');
  await expect(composer(page)).toBeVisible();
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test('two pages of one window are both live: a send from either shows in both @chat', async ({ page, context }) => {
  await open(page);
  const second = await context.newPage();
  await open(second);
  const a = uniq('from the first');
  await send(page, a);
  await expect(bubble(second, a)).toBeVisible();
  await expect(page.locator('[data-kind="done"]').last()).toBeVisible();
  const b = uniq('from the second');
  await send(second, b);
  await expect(bubble(page, b)).toBeVisible();
  await expect(page.getByText(/already open in another tab/i)).toHaveCount(0);
  await second.close();
});

test('reloading a page while another is open keeps both working @chat', async ({ page, context }) => {
  await open(page);
  const second = await context.newPage();
  await open(second);
  await page.reload();
  await expect(composer(page)).toBeEnabled();
  const text = uniq('after a reload');
  await send(page, text);
  await expect(bubble(second, text)).toBeVisible();
  await expect(bubble(page, text)).toBeVisible();
  await second.close();
});
