import { expect, it } from 'vitest';
import { approvalForm, OMP, OMP_HIDDEN_COMMANDS } from './omp.ts';

it('launch flags precede acp; plan rides on always-ask without a new process', () => {
  expect(OMP.args('omp-write')).toEqual(['--approval-mode', 'write', 'acp']);
  expect(OMP.args('omp-yolo')).toEqual(['--approval-mode', 'yolo', 'acp']);
  expect(OMP.sameProcess('omp-ask', 'omp-plan')).toBe(true);
  expect(OMP.sameProcess('omp-yolo', 'omp-write')).toBe(false);
  expect([OMP.acpMode('omp-plan'), OMP.acpMode('omp-ask')]).toEqual(['plan', 'default']);
});

it('reads omp\'s approval form and leaves the ask tool\'s form alone', () => {
  const schema = { type: 'object', properties: { value: { type: 'string', enum: ['Approve', 'Approve write for this session', 'Deny'] } }, required: ['value'] };
  expect(approvalForm('Allow tool: write\nPath: hello.txt\nContent:\nhi\n', schema)).toEqual({
    tool: 'write', title: 'Allow tool: write', details: 'Path: hello.txt\nContent:\nhi', property: 'value',
    choices: [{ id: 'Approve', label: 'Approve', allow: true }, { id: 'Approve write for this session', label: 'Approve write for this session', allow: true }, { id: 'Deny', label: 'Deny', allow: false }],
  });
  expect(approvalForm('Which colour?', { type: 'object', properties: { q0: { type: 'string', oneOf: [{ const: 'A' }] }, q0__other: { type: 'string' } } })).toBeNull();
  expect(approvalForm('Allow tool: write', { type: 'object', properties: { value: { type: 'string' } } })).toBeNull();
});

it('hides omp\'s TUI commands and keeps the user\'s', () => {
  expect(OMP_HIDDEN_COMMANDS.has('model')).toBe(true);
  expect(OMP_HIDDEN_COMMANDS.has('green')).toBe(false);
});
