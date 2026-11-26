import type { Locator } from '@playwright/test';

/**
 * A message field's text as it shows (issue 724): its lines, without the placeholder. Marks the field hides away from the
 * caret (`**`, a fence) are not in it; read what was sent to check those.
 */
export const fieldText = (field: Locator): Promise<string> => field.evaluate((el) =>
  [...el.querySelectorAll('.cm-line')].map((line) => {
    const copy = line.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.cm-placeholder, .cm-widgetBuffer').forEach((n) => n.remove());
    return copy.textContent ?? '';
  }).join('\n'));
