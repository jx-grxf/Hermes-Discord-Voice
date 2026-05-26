import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAllVoiceState, createVoiceSession } from '../state.js';
import {
  buildListenLogDetails,
  fitEmbedFieldValue,
  formatLatency,
  formatPipelineError,
  formatSessionStatus,
  getListenTimingConfig,
  redactSessionKey,
} from './helpers.js';

test.afterEach(() => {
  clearAllVoiceState();
  delete process.env.VOICE_NO_AUDIO_TIMEOUT_MS;
  delete process.env.VOICE_NO_SPEECH_TIMEOUT_MS;
  delete process.env.VOICE_MAX_CAPTURE_MS;
});

test('redactSessionKey keeps only a short preview for logs', () => {
  assert.equal(
    redactSessionKey('hermes-discord-voice:guild:123:channel:456:join:abcdef'),
    'hermes-discord-voice:gu…',
  );
});

test('buildListenLogDetails redacts identifiers and keeps only coarse runtime state', () => {
  const details = buildListenLogDetails({
    guildId: 'guild-1',
    channelId: 'channel-1',
    speakingStarted: true,
    ssrcMapped: false,
    opusPackets: 12,
    transcriptLength: 34,
    hasHermesResponseId: true,
    sessionKey: 'hermes-discord-voice:guild:123:channel:456:join:abcdef',
  });

  assert.deepEqual(details, {
    guildId: 'guild-1',
    channelId: 'channel-1',
    speakingStarted: true,
    ssrcMapped: false,
    opusPackets: 12,
    opusBytes: undefined,
    pcmBytes: undefined,
    transcriptLength: 34,
    hasHermesResponseId: true,
    sessionKeyPreview: 'hermes-discord-voice:gu…',
  });
});

test('getListenTimingConfig returns sane defaults', () => {
  assert.deepEqual(getListenTimingConfig(), {
    noAudioTimeoutMs: 12_000,
    noSpeechTimeoutMs: 5_000,
    maxCaptureMs: 9_000,
  });
});

test('fitEmbedFieldValue normalizes empty text and truncates long text', () => {
  assert.equal(fitEmbedFieldValue('   '), '—');
  assert.equal(fitEmbedFieldValue('abcdef', 4), 'abc…');
});

test('formatPipelineError maps verbose scope failures to a human-readable message', () => {
  const message = formatPipelineError(new Error('missing scope: operator.write'));
  assert.match(message, /does not have write scope/i);
});

test('formatLatency switches from milliseconds to seconds', () => {
  assert.equal(formatLatency(842), '842 ms');
  assert.equal(formatLatency(3_240), '3.2 s');
});

test('formatSessionStatus reports active session details', () => {
  const session = createVoiceSession('guild-1', 'channel-1', 'user-1', {
    sessionKey: 'hermes-discord-voice:guild:1:channel:1:join:abc',
    hermesResponseId: 'session-1',
  });
  session.lastUsedAt = Date.now() - 5_000;

  const status = formatSessionStatus('guild-1', 'user-1');
  assert.match(status, /Hermes conversation:/);
  assert.match(status, /Hermes response id:/);
  assert.match(status, /Created by Discord user/);
  assert.match(status, /Last used:/);
  assert.doesNotMatch(status, /hermes-discord-voice:guild:1:channel:1:join:abc/);
});
