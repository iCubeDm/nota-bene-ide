import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import type { ImageEntry } from '@/composer/slice.ts';
import { t } from '@/i18n/index.ts';
import { isLocalPage } from '@/net/local.ts';
import { uploadFile, UploadError } from './file.ts';
import { prepareImage, uploadImage } from './image.ts';
import type { PendingThumb } from './Attachments.tsx';

const isImage = (f: File) => f.type.startsWith('image/');
/** the relay (remote/device.ts) holds a request body whole, up to 32 MiB: a page on another computer cannot send more */
export const RELAY_MAX_BYTES = 32 * 1024 * 1024;

/** What a failed file upload says: a refusal with a reason names it, anything else is the generic failure. */
function fileFailure(f: File, e: unknown): string {
  if (e instanceof UploadError && e.code === 'attachments-not-folder') return t('attachmentsNotFolder');
  if (e instanceof UploadError && e.status === 413) return isLocalPage() ? t('fileTooLarge', f.name) : t('fileTooLargeRelay', f.name);
  return t('fileFail', f.name);
}

export const hasFiles = (e: { dataTransfer: DataTransfer | null }): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');

/**
 * Paste / drop / pick → prepare → upload at once. Pending uploads are local (object URL thumbnails, a name chip for a
 * file); a finished image goes to `onUploaded`. Any other file (issue 461) is streamed into the project's `attachments/`
 * and its path goes to `onFilePath`; `cancel(key)` stops one. `notify` gets imgFail and the file failures. `onBusy(±1)` lets
 * the owner block its send while uploads run.
 */
export function useImageIntake(o: {
  onUploaded: (e: ImageEntry) => void; onFilePath: (path: string) => void; notify: (msg: string) => void; onBusy?: (d: 1 | -1) => void;
}) {
  const [pending, setPending] = useState<PendingThumb[]>([]);
  const urls = useRef(new Set<string>());
  const aborts = useRef(new Map<string, AbortController>());
  const live = useRef(o);
  live.current = o;
  useEffect(() => {
    const set = urls.current;
    return () => { for (const u of set) URL.revokeObjectURL(u); set.clear(); };
  }, []);

  const add = useCallback((files: Iterable<File>): boolean => {
    const all = [...files];
    if (!all.length) return false;
    for (const f of all) {
      const image = isImage(f);
      if (!image && !isLocalPage() && f.size > RELAY_MAX_BYTES) {
        live.current.notify(t('fileTooLargeRelay', f.name));
        continue;
      }
      const thumb: PendingThumb = image ? { key: crypto.randomUUID(), url: URL.createObjectURL(f) } : { key: crypto.randomUUID(), name: f.name };
      if (thumb.url) urls.current.add(thumb.url);
      setPending((p) => [...p, thumb]);
      live.current.onBusy?.(1);
      const ac = new AbortController();
      if (!image) aborts.current.set(thumb.key, ac);
      void (async () => {
        try {
          if (image) live.current.onUploaded(await uploadImage(await prepareImage(f)));
          else live.current.onFilePath(await uploadFile(f, ac.signal));
        } catch (e) {
          if (!ac.signal.aborted) live.current.notify(image ? t('imgFail') : fileFailure(f, e));
        } finally {
          aborts.current.delete(thumb.key);
          if (thumb.url) {
            urls.current.delete(thumb.url);
            URL.revokeObjectURL(thumb.url);
          }
          setPending((p) => p.filter((x) => x.key !== thumb.key));
          live.current.onBusy?.(-1);
        }
      })();
    }
    return true;
  }, []);

  /** the × on a file's chip: the upload stops and nothing goes into the text */
  const cancel = useCallback((key: string) => aborts.current.get(key)?.abort(), []);

  /** paste: files on the clipboard win over the text that rides along (a file name from Finder) */
  const onPaste = useCallback((e: ClipboardEvent) => {
    const cd = e.clipboardData;
    // `files` first; items only when it is empty (Chrome lists the same file in both, and getAsFile() makes a new File each time)
    let files = [...(cd?.files ?? [])];
    if (!files.length) files = [...(cd?.items ?? [])].flatMap((it) => (it.kind === 'file' ? [it.getAsFile()] : [])).filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    add(files);
  }, [add]);

  return { pending, add, onPaste, cancel };
}
