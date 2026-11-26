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

test('an empty composer is one line high, its placeholder cut rather than wrapped @chat', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 }); // narrow: the placeholder is longer than the field
  await page.goto('');
  const field = page.getByTestId('field-box').first();
  await expect(composer(page)).toBeVisible();
  expect(await fieldText(composer(page))).toBe('');
  const line = (await composer(page).locator('.cm-line').first().boundingBox())!.height;
  // one line of text plus the box's padding and border, never two
  expect((await field.boundingBox())!.height).toBeLessThan(line * 1.5 + 20);
  expect((await composer(page).locator('.cm-placeholder').boundingBox())!.height).toBeLessThanOrEqual(line);
});

test('Tab nests a list item and the format bar bolds a selection; the markdown is what is sent (issue 727) @chat', async ({ page }) => {
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
  const word = `nest${Date.now().toString(36)}`;
  await page.keyboard.type('- a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type(word);
  await expect(box).toBeFocused(); // Tab nested the item rather than leave the field
  for (let i = 0; i < word.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('toolbar', { name: 'Format' }).getByRole('button', { name: 'Bold' }).click();
  await expect(box.locator('.nb-md-strong')).toHaveText(word);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent).toContain(`- a\n  - **${word}**`);
});
