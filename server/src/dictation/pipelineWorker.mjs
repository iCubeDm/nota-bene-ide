// The Whisper pipeline's worker thread: onnxruntime-node runs native code on the calling thread, so the model load and every
// transcription happen here, never on the server's event loop. Plain JavaScript on purpose: it runs unchanged from the checkout
// and from the published package (where the server is bundled and only this file and the lockfile are copied beside it).
// Protocol (see pipelineHost.ts): in {id, audio, opts} / {type:'dispose'}; out {type:'ready'} | {type:'error', message} | {id, text} | {id, error}.
// {id, audio, detect: true} answers {id, probs}: the probability of each language the model knows (detect.ts decides what to do with them).
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const { dir, pkg, model, revision, dtype } = workerData;
let pipe;
let api;

try {
  const resolved = createRequire(path.join(dir, 'package.json')).resolve(pkg);
  const mod = await import(pathToFileURL(resolved).href);
  api = mod.pipeline ? mod : mod.default;
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
    if (m.detect) return parentPort.postMessage({ id: m.id, probs: await detectLanguage(m.audio) });
    const out = await pipe(m.audio, m.opts);
    parentPort.postMessage({ id: m.id, text: out?.text ?? '' });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * One decoder step after the start token: the logits at that position rank the language tokens (<|en|>, <|ru|>, ...), so a
 * softmax over those alone is the model's belief about the spoken language. Needs no past cache; costs one encoder pass.
 * transformers.js 4.3.2 does not do this itself (modeling_whisper.js defaults to English), and `decoder_input_ids` must be a Tensor.
 */
async function detectLanguage(audio) {
  const model = pipe.model;
  const gc = model.generation_config;
  const { input_features } = await pipe.processor(audio);
  const start = gc.decoder_start_token_id ?? model.config.decoder_start_token_id;
  const decoder_input_ids = new api.Tensor('int64', BigInt64Array.from([BigInt(start)]), [1, 1]);
  const { logits, ...rest } = await model.forward({ input_features, decoder_input_ids });
  const row = Float32Array.from(logits.data.subarray(logits.data.length - logits.dims.at(-1)));
  // Only the logits matter: the rest holds the decoder cache, cross-attention over 1500 frames (~110 MB for whisper-small).
  for (const t of Object.values(rest)) {
    if (typeof t?.dispose === 'function') t.dispose();
    else if (t && typeof t === 'object') for (const u of Object.values(t)) u?.dispose?.();
  }
  logits.dispose?.();
  const langs = Object.entries(gc.lang_to_id).map(([token, id]) => [token.replace(/^<\||\|>$/g, ''), row[id]]);
  const top = Math.max(...langs.map(([, v]) => v));
  const exp = langs.map(([code, v]) => [code, Math.exp(v - top)]);
  const sum = exp.reduce((a, [, v]) => a + v, 0);
  return Object.fromEntries(exp.map(([code, v]) => [code, v / sum]));
}
