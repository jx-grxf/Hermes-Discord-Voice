import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHermesCliArgs,
  buildHermesSessionKey,
  createHermesSession,
  extractHermesCliSessionId,
  extractHermesReply,
  extractHermesResponseId,
  stripHermesCliMetadata,
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

test('extractHermesCliSessionId reads quiet CLI session metadata', () => {
  assert.equal(extractHermesCliSessionId('\nsession_id: 20260526_122954_eabb19\n'), '20260526_122954_eabb19');
  assert.equal(extractHermesCliSessionId('reply only'), null);
});

test('stripHermesCliMetadata removes quiet CLI status lines from replies', () => {
  assert.equal(
    stripHermesCliMetadata('↻ Resumed session 20260526_122954_eabb19 (1 user message, 2 total messages)\r\nSECOND\n'),
    'SECOND',
  );
  assert.equal(stripHermesCliMetadata('\nsession_id: 20260526_122954_eabb19\nFIRST\n'), 'FIRST');
});

test('buildHermesCliArgs starts fresh sessions without continue or resume', () => {
  const originalSource = process.env.HERMES_SOURCE;
  const originalProvider = process.env.HERMES_PROVIDER;
  const originalModel = process.env.HERMES_MODEL;
  const originalToolsets = process.env.HERMES_TOOLSETS;
  const originalSkills = process.env.HERMES_SKILLS;
  delete process.env.HERMES_PROVIDER;
  delete process.env.HERMES_MODEL;
  delete process.env.HERMES_TOOLSETS;
  delete process.env.HERMES_SKILLS;
  process.env.HERMES_SOURCE = 'discord-voice-test';

  try {
    assert.deepEqual(buildHermesCliArgs('hello', { sessionKey: 'bridge-session', responseId: null }), [
      'chat',
      '-q',
      'hello',
      '-Q',
      '--source',
      'discord-voice-test',
    ]);
  } finally {
    if (originalSource === undefined) delete process.env.HERMES_SOURCE;
    else process.env.HERMES_SOURCE = originalSource;
    if (originalProvider === undefined) delete process.env.HERMES_PROVIDER;
    else process.env.HERMES_PROVIDER = originalProvider;
    if (originalModel === undefined) delete process.env.HERMES_MODEL;
    else process.env.HERMES_MODEL = originalModel;
    if (originalToolsets === undefined) delete process.env.HERMES_TOOLSETS;
    else process.env.HERMES_TOOLSETS = originalToolsets;
    if (originalSkills === undefined) delete process.env.HERMES_SKILLS;
    else process.env.HERMES_SKILLS = originalSkills;
  }
});

test('buildHermesCliArgs resumes existing Hermes CLI sessions by id', () => {
  const originalSource = process.env.HERMES_SOURCE;
  process.env.HERMES_SOURCE = 'discord-voice-test';

  try {
    const args = buildHermesCliArgs('again', { sessionKey: 'bridge-session', responseId: '20260526_122954_eabb19' });
    assert.ok(!args.includes('--continue'));
    assert.deepEqual(args.slice(0, 9), [
      'chat',
      '-q',
      'again',
      '-Q',
      '--source',
      'discord-voice-test',
      '--resume',
      '20260526_122954_eabb19',
    ]);
  } finally {
    if (originalSource === undefined) delete process.env.HERMES_SOURCE;
    else process.env.HERMES_SOURCE = originalSource;
  }
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
