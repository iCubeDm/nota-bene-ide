import { isAttachmentAnchor, isCutAnchor, isMediaAnchor, isPageAnchor, isTextAnchor, type Comment } from '@nota-bene/shared';
import { tIn, type Lang } from '../i18n/index.ts';
import { describeShape } from '../media/markup/geometry.ts';
import { pageLines } from '../page/quote.ts';
import { cutQuote } from '../cut/quote.ts';

/**
 * The text sent to the agent: the general message, then the numbered comment list (prototype format).
 * Pure: everything that depends on app state arrives as an argument.
 * @param labelOf quick-label emoji + text for a comment, '' when it has none
 * @param whereOf where the quoted fragment lives ("reply", "my message")
 * @param instructionOf the quick label's instruction line, if any
 */
export function composeBatch(
  general: string,
  items: Comment[],
  lang: Lang,
  labelOf: (c: Comment) => string,
  whereOf: (c: Comment) => string,
  instructionOf: (c: Comment) => string | undefined,
  /** refs[i] = the global numbers of comment i's images; adds the `imgRef` line under that comment */
  refs: number[][] = [],
  /** media comments only: the file has changed since the mark was drawn (known current version differs) */
  staleOf: (c: Comment) => boolean = () => false,
  /** shared[i] = for a comment whose image is a composite shared with others: that image's number and all the sharing comments' numbers */
  shared: ({ k: number; cs: number[] } | undefined)[] = [],
  /** a cut comment (issue 430): its clip is no longer in the edit, or a trim cut its moment out (the time is the clip's nearest end) */
  cutNote: (c: Comment) => 'gone' | 'trimmed' | undefined = () => undefined,
): string {
  if (!items.length) return general;
  const blocks = items.map((c, i) => {
    const a = c.anchor;
    const quote = isMediaAnchor(a) || isAttachmentAnchor(a)
      ? a.shapes.map((s) => '> ' + describeShape(s, a.width, a.height)).join('\n')
      : isPageAnchor(a) ? pageLines(a, lang).map((l) => '> ' + l).join('\n')
      : isCutAnchor(a) ? '> ' + cutQuote(a, lang)
      : isTextAnchor(a) ? a.quote.split('\n').map((l) => '> ' + l).join('\n')
      : ''; // a kind this client does not know: no quote
    let tail = '';
    if (isMediaAnchor(a)) {
      const sfx = a.scale ? tIn(lang, 'scaledSfx', a.scale) : '';
      const dir = `.nota-bene/marks/${c.id}`;
      if (shared[i]) {
        tail += '\n' + tIn(lang, 'imgRefShared', shared[i].k, shared[i].cs);
        if (refs[i].length > 1) tail += '\n' + tIn(lang, 'imgRef', refs[i].slice(1)); // pasted images after the shared one
      }
      else if (refs[i]?.length) tail += '\n' + tIn(lang, 'imgRefMedia', refs[i]);
      const masked = a.shapes.some((s) => s.kind === 'polygon'); // issue 447: the drawing's polygons as a mask
      tail += '\n' + tIn(lang, 'filesLine', [`${dir}/frame.jpg${sfx}`, `${dir}/layer.png${sfx}`, ...(masked ? [`${dir}/mask.png${sfx}`] : [])]);
      if (masked) tail += '\n' + tIn(lang, 'maskLine');
      if (staleOf(c)) tail += '\n' + tIn(lang, 'markStale');
    } else if (isCutAnchor(a)) {
      if (refs[i]?.length) tail += '\n' + tIn(lang, 'imgRef', refs[i]);
      const note = cutNote(c);
      if (note) tail += '\n' + tIn(lang, note === 'gone' ? 'cutClipGone' : 'cutTrimmedOut');
    } else if (refs[i]?.length) tail = '\n' + tIn(lang, isAttachmentAnchor(a) ? 'imgRefMedia' : 'imgRef', refs[i]); // an attachment's first image is its marked composite (no files on disk)
    // the recordings' transcripts follow what was typed, each on a line of its own (one line each: a transcript's breaks are spaces)
    const clips = (c.voice ?? []).map((v) => v.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const [head = '', ...more] = [[labelOf(c), c.text.trim()].filter(Boolean).join(' '), ...clips].filter(Boolean);
    const instr = instructionOf(c);
    // no words at all (images alone, issue 497): the first line of the tail takes the arrow
    const body = head ? `${head}${more.map((l) => `\n   ${l}`).join('')}${instr ? `\n   ${instr}` : ''}${tail}` : tail.slice(1);
    // no quote (a comment on the whole picture, issue 494): no line for it
    return `${i + 1}. [${whereOf(c)}]\n${quote ? `${quote}\n` : ''}→ ${body}`;
  });
  return `${general ? general + '\n\n' : ''}${tIn(lang, 'batchHead')}\n\n${blocks.join('\n\n')}`;
}
