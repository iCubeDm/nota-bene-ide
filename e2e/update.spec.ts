import { expect, test, type Page } from '@playwright/test';
import { en } from '../web/src/i18n/en.ts';

// The header's update notice in a real browser. The server's /system/update* routes are stubbed: the page only shows
// what the status says and posts install / restart, so no release is installed and the shared server never exits.
const composer = (page: Page) => page.getByPlaceholder(/Message the agent/);
const base = { current: '1.98.0', latest: '1.99.0', canUpdate: true, auto: false, busy: false, log: '/state/runtime/update.log' };

type Status = typeof base & { phase: string; failed?: string };
async function stub(page: Page, first: Status): Promise<{ set(s: Status): void; posts: string[] }> {
  let status = first;
  const posts: string[] = [];
  await page.route('**/system/update**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (r.request().method() === 'POST') {
      posts.push(path);
      if (path.endsWith('/install')) status = { ...status, phase: 'installing' };
      return r.fulfill({ contentType: 'application/json', body: path.endsWith('/install') ? JSON.stringify(status) : '{"ok":true}' });
    }
    if (path.endsWith('/changes')) return r.fulfill({ contentType: 'application/json', body: '{"text":null}' });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(status) });
  });
  return { set: (s) => void (status = s), posts };
}

test('available → Update → installing → ready restarts in a pause @chat', async ({ page }) => {
  const s = await stub(page, { ...base, phase: 'available' });
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await page.getByRole('button', { name: '↑ 1.99.0' }).click();
  await expect(page.getByRole('checkbox', { name: en.updateAuto })).toBeVisible();
  await page.getByRole('button', { name: en.updateNow, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: en.updateInstalling('1.99.0') })).toBeVisible();
  expect(s.posts).toContain('/system/update/install');
  s.set({ ...base, phase: 'ready' }); // the page asks every 2 s while installing
  await expect(page.getByText(en.updateReady('1.99.0'))).toBeVisible();
  await expect.poll(() => s.posts.includes('/system/update/restart')).toBe(true); // idle, empty composer: it asks for the restart
});

test('ready with a draft waits until the composer is empty; failed names the log @chat', async ({ page }) => {
  const s = await stub(page, { ...base, phase: 'available' });
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await composer(page).fill('half a thought');
  s.set({ ...base, phase: 'ready' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // the page asks again on focus
  await expect(page.getByText(en.updateReady('1.99.0'))).toBeVisible();
  await page.waitForTimeout(1500);
  expect(s.posts).not.toContain('/system/update/restart'); // a draft: not a pause
  await composer(page).fill('');
  await expect.poll(() => s.posts.includes('/system/update/restart')).toBe(true);

  s.set({ ...base, phase: 'failed', failed: 'npm install exited with 1' });
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await page.getByRole('button', { name: en.updateFailed }).click();
  await expect(page.getByText(en.updateLog('/state/runtime/update.log'))).toBeVisible();
});
