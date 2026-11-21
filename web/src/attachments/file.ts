import { setValueAndCaret } from '@/comments/insertText.ts';
import { connections, routes, AUDIO, IMAGE, VIDEO, isPath } from '@/sdk';

/** A refused upload: the HTTP status and the server's error code (`attachments-not-folder`, ...). */
export class UploadError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined) {
    super(code ?? String(status));
    this.status = status;
    this.code = code;
  }
}

/**
 * Any file that is not an image (issue 461): streamed to the server (the File itself is the body, never read into memory)
 * into the project's `attachments/`; answers the project-relative path it got there. `signal` cancels it.
 */
export async function uploadFile(f: File, signal?: AbortSignal): Promise<string> {
  const r = await connections.current().fetch(routes.attachFile(f.name), { method: 'POST', body: f, ...(signal ? { signal } : {}) });
  const j = (await r.json().catch(() => null)) as { path?: unknown; error?: unknown } | null;
  if (!r.ok || typeof j?.path !== 'string') throw new UploadError(r.status, typeof j?.error === 'string' ? j.error : undefined);
  return j.path;
}

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
