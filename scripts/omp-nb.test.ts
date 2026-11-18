import { expect, it } from 'vitest';
import { parseInvocation, launchArgs } from '../omp/skills/nb/open.mjs';

it('binds omp, always detaches and forks only the invoking session', () => {
  expect(launchArgs(parseInvocation([], {}))).toEqual(['--agent', 'omp', '--detach']);
  expect(launchArgs(parseInvocation(['new'], {}))).toEqual(['--agent', 'omp', '--detach', '--new']);
  const id = '12345678-0000-7000-8000-000000000000';
  expect(launchArgs(parseInvocation(['fork'], { PI_SESSION_ID: id }))).toEqual(['--agent', 'omp', '--detach', '--resume', id, '--fork']);
  expect(launchArgs(parseInvocation(['fork', '--source', id], {}))).toEqual(['--agent', 'omp', '--detach', '--resume', id, '--fork']);
  expect(() => parseInvocation(['fork'], {})).toThrow(/source session/i);
  expect(() => parseInvocation(['--host', 'cli'], {})).toThrow();
});
