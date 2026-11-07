import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveConversationPage } from '../../src/components/ai/conversationPage.js';

test('conversation rendering uses a bounded tail without dropping stored history', () => {
    const messages = Array.from({ length: 1000 }, (_, index) => ({ id: `message-${index}` }));
    assert.deepEqual(resolveConversationPage(messages, null), { start: 900, end: 1000 });
    assert.deepEqual(resolveConversationPage(messages, { id: 'message-0', index: 0 }), {
        start: 0,
        end: 100,
    });
    assert.equal(messages.length, 1000);
});

test('historical page anchors survive appends and removal of earlier ephemeral bubbles', () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({ id: `message-${index}` }));
    const anchor = { id: 'message-100', index: 100 };
    assert.deepEqual(resolveConversationPage([...messages, { id: 'new' }], anchor), {
        start: 100,
        end: 200,
    });
    assert.deepEqual(resolveConversationPage(messages.slice(20), anchor), { start: 80, end: 180 });
    assert.deepEqual(resolveConversationPage([], anchor), { start: 0, end: 0 });
});
