import { definePlugin } from '@/sdk';
import { agentTab } from './AgentView.tsx';
import { agentCall } from './AgentCard.tsx';

export const subagentPlugin = definePlugin({ id: 'subagent', tabs: [agentTab], tools: [agentCall] });
