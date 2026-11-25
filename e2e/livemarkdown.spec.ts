import { expect, test, type Page } from '@playwright/test';
import { fieldText } from './field.ts';

const composer = (page: Page) => page.getByRole('textbox', { name: /Message the agent|Сообщение агенту/ });

test('the composer draws markdown as it is typed and sends the markdown itself (issue 724) @chat', async ({ page }) => {
  const sent: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    try {
      const m = JSON.parse(String(f.payload)) as { type?: string; text?: string };
      if (m.type === 'send' && m.text) sent.push(m.text);
    } catch { /* not JSON */ }
  }));
  await page.goto('');
  const box = composer(page);
  await box.click();
  const word = `done${Date.now().toString(36)}`;
  // ``` opens a block as in Slack: the closing fence goes in, Enter is a newline there, Enter on an empty last line leaves
  await page.keyboard.type('```');
  await page.keyboard.type('let a = 1');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(box.locator('.nb-md-block')).not.toHaveCount(0);
  expect(await fieldText(box)).not.toContain('```'); // the caret left the block: its fences hide
  await page.keyboard.type(`**${word}**`);
  await expect(box.locator('.nb-md-strong')).toHaveText(word);
  await page.keyboard.press('Enter');
  await expect.poll(() => sent).toContain(`\`\`\`\nlet a = 1\n\`\`\`\n**${word}**`);
  await expect.poll(() => fieldText(box)).toBe('');
});
