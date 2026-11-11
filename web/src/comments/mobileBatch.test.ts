// The phone composes the batch with its own port (mobile/app/lib/comments/comments.dart, composeSend): this writes and
// checks what the desktop sends for a fixed set of comments in every app language, which the app's comments_test
// compares with its own. UPDATE_FIXTURES=1 rewrites the JSON after a deliberate change of either side.
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { generatedImages, isAttachmentAnchor, type Comment } from '@nota-bene/shared';
import { tIn, type Lang } from '@/i18n/index.ts';
import { composeBatch } from './compose.ts';
import { instructionOf, labelOf } from './labels.ts';
import { whereOf } from './send.ts';

const base = { status: 'pending' as const, createdAt: 1 };
const hex = (c: string) => c.repeat(64);
const comments: Record<string, Comment> = {
  text: {
    ...base, id: 'c-text', text: 'why twice?', label: 'clarify',
    anchor: { source: { kind: 'file', path: 'docs/plan.md' }, start: 0, end: 9, quote: 'the cache', prefix: '', suffix: '' },
  },
  pasted: {
    ...base, id: 'c-pasted', text: 'like these', images: [hex('a'), hex('b')],
    anchor: { source: { kind: 'file', path: 'docs/plan.md', ref: 'main' }, start: 0, end: 3, quote: 'two\nlines', prefix: '', suffix: '' },
  },
  image: {
    ...base, id: '11111111-1111-4111-8111-111111111111', text: 'this button', label: 'fire', images: [hex('c')], genImages: 1,
    anchor: {
      kind: 'media', source: { kind: 'file', path: 'img/shot.png' }, width: 1920, height: 1080, version: 'W/"1"',
      shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.42, y: 0.4, w: 0.16, h: 0.24 }, { kind: 'arrow', color: '#0a84ff', x1: 0.9, y1: 0.1, x2: 0.5, y2: 0.55 }],
    },
  },
  video: {
    ...base, id: '22222222-2222-4222-8222-222222222222', text: 'jumps here', images: [hex('d'), hex('e')], genImages: 1,
    anchor: {
      kind: 'media', source: { kind: 'file', path: 'video/demo.mp4', ref: 'feature' }, width: 720, height: 1280, time: 61.5,
      scale: 0.75, version: 'W/"old"', shapes: [{ kind: 'pen', color: '#ffffff', points: [0.1, 0.1, 0.2, 0.3, 0.25, 0.9] }],
    },
  },
  old: {
    ...base, id: '33333333-3333-4333-8333-333333333333', text: '', label: 'looks-good', images: [hex('f'), hex('0')],
    anchor: {
      kind: 'media', source: { kind: 'file', path: 'img/old.jpg' }, width: 7, height: 3,
      shapes: [{ kind: 'ellipse', color: '#ffcc00', x: 0, y: 0, w: 1, h: 1 }],
    },
  },
};
const cases: { name: string; general: string; items: string[] }[] = [
  ...Object.keys(comments).map((k) => ({ name: k, general: '', items: [k] })),
  { name: 'all', general: 'Please look', items: Object.keys(comments) },
];
const LANGS: [string, Lang][] = [['en', 'en'], ['ru', 'ru'], ['zh', 'zh-CN'], ['es', 'es'], ['pt', 'pt-BR'], ['de', 'de']];
const stale = new Set(['22222222-2222-4222-8222-222222222222']); // the video's current version differs from the drawn one

/** sendNow's numbering without a composer image and without composites: each comment's own images in order. */
function send(general: string, items: Comment[], lang: Lang) {
  const images: { id: string; label: string }[] = [];
  const refs = items.map((c, i) => {
    const all = c.images ?? [], gen = generatedImages(c);
    const own = [...all.slice(0, Math.min(1, gen)), ...all.slice(gen)];
    return own.map((id) => (images.push({ id, label: tIn(lang, 'imgLabelC', images.length + 1, i + 1) }), images.length));
  });
  const text = composeBatch(general, items, lang, (c) => labelOf(c, lang), (c) => whereOf(c), instructionOf, refs, (c) => stale.has(c.id));
  return { text, images };
}

