import { expect, test } from '@playwright/test';
import { apiGet, e2eControl } from './auth.ts';

// Issue 661: one window, one agent. A second agent on the chat fixture's folder, opened in its server (/control/open; the
// launcher would start a server of its own beside a --port one), has a page of its own: its strip has the chat's tab only, no
// tab of the folder's other agent and no +; ✕ in the chat's tab closes it and goes to the server's home. It closes only the
// agent it opened, so the fixture's own agent stays for the other specs.
test('a page shows one agent; ✕ in the chat\'s tab closes it and goes to the server\'s home @chat', async ({ page, baseURL }) => {
  await page.goto('');
  await expect(page.locator('#composer-input')).toBeVisible();
  const { root } = (await (await apiGet(page, 'info')).json()) as { root: string };
  const top = new URL(baseURL!).origin;
  const opened = await page.request.post(`${top}/control/open`, {
    data: { root, provider: 'claude', mode: 'new', show: false },
    headers: { 'x-nota-bene-control': e2eControl('chat') },
  });
  expect(opened.ok()).toBe(true);
  const { agent } = (await opened.json()) as { agent: string };
  await page.goto(`${top}/a/${agent}/`);
  await expect(page.locator('#composer-input')).toBeVisible();

  const x = page.getByRole('button', { name: /^Close this agent: / });
  await expect(x).toHaveCount(1);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab').getByRole('button', { name: /^Close this agent: / })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add an agent to this project' })).toHaveCount(0);

  await x.click();
  await page.getByRole('button', { name: 'Close this agent', exact: true }).click();
  await expect.poll(() => page.url()).toBe(`${top}/`);
  const { agents } = (await (await apiGet(page, 'info')).json()) as { agents: { id: string }[] };
  expect(agents.map((a) => a.id)).not.toContain(agent);
});
