import { createContext, useContext, type ReactNode } from 'react';

/** The chat's tab, for the parts of slot `tabs.chat`, which place it among theirs (issue 638: the project's agents). */
export const ChatTabContext = createContext<ReactNode>(null);
export const useChatTab = (): ReactNode => useContext(ChatTabContext);
