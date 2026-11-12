// The Whisper host as a process: what the window side spawns (detached, its output in the host log). Nothing is exported, so
// bundling this file (it becomes host.js) is the only way it runs; hostMain.ts is free of side effects and imports anywhere.
import { main } from './hostMain.ts';

main().then(({ code, wedged }) => {
  // a model thread stuck in native code cannot be stopped, and process.exit() waits for it: end the process the hard way
  if (wedged) process.kill(process.pid, 'SIGKILL');
  process.exit(code);
}, (e) => {
  console.error(e);
  process.exit(1);
});
