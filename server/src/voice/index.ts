// Which user message was a voice message: an agent's history keeps only its text, so a resumed session's replay gets
// the voice back from here, by message id. One JSONL line per voice message, read once, appended to.
import fs from 'node:fs';
import path from 'node:path';
import { isVoice, type Voice } from '@nota-bene/shared';

export class VoiceIndex {
  private readonly file: string;
  private map: Map<string, Voice> | undefined;

  constructor(o: { file: string }) {
    this.file = o.file;
  }

  private load(): Map<string, Voice> {
    if (this.map) return this.map;
    const map = new Map<string, Voice>();
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const line of text.split('\n')) {
      try {
        const o = JSON.parse(line) as { id?: unknown; voice?: unknown };
        if (typeof o.id === 'string' && isVoice(o.voice)) map.set(o.id, o.voice);
      } catch { /* a line cut by a crash */ }
    }
    return (this.map = map);
  }

  get(messageId: string): Voice | undefined {
    return this.load().get(messageId);
  }

  put(messageId: string, voice: Voice): void {
    this.load().set(messageId, voice);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ id: messageId, voice }) + '\n');
  }
}
