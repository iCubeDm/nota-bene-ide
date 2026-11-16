// How long a new clip of a project file is (issue 409, shared with issue 426's Add to edit and New edit from selection).
import { isPhotoSrc } from '@nota-bene/shared/cut';
import { projectFileUrl } from '@/files/kinds.ts';
import { srcLength } from './durations.ts';

/** A photo dropped on the timeline shows this long, seconds; a source whose length the browser cannot read too. */
export const PHOTO_LEN = 5;

/** A new clip of `file` takes the whole file (read through `fileSrc`, the source it is served from); a photo PHOTO_LEN. */
export async function mediaLen(file: string, fileSrc = 'here'): Promise<number> {
  return isPhotoSrc(file) ? PHOTO_LEN : (await srcLength(projectFileUrl(file, fileSrc))) ?? PHOTO_LEN;
}
