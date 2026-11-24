// Issue 639: the server's home page, at its top. Issue 651: in the app's frame, with the parts that show there (`Slot.on`):
// no agent, so none of an agent's (the chat, the composer, the model), and no socket.
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { Frame } from './Frame.tsx';
import { OnHome, Slots } from './Slots.tsx';

export function Home() {
  return (
    <TooltipProvider>
      <OnHome.Provider value>
        <Frame center={<div className="flex min-h-0 flex-1 flex-col overflow-auto"><Slots at="home" /></div>} />
      </OnHome.Provider>
    </TooltipProvider>
  );
}
