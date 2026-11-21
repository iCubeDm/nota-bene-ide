import { AUDIO, IMAGE, VIDEO, isPath } from '../refs/kinds.ts';

/** Set a textarea's value through the native setter and fire a bubbling `input`, so a controlled React textarea picks it up. */
export function setValueAndCaret(ta: HTMLTextAreaElement, value: string, caret: number): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value);
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** An `@mention` being typed (copied from the prototype): `@` at a word start, up to the caret. */
export const AT_RE = /(^|\s)@("[^"]*|[^\s"]*)$/;

/** `p` as an inline code span: a fence longer than any run of backticks in it, padded when it starts or ends with one. */
function codeSpan(p: string): string {
  const longest = Math.max(0, ...[...p.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = p.startsWith('`') || p.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${p}${pad}${fence}`;
}

/**
 * How a project path goes into a message. Never `@path`: the agent would read the file into the conversation.
 * - a picture, video or sound: a markdown embed, so it shows or plays in the feed (`%` written `%25`: the feed decodes the
 *   URL once, so a literal `%20` in a name stays that name); one with `<` or `>` cannot be an embed and goes in as code;
 * - a path the feed takes for a file in a code span (`isPath`): inline code, a clickable ref;
 * - any other (a root file without an extension such as `Makefile`, a long extension): a link to itself, which the feed
 *   always makes a ref; with brackets, a backtick or `<>` in it, plain code (shown right, not clickable).
 */
export function pathText(p: string): string {
  const enc = p.replace(/%/g, '%25');
  if ((IMAGE.test(p) || VIDEO.test(p) || AUDIO.test(p)) && !/[<>]/.test(p)) return /[\s()]/.test(p) ? `![](<${enc}>)` : `![](${enc})`;
  if (isPath(p) || /[<>[\]\n`]/.test(p)) return codeSpan(p);
  return `[${p}](<${enc}>)`;
}

/** Puts `paths` at the caret (over a selection) as one run, spaced from the words around it; the caret goes after it. */
export function insertPaths(ta: HTMLTextAreaElement, paths: readonly string[]): void {
  if (!paths.length) return;
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const before = a > 0 && !/\s/.test(value[a - 1]!) ? ' ' : '';
  const after = b < value.length && !/\s/.test(value[b]!) ? ' ' : '';
  const run = before + paths.map(pathText).join(' ');
  setValueAndCaret(ta, value.slice(0, a) + run + after + value.slice(b), a + run.length);
}
