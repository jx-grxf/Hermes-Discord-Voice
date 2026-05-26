import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHermesSessionKey,
  createHermesSession,
  extractHermesReply,
  extractHermesResponseId,
} from './hermes.js';

test('extractHermesReply returns raw text for CLI quiet output', () => {
  assert.equal(extractHermesReply('Direct Hermes reply'), 'Direct Hermes reply');
});

test('extractHermesReply reads Responses API output_text', () => {
  const raw = JSON.stringify({
    id: 'resp_123',
    output_text: 'Hello from Hermes API',
  });

  assert.equal(extractHermesReply(raw), 'Hello from Hermes API');
});

test('extractHermesReply reads Responses API output content blocks', () => {
  const raw = JSON.stringify({
    output: [
      {
        content: [
          { type: 'output_text', text: 'Part one.' },
          { type: 'output_text', text: 'Part two.' },
        ],
      },
    ],
  });

  assert.equal(extractHermesReply(raw), 'Part one.\n\nPart two.');
});

test('extractHermesReply reads OpenAI-compatible chat choices', () => {
  const raw = JSON.stringify({
    choices: [
      {
        message: {
          content: [{ type: 'text', text: 'Choice reply' }],
        },
      },
    ],
  });

  assert.equal(extractHermesReply(raw), 'Choice reply');
});

test('extractHermesResponseId reads response ids', () => {
  assert.equal(extractHermesResponseId(JSON.stringify({ id: 'resp_abc' })), 'resp_abc');
  assert.equal(extractHermesResponseId(JSON.stringify({ response_id: 'resp_def' })), 'resp_def');
});

test('buildHermesSessionKey creates a fresh guild-channel conversation key', () => {
  const key = buildHermesSessionKey('guild-1', 'channel-1');

  assert.match(key, /^hermes-discord-voice:guild:guild-1:channel:channel-1:join:/);
});

test('createHermesSession returns an empty response chain for a new voice session', () => {
  assert.deepEqual(createHermesSession('conversation-1'), {
    sessionKey: 'conversation-1',
    responseId: null,
  });
});
