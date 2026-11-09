// The pins of the optional "Whisper on the host" feature: what the installer fetches, nothing else.
/** The npm package that runs the model (ONNX runtime inside); installed under <stateBase>/whisper, not into Nota Bene itself. */
export const WHISPER_PACKAGE = '@huggingface/transformers';
export const WHISPER_VERSION = '4.3.2';
/** Multilingual Whisper small, ONNX; loaded with dtype q8 (encoder_model_quantized + decoder_model_merged_quantized). */
export const WHISPER_MODEL = 'onnx-community/whisper-small';
/** The Hugging Face commit the model is pinned to. */
export const WHISPER_REVISION = '36050c46d777d46dc4b5f43f6d90574fc38f8732';
export const WHISPER_DTYPE = 'q8';
/** Approximate download: the q8 files (92 + 157 MB) plus tokenizer and configs, and the package itself. */
export const WHISPER_SIZE_MB = 260;
