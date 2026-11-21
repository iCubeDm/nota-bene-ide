import { useT } from '@/core/i18n/index.ts';
import { Slots } from './Slots.tsx';

const strip = 'flex w-9 flex-none flex-col items-center gap-1 bg-chrome py-1.5';

/**
 * The thin IntelliJ-style strips on both sides of the work area (R-M6-3): their tool-window buttons are the plugins'
 * (`strip.left`: Files, Changes and the log; `strip.right`: Comments).
 */
export function LeftStrip() {
  const t = useT();
  return (
    <nav aria-label={t('toolsLeft')} data-strip="left" className={`${strip} border-r border-border-soft`}>
      <Slots at="strip.left" />
    </nav>
  );
}

export function RightStrip() {
  const t = useT();
  return (
    <nav aria-label={t('toolsRight')} data-strip="right" className={`${strip} border-l border-border-soft`}>
      <Slots at="strip.right" />
    </nav>
  );
}
