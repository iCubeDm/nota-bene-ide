// Issue 639: the server's home page, at its top. It has no agent, so none of the frame (header, tabs, composer): the
// plugins' part of it (the projects) and the toasts.
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { Slots, type Own } from './Slots.tsx';
import { Toasts } from './Toasts.tsx';

const OWN: readonly Own[] = [{ order: 90, render: Toasts }];

export function Home() {
  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto"><Slots at="home" own={OWN} /></div>
    </TooltipProvider>
  );
}
