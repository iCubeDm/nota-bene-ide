// The pins of the optional "Whisper on the host" feature: what the installer fetches, nothing else.
/** The npm package that runs the model (ONNX runtime inside); installed under <stateBase>/whisper, not into Nota Bene itself. */
export const WHISPER_PACKAGE = '@huggingface/transformers';
export const WHISPER_VERSION = '4.3.2';
/** Multilingual Whisper small, ONNX; loaded with dtype q8 (encoder_model_quantized + decoder_model_merged_quantized). */
export const WHISPER_MODEL = 'onnx-community/whisper-small';
/** The Hugging Face commit the model is pinned to. */
export const WHISPER_REVISION = '36050c46d777d46dc4b5f43f6d90574fc38f8732';
export const WHISPER_DTYPE = 'q8';
/**
 * What the install costs, measured from the registry for the pinned lockfile (npm-shrinkwrap.json) and the pinned model files.
 * Transitive packages for one platform: onnxruntime-node 113.5 MB tarball / 301 MB unpacked, onnxruntime-web 33.2 / 145 MB,
 * sharp with its libvips ~9 / 20 MB, the rest small: 163-172 MB tarballs, 494-514 MB unpacked (macOS, Windows, Linux x64; the
 * largest is Linux x64). The q8 model is 92 + 157 MB plus tokenizer and configs, about 255 MB, the same on disk.
 * Rounded up from the largest platform: 172 + 255, and 514 + 255.
 */
export const WHISPER_DOWNLOAD_MB = 430;
export const WHISPER_DISK_MB = 770;
/**
 * The model download (the first load of the pipeline) gives up after this long. 255 MB in 30 minutes is 0.14 MB/s (about
 * 1.1 Mbit/s): slower than that is not a usable install anyway, and a hung connection cannot hold the install lock for good.
 */
export const FETCH_MODEL_TIMEOUT_MS = 30 * 60_000;
