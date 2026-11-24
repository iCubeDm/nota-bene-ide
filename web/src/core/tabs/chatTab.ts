import { createContext, useContext, type ReactNode } from 'react';

/** The chat's tab, for the parts of slot `tabs.chat`, which place it among theirs (issue 638: the project's agents);
 * `end` goes inside it, at its end (issue 653: this page's agent's ✕). */
export type ChatTab = (end?: ReactNode) => ReactNode;
export const ChatTabContext = createContext<ChatTab>(() => null);
export const useChatTab = (): ChatTab => useContext(ChatTabContext);
