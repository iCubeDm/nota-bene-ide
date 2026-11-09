// The Whisper pipeline's worker thread: onnxruntime-node runs native code on the calling thread, so the model load and every
// transcription happen here, never on the server's event loop. Plain JavaScript on purpose: it runs unchanged from the checkout
// and from the published package (where the server is bundled and only this file and the lockfile are copied beside it).
// Protocol (see pipelineHost.ts): in {id, audio, opts} / {type:'dispose'}; out {type:'ready'} | {type:'error', message} | {id, text} | {id, error}.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const { dir, pkg, model, revision, dtype } = workerData;
let pipe;

try {
  const resolved = createRequire(path.join(dir, 'package.json')).resolve(pkg);
  const mod = await import(pathToFileURL(resolved).href);
  const api = mod.pipeline ? mod : mod.default;
  if (!api?.pipeline || !api.env) throw new Error(`${pkg} has no pipeline`);
  api.env.cacheDir = path.join(dir, 'models');
  pipe = await api.pipeline('automatic-speech-recognition', model, { revision, dtype });
  parentPort.postMessage({ type: 'ready' });
} catch (e) {
  parentPort.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}

parentPort.on('message', async (m) => {
  if (m.type === 'dispose') {
    try { await pipe.dispose?.(); } catch { /* going away anyway */ }
    process.exit(0);
  }
  try {
    const out = await pipe(m.audio, m.opts);
    parentPort.postMessage({ id: m.id, text: out?.text ?? '' });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
