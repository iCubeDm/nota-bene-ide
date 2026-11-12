// Every node-project test file starts with a state home of its own, so that a test that forgets to set NOTA_BENE_HOME cannot
// reach the real ~/.nota-bene: with it a Whisper host started by mistake once ran on the real home with the real model. A test
// that wants a home of its own sets one and restores what it found, which is this one. The folder is not made here, only named
// (what needs it makes it), and removed after the file: vitest runs no afterAll for a file whose tests are all skipped, and a
// folder made up front would be left behind by those.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll } from 'vitest';

const home = path.join(os.tmpdir(), `nb-test-home-${randomBytes(4).toString('hex')}`);
process.env.NOTA_BENE_HOME = home;
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });
