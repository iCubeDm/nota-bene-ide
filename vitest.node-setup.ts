// Every node-project test file starts with a state home of its own (a fresh folder, removed after the file), so that a test that
// forgets to set NOTA_BENE_HOME cannot reach the real ~/.nota-bene: with it a Whisper host started by mistake once ran on the real
// home with the real model. A test that wants a home of its own sets one and restores what it found, which is this one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-test-home-'));
process.env.NOTA_BENE_HOME = home;
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });
