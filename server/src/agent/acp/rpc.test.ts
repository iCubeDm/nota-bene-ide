import { expect, it } from 'vitest';
import { AcpError, AcpRpc } from './rpc.ts';

/** a tiny agent: answers initialize with the client capabilities it got, then runs `body` per frame `r` */
const agent = (body: string, timeoutMs?: number) => new AcpRpc({
  name: 'omp', command: process.execPath, clientVersion: '0.0.0', ...(timeoutMs ? { timeoutMs } : {}),
  args: ['-e', `const out = (f) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...f }) + '\\n'); let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (r.method === 'initialize') { out({ id: r.id, result: { agentInfo: { version: '18.16.0' }, got: r.params.clientCapabilities } }); continue; }
  ${body} } });`],
});

it('advertises form elicitation, answers requests and fans out notifications', async () => {
  const rpc = agent(`if (r.method === 'echo') { out({ method: 'session/update', params: { n: 1 } }); out({ id: r.id, result: r.params }); }`);
  const notes: unknown[] = [];
  rpc.onNotification((method, params) => notes.push([method, params]));
  expect((await rpc.ready).got).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } });
  expect(await rpc.request('echo', { a: 1 })).toEqual({ a: 1 });
  expect(notes).toEqual([['session/update', { n: 1 }]]);
  await rpc.close();
});

it('agent requests reach the handler; without one the agent hears Method not found', async () => {
  const rpc = agent(`if (r.method === 'go') out({ id: 'q', method: 'session/request_permission', params: { x: 1 } });
  else if (r.id === 'q') out({ method: 'answered', params: r });`);
  const answered = () => new Promise<Record<string, unknown>>((resolve) => { const off = rpc.onNotification((m, p) => { if (m === 'answered') { off(); resolve(p); } }); });
  await rpc.ready;
  let wait = answered(); rpc.notify('go');
  expect((await wait).error).toEqual({ code: -32601, message: 'Method not found' });
  rpc.onRequest(async (r) => ({ outcome: r.params.x }));
  wait = answered(); rpc.notify('go');
  expect((await wait).result).toEqual({ outcome: 1 });
  await rpc.close();
});

it('errors keep code and data; timeoutMs 0 outlives the default timeout', async () => {
  const rpc = agent(`if (r.method === 'bad') out({ id: r.id, error: { code: -32603, message: 'Internal error', data: { details: 'ACP session not found: x' } } });
  if (r.method === 'slow') setTimeout(() => out({ id: r.id, result: 'late' }), 400);`);
  const e = await rpc.request('bad').catch((x: unknown) => x);
  expect(e).toBeInstanceOf(AcpError);
  expect([(e as AcpError).code, (e as AcpError).data]).toEqual([-32603, { details: 'ACP session not found: x' }]);
  await expect(rpc.request('slow', {}, { timeoutMs: 150 })).rejects.toThrow('omp slow timed out');
  expect(await rpc.request('slow', {}, { timeoutMs: 0 })).toBe('late');
  await rpc.close();
});

it('a malformed frame or an exit fails pending requests and resolves closed', async () => {
  const bad = agent(`if (r.method === 'x') process.stdout.write('not json\\n');`);
  await expect(bad.request('x')).rejects.toThrow('Invalid omp JSON frame');
  await bad.closed;
  const gone = agent(`if (r.method === 'x') process.exit(3);`);
  await expect(gone.request('x')).rejects.toThrow('omp exited (3)');
  await gone.closed;
});

it('a missing binary names the agent', async () => {
  const rpc = new AcpRpc({ name: 'omp', command: '/nonexistent/omp', args: ['acp'], clientVersion: '0.0.0', installHint: ' Install omp.' });
  await expect(rpc.ready).rejects.toThrow('Cannot start omp (ENOENT). Install omp.');
});
