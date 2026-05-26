import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHermesCliArgs,
  buildHermesSessionKey,
  createHermesSession,
  extractHermesCliSessionId,
  extractHermesReply,
  extractHermesResponseId,
  askHermes,
  type HermesStreamEvent,
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

test('askHermes emits Responses API stream text and tool events', async () => {
  const originalFetch = globalThis.fetch;
  const originalVerboseStream = process.env.HERMES_VERBOSE_STREAM;
  const originalBaseUrl = process.env.HERMES_API_BASE_URL;
  const frames = [
    {
      event: 'response.output_item.added',
      data: {
        item: {
          type: 'function_call',
          name: 'terminal',
          arguments: { cmd: 'date' },
          call_id: 'call_1',
        },
      },
    },
    {
      event: 'response.output_item.added',
      data: {
        item: {
          type: 'function_call_output',
          output: 'Tuesday',
          call_id: 'call_1',
        },
      },
    },
    {
      event: 'response.output_text.delta',
      data: { delta: 'OK' },
    },
    {
      event: 'response.completed',
      data: {
        response: {
          id: 'resp_stream',
          output: [{ content: [{ type: 'output_text', text: 'OK' }] }],
        },
      },
    },
  ];

  const body = frames
    .map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
    .join('');

  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  process.env.HERMES_VERBOSE_STREAM = '1';
  process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:8642/v1';

  try {
    const events: HermesStreamEvent[] = [];
    const result = await askHermes('hello', { sessionKey: 'conversation-1', responseId: null }, {
      onEvent: (event) => {
        events.push(event);
      },
    });

    assert.equal(result.reply, 'OK');
    assert.equal(result.responseId, 'resp_stream');
    assert.equal(requests[0]?.headers.get('x-hermes-session-key'), 'conversation-1');
    const requestBody = await requests[0]?.json() as { instructions?: string };
    assert.match(requestBody.instructions ?? '', /Discord voice conversation/);
    assert.deepEqual(events, [
      { type: 'tool_started', name: 'terminal', arguments: '{"cmd":"date"}', callId: 'call_1' },
      { type: 'tool_completed', name: 'terminal', output: 'Tuesday', callId: 'call_1' },
      { type: 'text_delta', text: 'OK' },
      { type: 'response_completed', responseId: 'resp_stream', text: 'OK' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalVerboseStream === undefined) delete process.env.HERMES_VERBOSE_STREAM;
    else process.env.HERMES_VERBOSE_STREAM = originalVerboseStream;
    if (originalBaseUrl === undefined) delete process.env.HERMES_API_BASE_URL;
    else process.env.HERMES_API_BASE_URL = originalBaseUrl;
  }
});

test('askHermes isolates verbose stream callback errors', async () => {
  const originalFetch = globalThis.fetch;
  const originalVerboseStream = process.env.HERMES_VERBOSE_STREAM;
  const originalBaseUrl = process.env.HERMES_API_BASE_URL;
  const originalWarn = console.warn;
  const body = [
    'event: response.output_text.delta',
    'data: {"delta":"OK"}',
    '',
    'event: response.completed',
    'data: {"response":{"id":"resp_stream","output":[{"content":[{"type":"output_text","text":"OK"}]}]}}',
    '',
  ].join('\n');
  const warnings: unknown[] = [];

  globalThis.fetch = (async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status: 200 },
  )) as typeof fetch;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  process.env.HERMES_VERBOSE_STREAM = '1';
  process.env.HERMES_API_BASE_URL = 'http://127.0.0.1:8642/v1';

  try {
    const result = await askHermes('hello', { sessionKey: 'conversation-1', responseId: null }, {
      onEvent: () => {
        throw new Error('thread send failed');
      },
    });

    assert.equal(result.reply, 'OK');
    assert.equal(result.responseId, 'resp_stream');
    assert.equal(warnings.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalVerboseStream === undefined) delete process.env.HERMES_VERBOSE_STREAM;
    else process.env.HERMES_VERBOSE_STREAM = originalVerboseStream;
    if (originalBaseUrl === undefined) delete process.env.HERMES_API_BASE_URL;
    else process.env.HERMES_API_BASE_URL = originalBaseUrl;
  }
});
