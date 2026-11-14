// `nota-bene remote …` (the launcher hands its argv over before its own parsing). The foreground run is the connector;
// the other commands talk to it over the control socket.
import fs from 'node:fs';
import path from 'node:path';
import { renderUnicodeCompact } from 'uqr';
import { Connector } from './connector.ts';
import { controlClient, type ControlClient, type Msg } from './control.ts';
import { readConfig, writeConfig } from './store.ts';

export const REMOTE_USAGE = 'Usage: nota-bene remote [--relay wss://HOST]   run the connector in the foreground (the relay is saved)\n'
  + '       nota-bene remote pair                    show a QR code to pair a phone\n'
  + '       nota-bene remote devices                 list the paired phones\n'
  + '       nota-bene remote revoke ID               unpair a phone and cut it off\n'
  + '       nota-bene remote status\n'
  + '(a folder named remote opens with `nota-bene ./remote`)';

/** The package's version, for `status` (a window replaces a connector it started from another version). Here and in the
 * package bundle alike, this file is three folders below the package root. */
function packageVersion(): string | undefined {
  try {
    const v = (JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}

type Io = { out: (s: string) => void; err: (s: string) => void };
const stdio: Io = { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s) };

async function connect(io: Io): Promise<ControlClient | null> {
  try {
    return await controlClient();
  } catch (e) {
    io.err(`nota-bene: ${(e as Error).message}\n`);
    return null;
  }
}

async function ask(io: Io, m: Msg): Promise<Msg | null> {
  const cl = await connect(io);
  if (!cl) return null;
  try {
    cl.send(m);
    return await cl.next();
  } finally {
    cl.close();
  }
}

const deviceLine = (d: Msg) => `${String(d.id).padEnd(8)}  ${String(d.name ?? '-').padEnd(20)}  ${String(d.fingerprint)}  ${d.online ? 'online' : 'offline'}\n`;

async function run(argv: string[], io: Io): Promise<number> {
  let relay: string | undefined;
  // --managed: a window started it (keeper.ts). It exits when access is off or no window is left, and leaves the setting alone
  let managed = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay' && argv[i + 1] !== undefined) relay = argv[++i];
    else if (argv[i] === '--managed') managed = true;
    else {
      io.err(`${REMOTE_USAGE}\n`);
      return 2;
    }
  }
  try {
    const cfg = readConfig();
    if (managed && cfg.enabled === false) return 0; // turned off in a window since it was started
    // run by hand: an explicit request for access, so a switch turned off in a window is on again
    if (relay !== undefined || (!managed && cfg.enabled === false)) writeConfig({ ...cfg, ...(relay !== undefined ? { relay } : {}), ...(managed ? {} : { enabled: true }) });
  } catch (e) {
    io.err(`nota-bene: ${(e as Error).message}\n`);
    return 2;
  }
  relay ??= readConfig().relay;
  if (!relay) {
    io.err('nota-bene: no relay set. Start it once with `nota-bene remote --relay wss://relay.example.com` (your relay\'s address); it is saved for later runs.\n'
      + 'To open a folder named remote in a window, run `nota-bene ./remote`.\n');
    return 2;
  }
  const version = packageVersion();
  const c = new Connector({ relay, managed, ...(version ? { version } : {}) });
  const stamp = () => new Date().toISOString().slice(11, 19);
  c.on('log', (m: string) => io.err(`${stamp()} ${m}\n`));
  try {
    await c.start();
  } catch (e) {
    io.err(`nota-bene: ${(e as Error).message}\n`);
    return 1;
  }
  io.err(`nota-bene remote: relay ${relay}, host fingerprint ${c.hostFingerprint}\n`);
  const code = await new Promise<number>((resolve) => {
    const quit = () => resolve(0);
    process.once('SIGINT', quit);
    process.once('SIGTERM', quit);
    c.once('fatal', () => resolve(1));
    c.once('exit', () => resolve(0));
  });
  await c.stop();
  return code;
}

async function pair(io: Io): Promise<number> {
  const cl = await connect(io);
  if (!cl) return 1;
  const interrupted = new Promise<number>((r) => process.once('SIGINT', () => r(130)));
  try {
    cl.send({ op: 'pair' });
    const code = await cl.next((m) => m.t === 'code');
    io.out(`${renderUnicodeCompact(String(code.uri))}\n\n${String(code.uri)}\n\n`);
    io.out(`Scan it with the Nota Bene app within ${Math.round((Number(code.expiresAt) - Date.now()) / 60_000)} minutes.\n`);
    io.out(`Host fingerprint: ${String(code.hostFingerprint)} (the app shows it too: they must match)\n`);
    for (;;) {
      const m = await Promise.race([cl.next((x) => x.t !== 'code', 24 * 3600_000), interrupted.then(() => ({ t: 'interrupted' }) as Msg)]);
      if (m.t === 'refused') io.err(`nota-bene: refused another phone presenting this code (fingerprint ${String(m.fingerprint)})\n`);
      else if (m.t === 'paired') {
        const d = m.device as Msg;
        io.out(`Paired ${String(d.name ?? 'a phone')}: id ${String(d.id)}, fingerprint ${String(d.fingerprint)} (compare it with the app)\n`);
        return 0;
      } else if (m.t === 'expired') {
        io.err('nota-bene: the code expired; run `nota-bene remote pair` again\n');
        return 1;
      } else if (m.t === 'cancelled') {
        io.err('nota-bene: another `nota-bene remote pair` replaced this code\n');
        return 1;
      } else if (m.t === 'error') io.err(`nota-bene: ${String(m.message)}\n`);
      else if (m.t === 'interrupted') return 130;
    }
  } catch (e) {
    io.err(`nota-bene: ${(e as Error).message}\n`);
    return 1;
  } finally {
    cl.close();
  }
}

export async function remoteMain(argv: string[], io: Io = stdio): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    io.out(`${REMOTE_USAGE}\n`);
    return 0;
  }
  if (cmd === undefined || cmd.startsWith('--')) return run(argv, io);
  if (cmd === 'pair' && rest.length === 0) return pair(io);
  if (cmd === 'devices' && rest.length === 0) {
    const r = await ask(io, { op: 'devices' });
    if (!r) return 1;
    const list = (r.devices as Msg[]) ?? [];
    io.out(list.length ? list.map(deviceLine).join('') : 'No paired phones. Pair one with `nota-bene remote pair`.\n');
    return 0;
  }
  if (cmd === 'revoke' && rest.length === 1) {
    const r = await ask(io, { op: 'revoke', id: rest[0] });
    if (!r) return 1;
    if (!r.ok) {
      io.err(`nota-bene: ${String(r.error)}\n`);
      return 1;
    }
    const d = r.device as Msg;
    io.out(`revoked ${String(d.id)} (${String(d.fingerprint)})\n`);
    return 0;
  }
  if (cmd === 'status' && rest.length === 0) {
    const r = await ask(io, { op: 'status' });
    if (!r) return 1;
    io.out(`relay ${String(r.relay)}: ${r.online ? 'online' : 'offline'}\nhost fingerprint ${String(r.hostFingerprint)}\nwindows ${String(r.windows)}\n`);
    for (const d of (r.devices as Msg[]) ?? []) io.out(deviceLine(d));
    return 0;
  }
  io.err(`${REMOTE_USAGE}\n`);
  return 2;
}
