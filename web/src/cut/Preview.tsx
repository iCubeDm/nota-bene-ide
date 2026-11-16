import { useCallback } from 'react';
import { useT } from '@/i18n/index.ts';
import type { CutPlayer } from './engine.ts';

/**
 * The output frame above the timeline (issue 408): the edit's width × height, as large as fits, black around and under
 * the pictures. The player puts each video track's layer in it (engine.ts); `blocked` says why nothing plays.
 */
export function Preview({ player, frame, blocked }: { player: CutPlayer; frame: { width: number; height: number }; blocked?: string }) {
  const t = useT();
  const attach = useCallback((el: HTMLDivElement | null) => player.attach(el), [player]);
  return (
    <div data-cut-preview role="region" aria-label={t('cutPreview')} className="relative min-h-24 flex-[3_1_0%] border-b border-border-soft bg-chrome">
      {/* a size container: the frame letterboxes itself in it by the container's width and height */}
      <div className="absolute inset-2 grid place-items-center" style={{ containerType: 'size' }}>
        <div
          data-cut-frame className="relative overflow-hidden bg-black"
          style={{ width: `min(100cqw, calc(100cqh * ${frame.width / frame.height}))`, aspectRatio: `${frame.width} / ${frame.height}` }}
        >
          <div ref={attach} className="absolute inset-0" />
          {blocked && <p className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-on-scrim/80">{blocked}</p>}
        </div>
      </div>
    </div>
  );
}
