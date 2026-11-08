// For tests in other languages (mobile/channel/test/cross_test.dart): a real relay, one window and the connector,
// driven by JSON lines on stdin and reporting on stdout. Commands: {"op":"pair"}, {"op":"revoke","id"},
// {"op":"restart-relay"}, {"op":"stop"}. Reports: {"t":"ready","relay","port"}, {"t":"code","uri"},
// {"t":"paired","id"}, {"t":"revoked"}, {"t":"restarted"}, {"t":"error","message"}. Needs NOTA_BENE_HOME set to a
// temporary folder; it never touches the real one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fakeBackend } from '../agent/fake.ts';
import { startServer } from '../server.ts';
import { registerWindow } from '../windows.ts';
import { Connector } from './connector.ts';
import { controlClient, type ControlClient } from './control.ts';
import { startRelay } from './testRelay.ts';

const say = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);

export async function main(): Promise<void> {
  if (!process.env.NOTA_BENE_HOME) throw new Error('set NOTA_BENE_HOME to a temporary folder');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cross-')));
  for (const d of ['dist', 'proj']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>shell</h1>');
  fs.writeFileSync(path.join(tmp, 'proj', 'notes.md'), '# Notes\n\nremote-cross-content\n');
  fs.writeFileSync(path.join(tmp, 'proj', 'big.bin'), Buffer.from(Array.from({ length: 700 * 1024 }, (_, i) => i % 251)));

  const relay = await startRelay();
  const s = await startServer({ cwd: path.join(tmp, 'proj'), port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: path.join(tmp, 'dist'), exit: () => {} });
  const port = Number(new URL(s.url).port);
  registerWindow(port, path.join(tmp, 'proj'), process.pid);
  const c = new Connector({ relay: relay.url, backoff: { minMs: 50, maxMs: 300 } });
  await c.start();
  await c.windows.refresh();
  let pairing: ControlClient | undefined;

  const stop = async () => {
    pairing?.close();
    await c.stop();
    await s.close();
    await relay.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  say({ t: 'ready', relay: relay.url, port, root: path.join(tmp, 'proj') });
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    try {
      const m = JSON.parse(line) as { op: string; id?: string };
      if (m.op === 'pair') {
        pairing?.close();
        const cl = (pairing = await controlClient());
        cl.send({ op: 'pair' });
        say({ t: 'code', uri: (await cl.next((x) => x.t === 'code')).uri });
        void cl.next((x) => x.t === 'paired', 60_000).then((x) => say({ t: 'paired', id: (x.device as { id: string }).id }), () => {});
      } else if (m.op === 'revoke') {
        const r = c.revoke(String(m.id));
        say(r.ok ? { t: 'revoked' } : { t: 'error', message: String(r.error) });
      } else if (m.op === 'restart-relay') {
        await relay.restart();
        say({ t: 'restarted' });
      } else if (m.op === 'stop') break;
    } catch (e) {
      say({ t: 'error', message: (e as Error).message });
    }
  }
  await stop();
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().then(() => process.exit(0), (e) => {
    process.stderr.write(`${(e as Error).stack}\n`);
    process.exit(1);
  });
}
