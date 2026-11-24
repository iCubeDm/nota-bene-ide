import { expect, test } from '@playwright/test';
import { apiGet } from './auth.ts';

// Issue 661: one window, one agent. A second agent on the chat fixture's folder (4791) gets a page of its own: its strip has
// the chat's tab only, no tab of the folder's other agent and no +; ✕ in the chat's tab closes it and goes to the home page.
// It closes only the agent it opened, so the fixture's own agent stays for the other specs.
test('a page shows one agent; ✕ in the chat\'s tab closes it and goes to the server\'s home @chat', async ({ page, baseURL }) => {
  await page.goto('');
  await expect(page.locator('#composer-input')).toBeVisible();
  const { root } = (await (await apiGet(page, 'info')).json()) as { root: string };
  const key = await page.evaluate(() => localStorage.getItem('nb.key'));
  const opened = await page.request.post('system/projects/open', {
    data: { dir: root, provider: 'claude', new: true },
    headers: { 'x-nota-bene-key': key!, origin: new URL(baseURL!).origin },
  });
  expect(opened.ok()).toBe(true);
  const { url } = (await opened.json()) as { url: string };
  const agent = /\/a\/([^/]+)\//.exec(url)![1]!;
  await page.goto(url);
  await expect(page.locator('#composer-input')).toBeVisible();

  const x = page.getByRole('button', { name: /^Close this agent: / });
  await expect(x).toHaveCount(1);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab').getByRole('button', { name: /^Close this agent: / })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add an agent to this project' })).toHaveCount(0);

  await x.click();
  await page.getByRole('button', { name: 'Close this agent', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  const { agents } = (await (await apiGet(page, 'info')).json()) as { agents: { id: string }[] };
  expect(agents.map((a) => a.id)).not.toContain(agent);
});
