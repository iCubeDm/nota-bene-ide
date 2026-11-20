// `nota-bene remote …` (the launcher hands its argv over before its own parsing). The foreground run is the connector;
// the other commands talk to it over the control socket.
import { renderUnicodeCompact } from 'uqr';
import { Connector } from './connector.ts';
import { controlClient, type ControlClient, type Msg } from './control.ts';
import { pairHost } from './hostLink.ts';
import { fingerprint, fromB64u, readConfig, readHosts, removeHost, writeAccessKey, writeConfig } from './store.ts';
import { packageVersion } from '../version.ts';

export const REMOTE_USAGE = 'Usage: nota-bene remote [--relay wss://HOST]   run the connector in the foreground (the relay is saved)\n'
  + '       nota-bene remote pair                    show a QR code to pair a device (a phone, another computer)\n'
  + '       nota-bene remote devices                 list the paired devices\n'
  + '       nota-bene remote revoke ID               unpair a device and cut it off\n'
  + '       nota-bene remote connect                 pair with another computer as its device (its `pair` code, read from stdin)\n'
  + '       nota-bene remote computers               list the computers this one is paired with\n'
  + '       nota-bene remote forget ID               forget such a computer\n'
  + '       nota-bene remote status\n'
  + '       nota-bene remote key [--clear]           save the relay access key you were given (read from stdin), or remove it\n'
  + '(a folder named remote opens with `nota-bene ./remote`)';

type Io = { out: (s: string) => void; err: (s: string) => void; input?: (prompt: string) => Promise<string> };
const stdio: Io = { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s), input: readSecret };

/** One line from stdin; on a terminal the typed characters are not echoed. */
function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let line = '';
    const done = (v: string) => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      resolve(v);
    };
    const onEnd = () => done(line);
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\u0003') { // Ctrl+C on a raw terminal
          if (stdin.isTTY) stdin.setRawMode(false);
          return reject(new Error('interrupted'));
        }
        if (ch === '\r' || ch === '\n') {
          if (stdin.isTTY) process.stderr.write('\n');
          return done(line);
        }
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1);
        else line += ch;
      }
    };
    process.stderr.write(prompt);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.resume();
  });
}

/** Saves or removes the access key; a running connector reconnects with it. */
async function key(rest: string[], io: Io): Promise<number> {
  try {
    if (rest[0] === '--clear') {
      writeAccessKey(null);
      io.out('access key removed\n');
    } else {
      const code = await (io.input ?? readSecret)('Access key (nbk1_…): ');
      writeAccessKey(code);
      io.out('access key saved\n');
    }
  } catch (e) {
    io.err(`nota-bene: ${(e as Error).message}\n`);
    return 1;
  }
  let cl: ControlClient | undefined;
  try {
    cl = await controlClient();
    cl.send({ op: 'reconnect' });
    await cl.next();
  } catch { /* not running: the next start uses it */ } finally {
    cl?.close();
  }
  return 0;
}

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

/** A running connector picks up a changed hosts.json; none running: the next one reads it. */
async function syncHosts(): Promise<Msg | null> {
  let cl: ControlClient | undefined;
  try {
    cl = await controlClient();
    cl.send({ op: 'hosts' });
    return await cl.next();
  } catch {
    return null;
  } finally {
    cl?.close();
  }
}

/** The code comes from stdin, as the access key does: never in argv (ps, shell history). */
async function connectHost(io: Io): Promise<number> {
  try {
    const h = await pairHost(await (io.input ?? readSecret)('Pairing code (nbremote://pair?…): '));
    io.out(`Paired with ${h.name ?? 'the computer'}: id ${h.id}, host fingerprint ${fingerprint(fromB64u(h.pub, 32))} (compare it with the other computer)\n`);
    return 0;
  } catch (e) {
    io.err(`nota-bene: ${(e as Error).message}\n`);
    return 1;
  } finally {
    await syncHosts(); // also after a failure: a link that gave up (revoked, then paired again) starts over
  }
}

