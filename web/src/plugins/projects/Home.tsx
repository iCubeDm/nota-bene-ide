// The server's home page (issue 639), at its top: no agent's chat, the projects to go to, Recent to open, a folder to open
// or make. Closing the server's last agent lands here.
import { useEffect } from 'react';
import { useProjects } from './api.ts';
import { ProjectsList } from './ProjectSwitcher.tsx';
import { badgeOf, titlePrefix } from './rows.ts';
import { Starter } from './Starter.tsx';

const done = () => {};

export function ProjectsHome() {
  const { data } = useProjects(true);
  const badge = badgeOf(data?.running ?? []);
  useEffect(() => { document.title = `${titlePrefix(badge)}Nota Bene`; }, [badge]);
  return (
    <main className="mx-auto flex min-h-0 w-full max-w-[560px] flex-1 flex-col px-3 py-6">
      <h1 className="px-2.5 pb-2 text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">Nota Bene</h1>
      <ProjectsList onDone={done} home />
      <Starter />
    </main>
  );
}
