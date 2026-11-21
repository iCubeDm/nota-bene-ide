import { Slots } from './Slots.tsx';

/** Under the middle column: the tasks' indicator and the composer (the `footer` slot). */
export function Footer() {
  return (
    <footer className="flex-none border-t border-border-soft bg-chrome backdrop-blur-[24px]">
      <div className="mx-auto max-w-[860px] px-6">
        <Slots at="footer" />
      </div>
    </footer>
  );
}
