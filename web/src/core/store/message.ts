// The images of the message being written (issue 545): the composer adds and sends them, the attachments show and mark
// them, the comments go only with their image. Core, not the composer's: plugins never import each other.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ImageEntry } from '../sdk/registry.ts';
import { sendBuilding } from './send.ts';
import type { RootState } from './store.ts';

/**
 * `images`: uploaded, in the order attached. `uploading` counts uploads in flight (their thumbnails are component
 * state): a send waits for it to reach 0. `building`: a send is building its combined images. `marking`: the image
 * whose markup overlay is open (comments on an attachment, protocol 17); null = none.
 */
export const messageSlice = createSlice({
  name: 'message',
  initialState: { images: [] as ImageEntry[], uploading: 0, building: false, marking: null as string | null },
  reducers: {
    addImage: (s, a: PayloadAction<ImageEntry>) => void (s.images.some((i) => i.id === a.payload.id) || s.images.push(a.payload)),
    removeImage: (s, a: PayloadAction<string>) => {
      s.images = s.images.filter((i) => i.id !== a.payload);
      if (s.marking === a.payload) s.marking = null;
    },
    markAttachment: (s, a: PayloadAction<string | null>) => void (s.marking = a.payload),
    uploadStarted: (s) => void (s.uploading += 1),
    uploadFinished: (s) => void (s.uploading = Math.max(0, s.uploading - 1)),
  },
  extraReducers: (b) => b.addCase(sendBuilding, (s, a) => void (s.building = a.payload)),
});

export const { addImage, removeImage, markAttachment, uploadStarted, uploadFinished } = messageSlice.actions;
export const selectImages = (s: RootState): ImageEntry[] => s.message.images;
export const selectUploading = (s: RootState): number => s.message.uploading;
/** A send is building its combined images: the send buttons are off (a snapshot of the draft and comments is already taken). */
export const selectBuilding = (s: RootState): boolean => s.message.building;
/** The composer image whose markup overlay is open. */
export const selectMarking = (s: RootState): string | null => s.message.marking;
