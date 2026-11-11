import { expect, it } from 'vitest';
import type { Comment, MediaAnchor } from '@nota-bene/shared';
import { composeBatch } from './compose.ts';

const c = (id: string, quote: string, text: string, label?: Comment['label']): Comment => ({
  id, text, label, status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'message', id }, start: 0, end: quote.length, quote, prefix: '', suffix: '' },
});
const where = (x: Comment) => (x.id === 'u' ? 'my message' : 'reply');
const none = () => '';

it('general text first, then the header and numbered items', () => {
  const out = composeBatch('Please fix', [c('a', 'foo', ' bar '), c('u', 'baz', 'qux')], 'en', none, where, () => undefined);
  expect(out).toBe('Please fix\n\nComments on fragments:\n\n1. [reply]\n> foo\n→ bar\n\n2. [my message]\n> baz\n→ qux');
});

it('omits the leading blank when general is empty; header follows the lang', () => {
  expect(composeBatch('', [c('a', 'x', 'y')], 'ru', none, where, () => undefined)).toMatch(/^Комментарии к фрагментам:\n\n1\./);
});

it('multi-line quotes are each prefixed with "> "', () => {
  const out = composeBatch('', [c('a', 'l1\nl2', 'y')], 'en', none, where, () => undefined);
  expect(out).toContain('> l1\n> l2\n→ y');
});

it('a quick label adds its emoji, text and instruction', () => {
  const out = composeBatch('', [c('a', 'q', '', 'verify')], 'en', () => '🔍 verify', where, () => 'Check this against the code.');
  expect(out).toContain('→ 🔍 verify\n   Check this against the code.');
  const out2 = composeBatch('', [c('a', 'q', 'why?', 'verify')], 'en', () => '🔍 verify', where, () => undefined);
  expect(out2).toContain('→ 🔍 verify why?');
});

it('no comments → general text unchanged', () => {
  expect(composeBatch('just text', [], 'en', none, where, () => undefined)).toBe('just text');
});

it('refs append the imgRef line under the comment, in the batch language', () => {
  const out = composeBatch('', [c('a', 'q', 'y'), c('b', 'q2', 'z')], 'en', none, where, () => undefined, [[2, 3], []]);
  expect(out).toContain('→ y\n📎 images: 2, 3\n\n2. ');
  expect(out).not.toContain('z\n📎');
  expect(composeBatch('', [c('a', 'q', 'y')], 'ru', none, where, () => undefined, [[1]])).toContain('→ y\n📎 изображения: 1');
});

const media = (id: string, text: string, o: Partial<MediaAnchor> = {}): Comment => ({
  id, text, status: 'pending', createdAt: 1,
  anchor: {
    kind: 'media', source: { kind: 'file', path: 'media/scene_v6.png' }, width: 1920, height: 1080,
    shapes: [
      { kind: 'rect', color: '#ff3b30', x: 0.42, y: 0.4, w: 0.16, h: 0.24 },
      { kind: 'pen', color: '#ff3b30', points: [0.3, 0.5, 0.4, 0.58] },
    ], ...o,
  },
});
const mwhere = () => 'media/scene_v6.png · 1920×1080';

it('a media comment: shape lines, image labels, files', () => {
  const out = composeBatch('', [media('m1', 'The character sits here')], 'en', none, mwhere, () => undefined, [[4]]);
  expect(out).toBe(
    'Comments on fragments:\n\n1. [media/scene_v6.png · 1920×1080]\n' +
    '> rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)\n' +
    '> pen 2 pts, bbox x=0.3 y=0.5 w=0.1 h=0.08 (px 576,540 192×86)\n' +
    '→ The character sits here\n' +
    '📎 images: 4 (frame with marks)\n' +
    '   files: .nota-bene/marks/m1/frame.jpg, .nota-bene/marks/m1/layer.png',
  );
});

it('media: scaled files, changed file line, pasted images after the labelled ones; ru keeps the format', () => {
  const out = composeBatch('', [media('m1', 'x', { scale: 0.75 })], 'en', none, mwhere, () => undefined, [[1, 2, 3]], () => true);
  expect(out).toContain('📎 images: 1 (frame with marks), 2, 3\n');
  expect(out).toContain('   files: .nota-bene/marks/m1/frame.jpg (scaled ×0.75), .nota-bene/marks/m1/layer.png (scaled ×0.75)\n   (marked on an earlier version of the file; the frame shows it)');
  const ru = composeBatch('', [media('m1', 'x', { scale: 0.75 })], 'ru', none, mwhere, () => undefined, [[4]], () => true);
  expect(ru).toContain('📎 картинки: 4 (кадр с разметкой)\n   файлы: .nota-bene/marks/m1/frame.jpg (уменьшен ×0.75), .nota-bene/marks/m1/layer.png (уменьшен ×0.75)\n   (отмечено на более ранней версии файла; кадр это показывает)');
});

