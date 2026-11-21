import { isCutAnchor } from '@nota-bene/shared';
import { cutLine, getLang, useT, type AnchorView } from '@/sdk';
import { useCutState } from './live.ts';

/** A place on an edit's timeline, on its comment's card; a clip gone from the edit is known while the edit's tab shows it (issue 430). */
export const CutCard: NonNullable<AnchorView['Card']> = ({ comment: c, jump }) => {
  const t = useT();
  const cut = isCutAnchor(c.anchor) ? c.anchor : null;
  const gone = useCutState(cut) === 'gone';
  if (!cut) return null;
  return (
    <>
      <div
        data-cut-quote
        onClick={jump}
        className={`line-clamp-3 border-l-2 border-nb-accent pl-2 font-mono text-[0.6875rem] text-muted-foreground ${jump ? 'cursor-pointer' : ''}`}
      >
        {cutLine(cut, getLang())}
      </div>
      {gone && <div data-cut-gone className="mt-1 text-[0.6875rem] text-warn">{t('cutGoneTag')}</div>}
    </>
  );
};
