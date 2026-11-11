// Which user message was a voice message: an agent's history keeps only its text, so a resumed session's replay gets
// the voice back from here, by message id. Some agents (omp) name their messages anew on a resume, so the transcript is
// kept too, and a message whose id is unknown gets the voice of the first unused entry that said the same words.
// Append-only JSONL, read once: a line `{id, voice}` when the message is sent, `{id, text}` when it is transcribed.
import fs from 'node:fs';
import path from 'node:path';
import { BATCH_HEAD, isVoice, type Voice } from '@nota-bene/shared';

type Entry = { voice?: Voice; text?: string };

/** What was said, as the history would show it: the server's zero-width guard before a slash is not part of it. */
const said = (text: string): string => (text.startsWith('\u200b') ? text.slice(1) : text).trim();

export class VoiceIndex {
  private readonly file: string;
  private map: Map<string, Entry> | undefined;

  constructor(o: { file: string }) {
    this.file = o.file;
  }

  private load(): Map<string, Entry> {
    if (this.map) return this.map;
    const map = new Map<string, Entry>();
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const line of text.split('\n')) {
      try {
        const o = JSON.parse(line) as { id?: unknown; voice?: unknown; text?: unknown };
        if (typeof o.id !== 'string') continue;
        const e = map.get(o.id) ?? {};
        if (isVoice(o.voice)) e.voice = o.voice;
        if (typeof o.text === 'string') e.text = o.text;
        if (e.voice || e.text !== undefined) map.set(o.id, e);
      } catch { /* a line cut by a crash */ }
    }
    return (this.map = map);
  }

  get(messageId: string): Voice | undefined {
    return this.load().get(messageId)?.voice;
  }

  put(messageId: string, voice: Voice): void {
    const map = this.load();
    map.set(messageId, { ...map.get(messageId), voice });
    this.append({ id: messageId, voice });
  }

  /** The message was transcribed: what it said, for a replay whose ids are not ours. */
  putText(messageId: string, text: string): void {
    const map = this.load();
    const t = said(text);
    map.set(messageId, { ...map.get(messageId), text: t });
    this.append({ id: messageId, text: t });
  }

  /**
   * The voices of a replay's user messages, in order (undefined for a typed one). A message is a voice message when its
   * id is in the index; failing that, when an unused entry said the same words, the oldest first. An entry serves one
   * message: those matched by id are used up before any match by text. Linear in the entries and messages.
   */
  resolve(users: { id: string; text: string }[]): (Voice | undefined)[] {
    const map = this.load();
    const used = new Set<string>();
    for (const u of users) if (map.get(u.id)?.voice) used.add(u.id);
    let queues: Map<string, string[]> | undefined; // text -> ids of unused entries, oldest first
    return users.map((u) => {
      const own = map.get(u.id)?.voice;
      if (own) return own;
      if (!queues) {
        queues = new Map();
        for (const [id, e] of map) {
          if (!e.voice || !e.text || used.has(id)) continue;
          const q = queues.get(e.text);
          if (q) q.push(id); else queues.set(e.text, [id]);
        }
      }
      // a message that carried comments is the transcript, then their batch: only the words count
      const text = said(u.text.slice(0, BATCH_HEAD.exec(u.text)?.index ?? u.text.length));
      if (!text) return undefined;
      const id = queues.get(text)?.shift();
      return id === undefined ? undefined : map.get(id)!.voice;
    });
  }

  private append(o: object): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(o) + '\n');
  }
}
