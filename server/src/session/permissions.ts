import type { Interaction, InteractionAnswer } from '@nota-bene/shared';
import { randomUUID } from 'node:crypto';
import type { InteractAsk, PermissionAsk } from '../agent/types.ts';
import type { EmitInput } from '../hub.ts';

type AskState = 'open' | 'answered' | 'aborted';

/** An open ask as its `permission` event shows it (issue 651: the home page's inbox reads them from /info). */
export type OpenAsk = { id: string; toolName: string; input: Record<string, unknown>; prompt?: Interaction };

/** At most this many characters of each string in an ask's input go to /info, which is polled; the answer needs only the id. */
const CLIP = 2000;
export const clipAsk = (a: OpenAsk): OpenAsk => ({
  ...a, input: Object.fromEntries(Object.entries(a.input).map(([k, v]) => [k, typeof v === 'string' && v.length > CLIP ? `${v.slice(0, CLIP)}…` : v])),
});

/**
 * The agent's permission asks (R-M7-17): each is `open → answered | aborted`, and only an open ask is shown or
 * counted. An answer naming an unknown or a settled ask is ignored: a second socket answering the same card, or a
 * click that lands after the agent withdrew the ask, is normal traffic, not an error.
 */
export class PermissionBroker {
  private open = new Map<string, (allow: boolean, to: AskState) => void>();

  private structured = new Map<string, { finish(answer: InteractionAnswer | null): void; validate(answer: InteractionAnswer): boolean }>();

  /** every open ask, both kinds, in the order they were opened */
  private shown = new Map<string, OpenAsk>();

  private readonly o: { emit: (ev: EmitInput) => void };

  constructor(o: { emit: (ev: EmitInput) => void }) {
    this.o = o;
  }

  /**
   * The canUseTool of an agent started in generation `g`; `gen` reads the current one. An ask from an old agent
   * (after a switch) is denied at once and never shown; a settled ask is announced only while `g` is current.
   */
  ask(gen: () => number, g: number): PermissionAsk {
    return (toolName, input, signal) => new Promise<boolean>((resolve) => {
      if (g !== gen()) return resolve(false);
      const id = randomUUID();
      let state: AskState = 'open';
      const finish = (allow: boolean, to: AskState) => {
        // the first settle stands; unreachable through the interface (answer/abort/denyAll each find an open ask only)
        if (state !== 'open') return;
        state = to;
        this.open.delete(id);
        this.shown.delete(id);
        signal.removeEventListener('abort', onAbort);
        if (g === gen()) this.o.emit({ kind: 'permission-done', id, allow });
        resolve(allow);
      };
      const onAbort = () => finish(false, 'aborted');
      this.open.set(id, finish);
      this.shown.set(id, { id, toolName, input });
      signal.addEventListener('abort', onAbort, { once: true });
      this.o.emit({ kind: 'permission', id, toolName, input });
      if (signal.aborted) onAbort();
    });
  }

  interact(gen: () => number, g: number): InteractAsk {
    return (prompt, input, signal) => new Promise((resolve) => {
      if (g !== gen() || signal.aborted) return resolve(null);
      const id = randomUUID(); let done = false;
      const finish = (answer: InteractionAnswer | null) => {
        if (done) return; done = true; this.structured.delete(id); this.shown.delete(id); signal.removeEventListener('abort', abort);
        if (g === gen()) this.o.emit({ kind: 'permission-done', id, allow: answer !== null && prompt.choices.find((c) => c.id === answer.choice)?.allow !== false && !['deny', 'decline', 'cancel'].includes(answer.choice) });
        resolve(answer);
      };
      const abort = () => finish(null);
      this.structured.set(id, { finish, validate: (a) => prompt.choices.some((c) => c.id === a.choice) &&
        (['deny', 'decline', 'cancel'].includes(a.choice) || (prompt.fields ?? []).every((f) => !f.required || !!a.values?.[f.id]?.trim())) &&
        Object.keys(a.values ?? {}).every((k) => prompt.fields?.some((f) => f.id === k) === true) });
      signal.addEventListener('abort', abort, { once: true });
      this.shown.set(id, { id, toolName: prompt.tool ?? prompt.title, input, prompt });
      this.o.emit({ kind: 'permission', id, toolName: prompt.tool ?? prompt.title, input, prompt });
    });
  }

  /** true when it settled an open ask: false for an unknown or settled id, or a structured answer it refused */
  answer(id: string, allow: boolean, response?: InteractionAnswer): boolean {
    const ask = this.structured.get(id);
    if (ask) {
      if (!response || !ask.validate(response)) return false;
      ask.finish(response);
      return true;
    }
    const finish = this.open.get(id);
    finish?.(allow, 'answered');
    return !!finish;
  }

  asks(): OpenAsk[] {
    return [...this.shown.values()];
  }

  pending(): number {
    return this.open.size + this.structured.size;
  }

  /** every open ask: aborted (denied) — the agent died, or the session is torn down */
  denyAll(): void {
    for (const ask of [...this.structured.values()]) ask.finish(null);
    for (const finish of [...this.open.values()]) finish(false, 'aborted');
  }
}
