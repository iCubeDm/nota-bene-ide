import { describe, expect, it } from 'vitest';
import { uniqueCutName } from './cut.ts';

describe('uniqueCutName (issue 426)', () => {
  it('edit.nbcut.json, then edit 2.nbcut.json and on, case-insensitively', () => {
    expect(uniqueCutName([])).toBe('edit.nbcut.json');
    expect(uniqueCutName(['a.mp4', 'Edit.nbcut.json'])).toBe('edit 2.nbcut.json');
    expect(uniqueCutName(['edit.nbcut.json', 'edit 2.nbcut.json', 'edit 4.nbcut.json'])).toBe('edit 3.nbcut.json');
  });
});
