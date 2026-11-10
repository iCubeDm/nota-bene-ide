import { expect, it } from 'vitest';
import { askUserQuestion, questionPrompt } from './ask-question.ts';

const input = {
  questions: [
    { question: 'Which library?', header: 'Library', multiSelect: false, options: [{ label: 'dayjs', description: 'small' }, { label: 'luxon', description: 'zones' }] },
    { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] },
  ],
};

it('questionPrompt: one required field per question, with its header, options, descriptions and multi-select', () => {
  expect(questionPrompt(input)).toEqual({
    title: 'Claude', tool: 'AskUserQuestion',
    choices: [{ id: 'submit', label: 'Send answers' }, { id: 'cancel', label: 'Cancel' }],
    fields: [
      { id: 'q0', label: 'Which library?', header: 'Library', options: ['dayjs', 'luxon'], notes: ['small', 'zones'], required: true },
      { id: 'q1', label: 'Which features?', header: 'Features', options: ['A', 'B'], notes: ['a', 'b'], multi: true, required: true },
    ],
  });
  expect(questionPrompt({ questions: 'x' })).toBeNull();
  expect(questionPrompt({ questions: [] })).toBeNull();
});

it('askUserQuestion: submit allows with the answers keyed by question text; free text as given', async () => {
  const r = await askUserQuestion(input, async () => ({ choice: 'submit', values: { q0: 'my own', q1: 'A, B' } }));
  expect(r).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which library?': 'my own', 'Which features?': 'A, B' } } });
});

it('askUserQuestion: cancel or a withdrawn ask denies', async () => {
  expect((await askUserQuestion(input, async () => ({ choice: 'cancel' })))?.behavior).toBe('deny');
  expect((await askUserQuestion(input, async () => null))?.behavior).toBe('deny');
});

it('askUserQuestion: a malformed input is not handled here', async () => {
  expect(await askUserQuestion({ questions: 3 }, async () => null)).toBeNull();
});
