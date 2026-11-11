/** One sent prompt of the web's prompt history (`/prompts`, HTTP only: not part of the socket protocol). */
export type PromptSrc = 'typed' | 'shell' | 'voice';
export type PromptEntry = { id: string; ts: number; text: string; src: PromptSrc };

/** the longest prompt the history keeps (the server answers 400 above it) */
export const PROMPT_MAX = 32000;
export const PROMPT_SRCS: readonly PromptSrc[] = ['typed', 'shell', 'voice'];
