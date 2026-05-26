import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenClawAgentParams,
  buildOpenClawSessionPatchParams,
  buildOpenClawSessionDeleteParams,
  buildOpenClawSessionResetParams,
  deleteOpenClawSession,
  extractOpenClawReply,
  extractReplyFromChatHistory,
  extractOpenClawSessionId,
  extractOpenClawSessionKey,
} from './openclaw.js';

test('extractOpenClawReply prefers structured outputText', () => {
  const raw = JSON.stringify({
    result: {
      outputText: 'Hello from OpenClaw',
      payloads: [{ text: 'Fallback' }],
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Hello from OpenClaw');
});

test('extractOpenClawReply falls back to summary when no final outputText exists', () => {
  const raw = JSON.stringify({
    result: {
      payloads: [{ text: '' }, { content: 'Reply from payload' }],
      meta: { summaryText: 'Summary reply' },
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Summary reply');
});

test('extractOpenClawReply joins meaningful payload text when tools emit interim and final text', () => {
  const raw = JSON.stringify({
    result: {
      payloads: [
        { text: 'Ich schaue kurz nach.' },
        { content: '' },
        { content: 'Finale Antwort mit den echten Ergebnissen.' },
      ],
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Ich schaue kurz nach.\n\nFinale Antwort mit den echten Ergebnissen.');
});

test('extractOpenClawReply still prefers summary over payload chatter when available', () => {
  const raw = JSON.stringify({
    result: {
      payloads: [
        { text: 'Ich prüfe das kurz.' },
        { content: 'Noch ein Zwischenstand.' },
      ],
      meta: { summaryText: 'Zusammenfassung mit finaler Antwort.' },
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Zusammenfassung mit finaler Antwort.');
});

test('extractOpenClawReply ignores completed placeholder text and uses payloads instead', () => {
  const raw = JSON.stringify({
    summary: 'completed',
    text: 'completed',
    result: {
      text: 'completed',
      payloads: [{ text: 'Die echte finale Antwort.' }],
    },
  });

  assert.equal(extractOpenClawReply(raw), 'Die echte finale Antwort.');
});

test('extractReplyFromChatHistory prefers final assistant answer over commentary', () => {
  const reply = extractReplyFromChatHistory([
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Ich schaue kurz nach.',
          textSignature: '{"v":1,"phase":"commentary"}',
        },
      ],
      timestamp: 1,
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Hier ist die finale Antwort.',
          textSignature: '{"v":1,"phase":"final_answer"}',
        },
      ],
      timestamp: 2,
    },
  ]);

  assert.equal(reply, 'Hier ist die finale Antwort.');
});

test('extractReplyFromChatHistory joins multi-block final answers from the same assistant message', () => {
  const reply = extractReplyFromChatHistory([
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Teil eins der finalen Antwort.',
          textSignature: '{"v":1,"phase":"final_answer"}',
        },
        {
          type: 'text',
          text: 'Teil zwei der finalen Antwort.',
          textSignature: '{"v":1,"phase":"final_answer"}',
        },
      ],
      timestamp: 1,
    },
  ]);

  assert.equal(reply, 'Teil eins der finalen Antwort.\n\nTeil zwei der finalen Antwort.');
});

test('extractReplyFromChatHistory falls back to the latest commentary when no final answer exists yet', () => {
  const reply = extractReplyFromChatHistory([
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Ich schaue erst noch nach.',
          textSignature: '{"v":1,"phase":"commentary"}',
        },
      ],
      timestamp: 1,
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Noch ein Zwischenstand.',
          textSignature: '{"v":1,"phase":"commentary"}',
        },
      ],
      timestamp: 2,
    },
  ]);

  assert.equal(reply, 'Noch ein Zwischenstand.');
});

test('extractOpenClawReply returns raw text when input is not json', () => {
  assert.equal(extractOpenClawReply('Direct reply'), 'Direct reply');
});

test('extractOpenClawSession metadata when available', () => {
  const raw = JSON.stringify({
    result: {
      outputText: 'Hello',
      sessionId: 'oc-session-123',
      sessionKey: 'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test',
    },
  });

  assert.equal(extractOpenClawSessionId(raw), 'oc-session-123');
  assert.equal(extractOpenClawSessionKey(raw), 'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test');
});

test('buildOpenClawAgentParams targets the stable session key and optional session id', () => {
  const params = buildOpenClawAgentParams('Hello there', {
    sessionKey: 'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test',
    sessionId: 'oc-session-123',
  });

  assert.equal(typeof params.idempotencyKey, 'string');
  assert.equal(String(params.idempotencyKey).startsWith('openclaw-discord-voice-'), true);
  assert.equal(params.message, 'Hello there');
  assert.equal(params.sessionKey, 'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test');
  assert.equal(params.sessionId, 'oc-session-123');
  assert.equal(params.thinking, 'off');
});

test('buildOpenClawSessionResetParams creates a new gateway reset request', () => {
  const params = buildOpenClawSessionResetParams('agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test');

  assert.deepEqual(params, {
    key: 'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test',
    reason: 'new',
  });
});

test('buildOpenClawSessionDeleteParams creates a delete request with transcript cleanup', () => {
  const params = buildOpenClawSessionDeleteParams('agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test');

  assert.deepEqual(params, {
    key: 'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test',
    deleteTranscript: true,
  });
});

test('buildOpenClawSessionPatchParams creates a patch request for verbose mode', () => {
  const params = buildOpenClawSessionPatchParams(
    'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test',
    { verboseLevel: 'full' },
  );

  assert.deepEqual(params, {
    key: 'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test',
    verboseLevel: 'full',
  });
});

test('deleteOpenClawSession export remains callable', () => {
  assert.equal(typeof deleteOpenClawSession, 'function');
});
