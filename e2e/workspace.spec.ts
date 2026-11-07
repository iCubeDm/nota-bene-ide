import { expect, test, type Page } from '@playwright/test';

// M6-16: the workspace frame of Package B and C in a real browser — strips, tab overflow, Alt+E, the hotkeys and
// the Settings tab. The `files` fixture (its project has docs/, src/, media/ and big.log).
const composer = (page: Page) => page.getByPlaceholder(/Message the agent|Сообщение агенту/);
const sheet = (page: Page) => page.locator('#tree-sheet');
const comments = (page: Page) => page.locator('#comments');
const strip = (page: Page) => page.getByRole('tablist');
const activeTab = (page: Page) => strip(page).locator('[aria-selected="true"]');

async function start(page: Page) {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  // a clean frame: both panels open (the default), only the chat tab
  if (await sheet(page).isHidden()) await page.locator('#toggleTree').click();
  if (await comments(page).isHidden()) await page.locator('#toggleComments').click();
  await page.keyboard.press('Escape');
  for (;;) {
    const n = await strip(page).locator('[data-tab]').count();
    if (n <= 1) break;
    await strip(page).locator('[data-tab]').nth(1).getByRole('button', { name: /^(Close|Закрыть)$/ }).click();
  }
}
/** Expands the whole tree and opens the given files, in order. */
async function open(page: Page, paths: string[]) {
  await page.getByRole('button', { name: /^(Expand all|Развернуть всё)$/ }).click();
  for (const p of paths) {
    await sheet(page).locator(`button[data-path="${p}"]`).click();
    await expect(activeTab(page)).toHaveAttribute('data-tab', `file:${p}`);
  }
}
/** Focus on empty space (the active pane), so plain keys and Option combos are ours. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test('the strips toggle their panels by click and by Ctrl/⌘+Shift+F / C, and the state survives a reload @files', async ({ page }) => {
  await start(page);
  await expect(sheet(page)).toBeVisible();
  await blur(page);
  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(sheet(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Shift+KeyC');
  await expect(comments(page)).toBeHidden();
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(sheet(page)).toBeHidden();
  await expect(comments(page)).toBeHidden();
  await page.locator('#toggleTree').click();
  await page.locator('#toggleComments').click();
  await expect(sheet(page)).toBeVisible();
  await expect(comments(page)).toBeVisible();
});

test('tab overflow: no scrollbar, the active tab stays in view, ▾ lists the hidden ones and opens one by search @files', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 }); // the docked panels leave a narrow middle column
  await start(page);
  const files = ['big.log', 'src/a.ts', 'docs/pic.png', 'docs/big.png', 'docs/Отчёт #1 (final).md'];
  await open(page, files);
  const m = await strip(page).evaluate((el) => ({ over: el.scrollWidth > el.clientWidth, bar: (el as HTMLElement).offsetHeight - el.clientHeight }));
  expect(m.over).toBe(true);
  expect(m.bar).toBe(0);
  // the active (last) tab is fully inside the strip
  const inView = () => strip(page).evaluate((el) => {
    const a = el.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
    const s = el.getBoundingClientRect();
    return a.left >= s.left - 1 && a.right <= s.right + 1;
  });
  expect(await inView()).toBe(true);
  // the wheel scrolls the strip back
  await strip(page).hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => strip(page).evaluate((el) => el.scrollLeft)).toBe(0);
  // ▾: the hidden section names the tabs out of view; a search and Enter open one, and it is scrolled into view
  await page.getByRole('button', { name: /^(All tabs|Все вкладки)$/ }).click();
  const list = page.getByRole('listbox', { name: /^(All tabs|Все вкладки)$/ });
  await expect(list.getByText(/^(Hidden|Скрытые)$/)).toBeVisible();
  await page.getByRole('combobox', { name: /^(Find a tab…|Найти вкладку…)$/ }).fill('final');
  await expect(list.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(activeTab(page)).toHaveAttribute('data-tab', 'file:docs/Отчёт #1 (final).md');
  await expect.poll(inView).toBe(true); // it was active already: the pick itself scrolls it back into view
  // the focus went to that tab, not to <body>
  await expect(activeTab(page)).toBeFocused();
});

test('Alt+E: the recent files with the previous one selected; Enter flips back; a query searches the project @files', async ({ page }) => {
  await start(page);
  // a tab counts as visited once it stays active 300 ms
  await open(page, ['src/a.ts']);
  await page.waitForTimeout(400);
  await open(page, ['big.log']);
  await page.waitForTimeout(400);
  await page.keyboard.press('Alt+KeyE');
  const list = page.getByRole('listbox', { name: /^(Recent files|Недавние файлы)/ });
  await expect(list.getByRole('option').first()).toHaveAttribute('data-recent', 'big.log');
  await expect(list.getByRole('option', { selected: true })).toHaveAttribute('data-recent', 'src/a.ts');
  await page.keyboard.press('Enter');
  await expect(activeTab(page)).toHaveAttribute('data-tab', 'file:src/a.ts');
  await page.keyboard.press('Alt+KeyE');
  await page.keyboard.type('pic');
  await expect(list.locator('[data-recent="docs/pic.png"]')).toBeVisible(); // from /complete, never opened
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  // from the composer too, and nothing is typed there
  await composer(page).click();
  await page.keyboard.press('Alt+KeyE');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(composer(page)).toHaveValue('');
});

test('the interface scale: the settings menu steps it and stays open, Alt+= / Alt+0 step it, Settings → Defaults picks it; a reload keeps it @files', async ({ page }) => {
  await start(page);
  const body = () => page.evaluate(() => getComputedStyle(document.body).fontSize);
  expect(await body()).toBe('14px');
  const pick = page.getByRole('combobox', { name: /^(Interface scale|Масштаб интерфейса)$/ });
  try {
    await page.locator('#settingsBtn').click();
    await page.locator('#scaleUp').click();
    await expect.poll(body).toBe('15.4px'); // 110 %
    await expect(page.locator('#scaleValue')).toBeVisible(); // the menu stayed open
    await page.keyboard.press('Escape');
    await blur(page);
    await page.keyboard.press('Alt+Equal');
    await expect.poll(body).toBe('17.5px'); // 125 %
    await page.keyboard.press('Alt+Digit0');
    await expect.poll(body).toBe('14px');
    await page.locator('#settingsBtn').click();
    await page.locator('#allSettings').click();
    await pick.selectOption('1.25');
    await expect.poll(body).toBe('17.5px');
    if (process.env.NB_SCALE_SHOTS) await page.screenshot({ path: `${process.env.NB_SCALE_SHOTS}/settings-125.png` });
    await page.reload();
    await expect(composer(page)).toBeVisible();
    expect(await body()).toBe('17.5px');
    if (process.env.NB_SCALE_SHOTS) {
      await page.locator('#settingsBtn').click();
      await page.locator('#langMenu').hover();
      await page.screenshot({ path: `${process.env.NB_SCALE_SHOTS}/menu-125.png` });
      await page.keyboard.press('Escape');
    }
  } finally {
    // the fixture's prefs are shared by the other tests: back to 100 %
    await page.keyboard.press('Escape');
    await blur(page);
    await page.keyboard.press('Alt+Digit0');
  }
  await expect.poll(body).toBe('14px');
});

// Themes: the chat fixture's reply "show me" holds a code block and a mermaid block (the files fixture has neither).
test('themes: the gear menu and Settings pick one, a reload keeps it, nothing keeps the old colours @chat', async ({ page }) => {
  await start(page);
  await composer(page).fill(`show me themes ${Date.now().toString(36)}`);
  await composer(page).press('Enter');
  await expect(page.locator('pre code .hljs-keyword').last()).toBeVisible();
  await expect(page.locator('.mermaid-out svg').last()).toBeVisible();
  const attr = () => page.evaluate(() => document.documentElement.dataset.theme);
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  /** Colours of the pieces that must follow the theme, as one record. */
  const sample = () => page.evaluate(() => {
    const css = (sel: string, prop: 'color' | 'backgroundColor') => {
      const el = document.querySelectorAll(sel).item(document.querySelectorAll(sel).length - 1);
      return el ? getComputedStyle(el)[prop] : 'missing';
    };
    return {
      card: css('.nb-card', 'backgroundColor'),
      keyword: css('pre code .hljs-keyword', 'color'),
      diagram: css('.mermaid-out', 'backgroundColor'),
      composer: css('textarea', 'backgroundColor') + '|' + css('textarea', 'color'),
      sessions: css('#sessBtn svg', 'color'),
    };
  });
  expect(await attr()).toBe('darcula');
  expect(await bodyBg()).toBe('rgb(43, 43, 43)');
  const darcula = await sample();
  try {
    await page.locator('#settingsBtn').click();
    await page.locator('#themeMenu').focus(); // a submenu of the settings menu: the keyboard opens it
    await page.keyboard.press('ArrowRight');
    await page.locator('[data-theme-id="plannotator"]').focus();
    await page.keyboard.press('Enter');
    await expect.poll(attr).toBe('plannotator');
    await page.keyboard.press('Escape');
    const body = await bodyBg();
    expect(body).not.toBe('rgb(43, 43, 43)');
    const plannotator = await sample();
    for (const k of Object.keys(darcula) as (keyof typeof darcula)[]) expect(plannotator[k], k).not.toBe(darcula[k]);
    await page.reload();
    await expect(composer(page)).toBeVisible();
    expect(await attr()).toBe('plannotator');
    expect(await bodyBg()).toBe(body);
    // a light theme: the colour scheme says light and every sampled piece has its own colour
    await page.locator('#settingsBtn').click();
    await page.locator('#themeMenu').focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('[data-theme-id="solarized-light"]').focus();
    await page.keyboard.press('Enter');
    await expect.poll(attr).toBe('solarized-light');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
    const solarized = await sample();
    for (const k of Object.keys(darcula) as (keyof typeof darcula)[]) expect(solarized[k], k).not.toBe(darcula[k]);
    // its dark counterpart: no light colour scheme, and every sampled piece differs from both
    await page.locator('#settingsBtn').click();
    await page.locator('#themeMenu').focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('[data-theme-id="solarized-dark"]').focus();
    await page.keyboard.press('Enter');
    await expect.poll(attr).toBe('solarized-dark');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).not.toBe('light');
    const solarizedDark = await sample();
    for (const k of Object.keys(darcula) as (keyof typeof darcula)[]) {
      expect(solarizedDark[k], k).not.toBe(darcula[k]);
      expect(solarizedDark[k], k).not.toBe(solarized[k]);
    }
  } finally {
    // the fixture's prefs are shared by the other tests: back to Darcula, picked in Settings → Themes
    await page.keyboard.press('Escape');
    await page.locator('#settingsBtn').click();
    await page.locator('#allSettings').click();
    await page.getByRole('radiogroup', { name: 'Themes' }).getByRole('radio', { name: 'Darcula' }).click();
  }
  await expect.poll(attr).toBe('darcula');
  expect(await bodyBg()).toBe('rgb(43, 43, 43)');
  // the swatch paints its own theme's colours while the page is Darcula
  const cardSpan = page.getByRole('radiogroup', { name: 'Themes' }).locator('[data-theme="solarized-light"] [data-swatch="--card"]');
  expect(await cardSpan.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(253, 246, 227)');
});