const deviceLine = (d: Msg) => `${String(d.id).padEnd(8)}  ${String(d.name ?? '-').padEnd(20)}  ${String(d.fingerprint)}  ${d.online ? 'online' : 'offline'}\n`;

async function run(argv: string[], io: Io): Promise<number> {
  let relay: string | undefined;
  // --managed: a window started it (keeper.ts). It exits with nothing to do (access off, no computer paired) or no window
  // left, and leaves the setting alone
  let managed = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay' && argv[i + 1] !== undefined) relay = argv[++i];
    else if (argv[i] === '--managed') managed = true;
    else {
      io.err(`${REMOTE_USAGE}\n`);
      return 2;
    }
  }
  let hostRelay: string | undefined;
  let linked: boolean;
  try {
    const cfg = readConfig();
    // run by hand: an explicit request for access, so a switch turned off in a window is on again
    if (relay !== undefined || (!managed && cfg.enabled === false)) writeConfig({ ...cfg, ...(relay !== undefined ? { relay } : {}), ...(managed ? {} : { enabled: true }) });
    // access off (a managed run): no host side, only the links to the computers this one is paired with
    hostRelay = managed && cfg.enabled === false ? undefined : relay ?? cfg.relay;
    linked = readHosts().length > 0;
  } catch (e) {
    io.err(`nota-bene: ${(e as Error).message}\n`);
    return 2;
  }
  if (managed && !hostRelay && !linked) return 0;
  if (!hostRelay && !linked) {
    io.err('nota-bene: no relay set. Start it once with `nota-bene remote --relay wss://relay.example.com` (your relay\'s address); it is saved for later runs.\n'
      + 'To open a folder named remote in a window, run `nota-bene ./remote`.\n');
    return 2;
  }
  const version = packageVersion();
  const c = new Connector({ ...(hostRelay ? { relay: hostRelay } : {}), managed, ...(version ? { version } : {}) });
  const stamp = () => new Date().toISOString().slice(11, 19);
  c.on('log', (m: string) => io.err(`${stamp()} ${m}\n`));
  try {
    await c.start();
  } catch (e) {
    io.err(`nota-bene: ${(e as Error).message}\n`);
    return 1;
  }
  io.err(hostRelay ? `nota-bene remote: relay ${hostRelay}, host fingerprint ${c.hostFingerprint}\n` : 'nota-bene remote: connecting to the paired computers only\n');
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
    const code = await cl.next((m) => m.t === 'code' || m.t === 'error');
    if (code.t === 'error') throw new Error(String(code.message));
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
  if (cmd === 'key' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--clear'))) return key(rest, io);
  if (cmd === 'devices' && rest.length === 0) {
    const r = await ask(io, { op: 'devices' });
    if (!r) return 1;
    const list = (r.devices as Msg[]) ?? [];
    io.out(list.length ? list.map(deviceLine).join('') : 'No paired devices. Pair one with `nota-bene remote pair`.\n');
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
  if (cmd === 'connect' && rest.length === 0) return connectHost(io);
  if (cmd === 'computers' && rest.length === 0) {
    const r = await syncHosts();
    const list = r ? (r.hosts as Msg[]) ?? [] : readHosts().map((h) => ({ ...h, fingerprint: fingerprint(fromB64u(h.pub, 32)), state: 'not running' }));
    io.out(list.length ? list.map((h) => `${String(h.id).padEnd(8)}  ${String(h.name ?? '-').padEnd(20)}  ${String(h.fingerprint)}  ${String(h.state)}\n`).join('')
      : 'No paired computers. Pair with one with `nota-bene remote connect`.\n');
    return 0;
  }
  if (cmd === 'forget' && rest.length === 1) {
    try {
      const h = removeHost(rest[0]!);
      if (!h) throw new Error(`no paired computer ${rest[0]!}`);
      await syncHosts();
      io.out(`forgot ${h.id} (${h.name ?? 'a computer'})\n`);
      return 0;
    } catch (e) {
      io.err(`nota-bene: ${(e as Error).message}\n`);
      return 1;
    }
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
