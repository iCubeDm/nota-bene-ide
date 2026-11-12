import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { proofFor } from '../server/src/auth.ts';

it('omp skill opens a detached omp window, reuses only it and explicit Stop retires it', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-omp-'));
  const project = path.join(temp, 'project with spaces'), state = path.join(temp, 'state'), scoped = path.join(state, 'providers/omp');
  fs.mkdirSync(project); fs.mkdirSync(scoped, { recursive: true });
  fs.writeFileSync(path.join(scoped, 'control-token'), 'c'.repeat(64), { mode: 0o600 });
  const wrapper = path.join(temp, 'launch.mjs');
  fs.writeFileSync(wrapper, `import { spawnSync } from 'node:child_process'; const r = spawnSync(process.execPath, [${JSON.stringify(path.resolve('bin/nota-bene.mjs'))}, ...process.argv.slice(2), '--no-open'], { encoding: 'utf8' }); process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);`);
  const env = { ...process.env, NOTA_BENE_BIN: wrapper, NOTA_BENE_HOME: state, NOTA_BENE_PORT_RANGE: '4794-4794', NOTA_BENE_BUILD_CMD: 'true', NOTA_BENE_OMP: path.resolve('server/test/fixtures/acp-server.mjs'), NB_ACP_FIXTURE_STATE: path.join(temp, 'sessions.json') };
  delete env.NOTA_BENE_LAUNCHER_PID; delete env.NOTA_BENE_SUPERVISED;
  const run = () => spawnSync(process.execPath, [path.resolve('omp/skills/nb/open.mjs'), '--dir', project], { env, encoding: 'utf8', timeout: 25000 });
  let pid: number | undefined;
  try {
    const first = run(); expect(first.stderr).toBe(''); expect(first.status).toBe(0); expect(first.stdout).toContain('opened http://127.0.0.1:4794'); expect(first.stdout).not.toContain('#t=');
    const windowFile = path.join(scoped, 'windows', '4794.json');
    pid = JSON.parse(fs.readFileSync(windowFile, 'utf8')).pid; expect(() => process.kill(pid!, 0)).not.toThrow();
    const token = fs.readFileSync(path.join(scoped, 'token'), 'utf8').trim();
    const challenge = 'a'.repeat(64);
    const response = await (await fetch(`http://127.0.0.1:4794/hello?c=${challenge}`)).json();
    expect(response.proof).toBe(proofFor(token, 4794, response.n, challenge));
    const second = run(); expect(second.status).toBe(0); expect(second.stdout).toContain('already-open');
    expect(JSON.parse(fs.readFileSync(windowFile, 'utf8')).pid).toBe(pid);
    expect(fs.existsSync(path.join(state, 'windows'))).toBe(false);
    expect((await fetch('http://127.0.0.1:4794/control/stop', { method: 'POST', headers: { 'x-nota-bene-control': 'c'.repeat(64) } })).ok).toBe(true);
    await expect.poll(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }, { timeout: 6000 }).toBe(true);
  } finally {
    { try { await fetch('http://127.0.0.1:4794/control/stop', { method: 'POST', headers: { 'x-nota-bene-control': 'c'.repeat(64) }, signal: AbortSignal.timeout(1000) }); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 35000);

// a standalone copy of the skill (no checkout or package above it) runs the `nota-bene` on PATH. Windows: that is npm's
// nota-bene.cmd shim, which Node cannot spawn without a shell: the skill runs the .mjs it wraps with its own node instead
it('a standalone omp skill copy runs the nota-bene on PATH (Windows: the .mjs behind npm\'s .cmd shim)', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-skill-shim-'));
  try {
    const skill = path.join(temp, 'skills/nb'), bin = path.join(temp, 'npm bin');
    fs.mkdirSync(skill, { recursive: true });
    fs.copyFileSync(path.resolve('omp/skills/nb/open.mjs'), path.join(skill, 'open.mjs'));
    const entry = path.join(bin, 'node_modules/nota-bene-ide/bin/nota-bene.mjs');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2))); console.log("opened http://127.0.0.1:4790/#t=abcdef123456");\n');
    if (process.platform === 'win32') {
      // the tail of the shim npm writes: "%_prog%" is node, the script is named relative to %dp0% (the shim's folder)
      fs.writeFileSync(path.join(bin, 'nota-bene.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n'
        + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\lib\\nota-bene.mjs" %*\r\n');
      fs.mkdirSync(path.join(bin, 'lib'));
      fs.renameSync(entry, path.join(bin, 'lib/nota-bene.mjs')); // only where the shim names it, so the name is what is followed
    } else {
      fs.symlinkSync(entry, path.join(bin, 'nota-bene'));
      fs.chmodSync(entry, 0o755);
      fs.writeFileSync(entry, `#!${process.execPath}\n${fs.readFileSync(entry, 'utf8')}`);
    }
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH' && k !== 'NOTA_BENE_BIN' && k !== 'NOTA_BENE_SUPERVISED'));
    env.PATH = [bin, process.env.PATH ?? process.env.Path].join(path.delimiter);
    const r = spawnSync(process.execPath, [path.join(skill, 'open.mjs'), 'new', '--dir', temp], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(JSON.stringify([temp, '--agent', 'omp']).slice(0, -1));
    expect(r.stdout).not.toContain('abcdef123456');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
