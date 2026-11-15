import { expect, it } from 'vitest';
import { alignedLeft } from './tabAlign.ts';

it('the branch starts where the first tab does, and never over the project block', () => {
  // header at x 0; the tabs start at 637; the project block ends at 460
  expect(alignedLeft({ header: 0, tabs: 637, block: 460 })).toBe(637);
  // a wide block (a long name) past the tabs' edge: the branch keeps a gap after it
  expect(alignedLeft({ header: 0, tabs: 637, block: 700 })).toBe(712);
  // the header's own left is the origin
  expect(alignedLeft({ header: 10, tabs: 637, block: 460 })).toBe(627);
  // no tab strip (not laid out yet): right after the block
  expect(alignedLeft({ header: 0, tabs: null, block: 460 })).toBe(472);
});
