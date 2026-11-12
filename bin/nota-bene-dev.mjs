#!/usr/bin/env node
// Local checkout launcher; intentionally not included in the published package.
import os from 'node:os';
import path from 'node:path';

// A dev command may be invoked from a production window. Never inherit its state directory.
process.env.NOTA_BENE_HOME = path.resolve(process.env.NOTA_BENE_DEV_HOME || path.join(os.homedir(), '.nota-bene-dev'));

try {
  // Load after setting the environment, before any launcher dependency reads state.
  const { main } = await import('./nota-bene.mjs');
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`nota-bene-dev: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
}