it('a page place is quoted as its trail, the area and what it covers, then its element path, in the batch language', () => {
  const page = (box?: boolean): Comment => ({
    id: 'p', text: 'add a road', status: 'pending', createdAt: 1,
    anchor: {
      kind: 'page', source: { kind: 'file', path: 'docs/map.html' }, selector: 'body>:nth-child(6)', trail: ['h2 «Map»', 'svg#map «Town»'],
      ...(box ? { box: { x: 100, y: 60, w: 60, h: 80 }, near: ['g.node «Mill»', 'g.node «Market»'] } : {}),
    },
  });
  const fileWhere = () => 'docs/map.html';
  expect(composeBatch('', [page(true)], 'en', none, fileWhere, () => undefined)).toContain([
    '1. [docs/map.html]', '> h2 «Map» › svg#map «Town»', '> area x 100, y 60, 60×80 (viewBox units)',
    '> covers or is next to: g.node «Mill», g.node «Market»', '> element: body>:nth-child(6)', '→ add a road',
  ].join('\n'));
  expect(composeBatch('', [page()], 'ru', none, fileWhere, () => undefined)).toContain('> h2 «Map» › svg#map «Town»\n> элемент: body>:nth-child(6)\n→ add a road');
});

const clip = (text: string, n = 1) => ({ id: String(n).repeat(64), ms: 1000 * n, wave: new Array<number>(48).fill(n), text });

it('the clips\' texts follow the typed text, each on its own line, in order', () => {
  const x = { ...c('a', 'q', 'typed'), voice: [clip('first clip', 1), clip('second\nclip', 2)] };
  const out = composeBatch('', [x], 'en', none, where, () => undefined);
  expect(out).toContain('→ typed\n   first clip\n   second clip');
});

it('a comment of clips only composes: the first clip is on the arrow line', () => {
  const x = { ...c('a', 'q', ''), voice: [clip('one', 1), clip('two', 2)] };
  expect(composeBatch('', [x], 'en', none, where, () => undefined)).toContain('→ one\n   two');
});

it('clips follow the label and typed text, and come before the instruction and the image line', () => {
  const x = { ...c('a', 'q', 'why', 'verify'), voice: [clip('and this', 1)] };
  const out = composeBatch('', [x], 'en', () => '🔍 verify', where, () => 'Check this.', [[2]]);
  expect(out).toContain('→ 🔍 verify why\n   and this\n   Check this.\n📎 images: 2');
});

it('a clip with no text (a failed transcript that was kept) adds nothing', () => {
  const x = { ...c('a', 'q', 'typed'), voice: [clip('', 1)] };
  expect(composeBatch('', [x], 'en', none, where, () => undefined)).toContain('→ typed');
  expect(composeBatch('', [x], 'en', none, where, () => undefined)).not.toContain('typed\n');
});

it('an attachment comment: shape lines and the image refs, no files line, no stale line', () => {
  const a: Comment = {
    id: 'att1', text: 'this button', status: 'pending', createdAt: 1,
    anchor: { kind: 'attachment', image: 'a'.repeat(64), width: 1200, height: 800, scale: 0.5, shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] },
  };
  const out = composeBatch('', [a], 'en', none, () => 'image 2 · 1200×800', () => undefined, [[4, 5]], () => true);
  expect(out).toContain('1. [image 2 · 1200×800]\n> ');
  expect(out).toContain('→ this button\n📎 images: 4 (frame with marks), 5');
  expect(out).not.toContain('.nota-bene');
  expect(out).not.toContain('earlier version');
});

it('an anchor of a kind this client does not know composes without a quote and does not throw', () => {
  const x = { id: 'f', text: 'hm', status: 'pending', createdAt: 1, anchor: { kind: 'future', thing: 1 } } as unknown as Comment;
  expect(composeBatch('', [x], 'en', none, () => 'somewhere', () => undefined)).toBe('Comments on fragments:\n\n1. [somewhere]\n\n→ hm');
});