it('the desktop side of the batch fixtures', () => {
  const data = {
    comments,
    stale: [...stale],
    cases: cases.map((c) => ({
      ...c,
      out: Object.fromEntries(LANGS.map(([app, web]) => [app, send(c.general, c.items.map((k) => comments[k]), web)])),
    })),
  };
  const out = path.resolve(__dirname, '../../../mobile/app/test/fixtures/batch/media.json');
  const json = JSON.stringify(data, null, 1) + '\n';
  if (process.env.UPDATE_FIXTURES) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
  }
  expect(json).toBe(fs.readFileSync(out, 'utf8'));
});

// Comments on a composer image (protocol 17). Kept in a file of its own so the phone's media test is unaffected until its
// side learns the kind; the composer holds two images, the attachment comments mark the second.
const composerImages = [hex('1'), hex('2')];
const onImage = (id: string, text: string, images: string[], o: Partial<Extract<Comment['anchor'], { kind: 'attachment' }>> = {}): Comment => ({
  ...base, id, text, images, genImages: 1,
  anchor: { kind: 'attachment', image: composerImages[1], width: 1200, height: 800, shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.25 }], ...o },
});
const attachments: Record<string, Comment> = {
  mark: onImage('44444444-4444-4444-8444-444444444444', 'this button', [hex('3')]),
  pasted: onImage('55555555-5555-4555-8555-555555555555', '', [hex('4'), hex('5')], {
    scale: 0.5, shapes: [{ kind: 'arrow', color: '#0a84ff', x1: 0.9, y1: 0.1, x2: 0.5, y2: 0.55 }, { kind: 'pen', color: '#ffffff', points: [0.1, 0.1, 0.2, 0.3, 0.25, 0.9] }],
  }),
};
// its image is not among the composer's: pending, but never part of a send (detached)
attachments.gone = onImage('66666666-6666-4666-8666-666666666666', 'was on another image', [hex('6')], { image: hex('9') });
const attCases = [
  ...Object.keys(attachments).map((k) => ({ name: k, general: '', items: [k] })),
  { name: 'all', general: 'Please look', items: ['text', ...Object.keys(attachments)] },
  { name: 'detachedOnly', general: 'hello', items: ['gone'] },
];
/** What a send takes of the pending items: an attachment comment only when its image is in the composer. */
const sendable = (c: Comment): boolean => !isAttachmentAnchor(c.anchor) || composerImages.includes(c.anchor.image);

/**
 * COUPLED to sendNow (web/src/comments/send.ts): the same numbering and the same filter (selectSendable); a change there is a
 * change here, and in the phone's composeSend. The composer's two images first, then each comment's own images in order. */
function sendWithComposer(general: string, items: Comment[], lang: Lang) {
  const images = composerImages.map((id, k) => ({ id, label: tIn(lang, 'imgLabel', k + 1) }));
  const refs = items.map((c, i) => {
    const all = c.images ?? [], gen = generatedImages(c);
    const own = [...all.slice(0, Math.min(1, gen)), ...all.slice(gen)];
    return own.map((id) => (images.push({ id, label: tIn(lang, 'imgLabelC', images.length + 1, i + 1) }), images.length));
  });
  const attNo = (id: string) => { const k = composerImages.indexOf(id); return k < 0 ? undefined : k + 1; };
  const text = composeBatch(general, items, lang, (c) => labelOf(c, lang), (c) => whereOf(c, undefined, attNo, lang), instructionOf, refs);
  return { text, images };
}

it('the desktop side of the attachment batch fixtures', () => {
  const all = { ...comments, ...attachments };
  const data = {
    composerImages,
    comments: { text: comments.text, ...attachments },
    cases: attCases.map((c) => ({
      ...c,
      // `sent`: the ids the send takes (the others stay pending); `out` is the batch of those only
      sent: c.items.map((k) => all[k]).filter(sendable).map((x) => x.id),
      out: Object.fromEntries(LANGS.map(([app, web]) => [app, sendWithComposer(c.general, c.items.map((k) => all[k]).filter(sendable), web)])),
    })),
  };
  const out = path.resolve(__dirname, '../../../mobile/app/test/fixtures/batch/attachment.json');
  const json = JSON.stringify(data, null, 1) + '\n';
  if (process.env.UPDATE_FIXTURES) fs.writeFileSync(out, json);
  expect(json).toBe(fs.readFileSync(out, 'utf8'));
});
