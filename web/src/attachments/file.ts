import { AUDIO, IMAGE, VIDEO } from '@/files/kinds.ts';
import { setValueAndCaret } from '@/comments/insertText.ts';
import { apiFetch } from '@/net/auth.ts';

/**
 * Any file that is not an image (issue 461): streamed to the server (the File itself is the body, never read into memory)
 * into the project's `attachments/`; answers the project-relative path it got there.
 */
export async function uploadFile(f: File): Promise<string> {
  const r = await apiFetch(`/attach-file?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
  const j = (await r.json().catch(() => null)) as { path?: unknown } | null;
  if (!r.ok || typeof j?.path !== 'string') throw new Error(`${r.status} ${r.statusText}`.trim());
  return j.path;
}

/**
 * How a project path goes into a message: a picture, video or sound as a markdown embed (it shows or plays in the feed),
 * anything else as inline code (a clickable ref). Never `@path`: the agent would read the file into the conversation.
 */
export function pathText(p: string): string {
  if (IMAGE.test(p) || VIDEO.test(p) || AUDIO.test(p)) return /[\s()<>]/.test(p) ? `![](<${p}>)` : `![](${p})`;
  return p.includes('`') ? `\`\`${p}\`\`` : `\`${p}\``;
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