test('a light theme on a dark OS keeps light colours @chat', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await start(page);
  const attr = () => page.evaluate(() => document.documentElement.dataset.theme);
  const pick = async (id: string) => {
    await page.locator('#settingsBtn').click();
    await page.locator('#themeMenu').focus();
    await page.keyboard.press('ArrowRight');
    await page.locator(`[data-theme-id="${id}"]`).focus();
    await page.keyboard.press('Enter');
    await expect.poll(attr).toBe(id);
    await page.keyboard.press('Escape');
  };
  /** A ghost button (hover:bg-accent, dark:hover:bg-accent/50) probed on its own, and the document's colour scheme. */
  const probe = () => page.evaluate(() => {
    const b = document.createElement('button');
    b.className = 'inline-flex items-center hover:bg-accent dark:hover:bg-accent/50';
    b.textContent = 'probe';
    b.id = 'themeProbe';
    b.style.cssText = 'position:fixed;top:40px;left:40px;z-index:9999;padding:8px';
    const d = document.createElement('button');
    d.className = 'bg-destructive-fill';
    d.id = 'destructiveProbe';
    d.style.cssText = 'position:fixed;top:90px;left:40px;z-index:9999;padding:8px';
    document.body.append(b, d);
    return getComputedStyle(document.documentElement).colorScheme;
  });
  const hoverBg = async () => {
    await page.locator('#themeProbe').hover();
    return page.locator('#themeProbe').evaluate((el) => getComputedStyle(el).backgroundColor);
  };
  try {
    await pick('intellij-light');
    expect(await probe()).toBe('light');
    const onDarkOs = await hoverBg();
    await page.emulateMedia({ colorScheme: 'light' });
    const onLightOs = await hoverBg();
    expect(onDarkOs).toBe(onLightOs); // the dark: variant stayed out of the light theme
    await page.emulateMedia({ colorScheme: 'dark' });
    // the destructive fill is the opaque --destructive colour, not a translucent mix
    const fill = await page.locator('#destructiveProbe').evaluate((el) => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--destructive)';
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return { bg: getComputedStyle(el).backgroundColor, want };
    });
    expect(fill.bg).toBe(fill.want);
    expect(fill.bg).toMatch(/^rgb\(/);
    await pick('darcula');
    const darculaDarkOs = await hoverBg();
    await page.emulateMedia({ colorScheme: 'light' });
    expect(darculaDarkOs).not.toBe(await hoverBg()); // the dark: variant does apply in a dark theme on a dark OS
  } finally {
    await page.emulateMedia({ colorScheme: null });
    await page.keyboard.press('Escape');
    await page.locator('#settingsBtn').click();
    await page.locator('#allSettings').click();
    await page.getByRole('radiogroup', { name: 'Themes' }).getByRole('radio', { name: 'Darcula' }).click();
  }
  await expect.poll(attr).toBe('darcula');
});
