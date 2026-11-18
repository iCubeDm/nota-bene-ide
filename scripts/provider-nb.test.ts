import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import * as codex from '../codex/skills/nb/open.mjs';
import * as omp from '../omp/skills/nb/open.mjs';

// What the Codex and omp /nb skills share; how each parses its invocation is in its own file
describe.each([{ agent: 'codex', skill: codex, args: ['new'] }, { agent: 'omp', skill: omp, args: [] }])('the $agent skill', ({ agent, skill, args }) => {
  it('never prints browser credentials to the calling agent', () => {
    expect(skill.publicOutput('opened http://127.0.0.1:4790/#t=abcdef123456\n')).toBe('opened http://127.0.0.1:4790/\n');
  });
  it('passes paths with spaces as single arguments and sanitizes launcher output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nb-${agent} skill-`));
    const fake = path.join(dir, 'launcher.mjs');
    fs.writeFileSync(fake, 'console.log(JSON.stringify(process.argv.slice(2))); console.log("opened http://127.0.0.1:4790/#t=abcdef123456");');
    try {
      const p = spawnSync(process.execPath, [path.resolve(`${agent}/skills/nb/open.mjs`), ...args, '--dir', dir], { env: { ...process.env, NOTA_BENE_BIN: fake }, encoding: 'utf8' });
      expect(p.status).toBe(0); expect(p.stdout).toContain(JSON.stringify(dir)); expect(p.stdout).not.toContain('abcdef123456'); expect(p.stdout).toContain(`"--agent","${agent}"`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
