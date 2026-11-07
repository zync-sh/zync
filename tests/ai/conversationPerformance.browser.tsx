import { createRoot } from 'react-dom/client';

import { useAgentRunStore } from '../../src/ai/store/agentRunStore';
import type { ConversationMessage } from '../../src/ai/types/agent';
import { ConversationThread } from '../../src/components/ai/ConversationThread';
import '../../src/index.css';

const messages: ConversationMessage[] = Array.from({ length: 205 }, (_, index) => ({
    type: index % 10 === 0 ? 'thinking' : 'user',
    id: `fixture-${index}`,
    text: `Fixture message ${index}`,
}));
messages[5] = {
    type: 'tool-call',
    id: 'fixture-5',
    toolCallId: 'old-tool',
    toolName: 'read_file',
    input: { path: '/fixture/old' },
    output: 'Complete historical output',
    status: 'done',
};
messages[204] = {
    type: 'tool-call',
    id: 'fixture-204',
    toolCallId: 'live-tool',
    toolName: 'run_command',
    input: { command: 'fixture command' },
    output: 'First fragment',
    status: 'running',
};
useAgentRunStore.setState({
    conversations: { fixture: messages },
    activeRunIds: { fixture: 'fixture-run' },
});
Object.assign(window, {
    conversationFixture: {
        append() {
            useAgentRunStore
                .getState()
                .appendToolOutput('fixture', 'live-tool', ' and final fragment');
        },
        count() {
            return useAgentRunStore.getState().conversations.fixture.length;
        },
        finishRun() {
            // Finishing removes twelve reasoning bubbles and adds one summary, leaving one page.
            useAgentRunStore.setState({ conversations: { fixture: messages.slice(0, 111) } });
            const store = useAgentRunStore.getState();
            store.clearThinking('fixture', 'fixture');
            store.addDone('fixture', true, 'Finished fixture run', []);
        },
    },
});
createRoot(document.getElementById('root')!).render(
    <div className="flex h-full flex-col">
        <ConversationThread
            scope="fixture"
            activeRunId={null}
        />
    </div>,
);
