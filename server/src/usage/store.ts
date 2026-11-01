// `<NOTA_BENE_HOME>/usage/`: one store for every project and window. `<provider>.jsonl` is append-only normalized records,
// `<provider>.state.json` how far each transcript was read, `trips.json` the reset points. It outlives the transcripts.
import fs from 'node:fs';
import path from 'node:path';
import type { UsageProvider } from '@nota-bene/shared';
import { stateBaseDir } from '../state.ts';
import type { CodexContext, UsageRecord } from './parse.ts';

/** One transcript: bytes read, and what its parser must remember. */
/** `v`: the `PARSE_VERSION` that read the file */
export type FileState = { offset: number; v?: number; context?: CodexContext };
export type ImportState = Record<string, FileState>;

export const usageDir = (): string => path.join(stateBaseDir(), 'usage');

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback; // missing, or torn by a crash: the merge makes a re-read harmless
  }
}

/** Reads `file` from `offset`, calling `line` for every complete line; returns where the next read starts. Yields between chunks. */
export async function readLines(file: string, offset: number, line: (text: string) => void): Promise<number> {
  let next = offset, pending: Buffer[] = [];
  const stream = fs.createReadStream(file, { start: offset, highWaterMark: 256 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; from = nl + 1, nl = chunk.indexOf(10, from)) {
      const part = chunk.subarray(from, nl);
      const bytes = pending.length ? Buffer.concat([...pending, part]) : part;
      pending = [];
      next += bytes.length + 1;
      if (bytes.length) line(bytes.toString('utf8'));
    }
    if (from < chunk.length) pending.push(Buffer.from(chunk.subarray(from)));
  }
  return next; // a line with no newline yet stays for the next read
}

export class UsageStore {
  readonly provider: UsageProvider;
  private readonly dir: string;
  private records: UsageRecord[] = [];
  private loaded = 0;

  constructor(provider: UsageProvider, dir: string = usageDir()) {
    this.provider = provider;
    this.dir = dir;
  }

  private path(name: string): string {
    return path.join(this.dir, name);
  }

  private get log(): string {
    return this.path(`${this.provider}.jsonl`);
  }

  private ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Everything recorded so far; only what was appended since the last call is read. */
  async load(): Promise<readonly UsageRecord[]> {
    try {
      this.loaded = await readLines(this.log, this.loaded, (text) => {
        try { this.records.push(JSON.parse(text) as UsageRecord); } catch { /* a torn line: nothing to count */ }
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return this.records;
  }

  /** O_APPEND keeps windows' short appends whole. */
  append(records: readonly UsageRecord[]): void {
    if (!records.length) return;
    this.ensure();
    fs.appendFileSync(this.log, records.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
  }

  readState(): ImportState {
    return readJson<ImportState>(this.path(`${this.provider}.state.json`), {});
  }

  writeState(state: ImportState): void {
    this.ensure();
    writeAtomic(this.path(`${this.provider}.state.json`), JSON.stringify(state));
  }

  /** One window imports at a time; a lock left by a dead one goes stale. Returns the release, or null if another holds it. */
  lock(staleMs: number, now: number = Date.now()): { touch(): void; release(): void } | null {
    this.ensure();
    const dir = this.path(`${this.provider}.lock`);
    try {
      fs.mkdirSync(dir);
    } catch {
      try {
        if (now - fs.statSync(dir).mtimeMs < staleMs) return null;
        fs.rmdirSync(dir);
        fs.mkdirSync(dir);
      } catch {
        return null;
      }
    }
    return {
      touch: () => { try { fs.utimesSync(dir, new Date(), new Date()); } catch { /* released meanwhile */ } },
      release: () => { try { fs.rmdirSync(dir); } catch { /* already gone */ } },
    };
  }

  /** The last reset, or null. Deletes nothing: the marker moves. */
  trip(): number | null {
    const v = readJson<Record<string, unknown>>(this.path('trips.json'), {})[this.provider];
    return typeof v === 'number' ? v : null;
  }

  resetTrip(now: number): void {
    this.ensure();
    const file = this.path('trips.json');
    writeAtomic(file, JSON.stringify({ ...readJson<Record<string, unknown>>(file, {}), [this.provider]: now }));
  }
}
