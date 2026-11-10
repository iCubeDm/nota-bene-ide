import type { Interaction, InteractionAnswer } from '@nota-bene/shared';

type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };
type Result = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function questionsOf(input: Record<string, unknown>): Question[] | null {
  if (!Array.isArray(input.questions) || !input.questions.length) return null;
  const qs: Question[] = [];
  for (const raw of input.questions) {
    const q = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!text(q.question)) return null;
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => (o && typeof o === 'object' ? o : {}) as Record<string, unknown>)
      .filter((o) => text(o.label)).map((o) => ({ label: text(o.label), description: text(o.description) }));
    qs.push({ question: text(q.question), header: text(q.header), multiSelect: q.multiSelect === true, options });
  }
  return qs;
}

/** AskUserQuestion's input as a structured prompt (the shape Codex and omp questions use); null = not a question we can show */
function promptOf(qs: Question[]): Interaction {
  return {
    title: 'Claude', tool: 'AskUserQuestion',
    choices: [{ id: 'submit', label: 'Send answers' }, { id: 'cancel', label: 'Cancel' }],
    fields: qs.map((q, i) => ({
      id: `q${i}`, label: q.question, ...(q.header ? { header: q.header } : {}),
      options: q.options.map((o) => o.label),
      ...(q.options.some((o) => o.description) ? { notes: q.options.map((o) => o.description) } : {}),
      ...(q.multiSelect ? { multi: true } : {}), required: true,
    })),
  };
}

export function questionPrompt(input: Record<string, unknown>): Interaction | null {
  const qs = questionsOf(input);
  return qs && promptOf(qs);
}

/**
 * canUseTool for AskUserQuestion: the answers go back as `updatedInput.answers` (question text -> label; several labels
 * comma-separated; free text as typed). Cancel, or an ask the agent withdrew, denies. null: the input is not a question
 * list, so the caller falls back to the plain allow / deny.
 */
export async function askUserQuestion(
  input: Record<string, unknown>,
  interact: (prompt: Interaction) => Promise<InteractionAnswer | null>,
): Promise<Result | null> {
  const qs = questionsOf(input);
  if (!qs) return null;
  const a = await interact(promptOf(qs));
  if (a?.choice !== 'submit') return { behavior: 'deny', message: 'User declined to answer the questions in the UI.' };
  const answers: Record<string, string> = {};
  qs.forEach((q, i) => { answers[q.question] = (a.values?.[`q${i}`] ?? '').trim(); });
  return { behavior: 'allow', updatedInput: { ...input, answers } };
}
