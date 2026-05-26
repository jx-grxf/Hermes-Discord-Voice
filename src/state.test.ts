import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginGuildJoin,
  beginGuildListen,
  buildVoiceSessionKey,
  clearVoiceSession,
  createVoiceSession,
  endGuildJoin,
  endGuildListen,
  getActiveGuildJoinUser,
  getActiveGuildListenUser,
  getVoiceSession,
  addVoiceSessionSpeaker,
  isVoiceSessionSpeakerAllowed,
  listVoiceSessionSpeakers,
  markVoiceSessionUsed,
  removeVoiceSessionSpeaker,
  setVoiceSessionBotSpeaking,
  setVoiceSessionListenMode,
  setVoiceSessionTtsProvider,
  setVoiceSessionVerbose,
} from './state.js';

test('buildVoiceSessionKey creates a guild-channel scoped ephemeral key', () => {
  const key = buildVoiceSessionKey('guild-1', 'channel-1');

  assert.match(key, /^hermes-discord-voice:guild:guild-1:channel:channel-1:join:/);
});

test('buildVoiceSessionKey can target a custom voice agent namespace', () => {
  process.env.HERMES_VOICE_SESSION_PREFIX = 'custom-voice';
  const key = buildVoiceSessionKey('guild-1', 'channel-1');
  delete process.env.HERMES_VOICE_SESSION_PREFIX;

  assert.match(key, /^custom-voice:guild:guild-1:channel:channel-1:join:/);
});

test('createVoiceSession stores one active session per guild', () => {
  const created = createVoiceSession('guild-1', 'channel-1', 'user-1', {
    sessionKey: 'hermes-discord-voice:guild:guild-1:channel:channel-1:join:test',
    hermesResponseId: 'resp_1',
  });

  assert.equal(created.channelId, 'channel-1');
  assert.equal(created.createdByUserId, 'user-1');
  assert.deepEqual(created.speakerAllowlistUserIds, ['user-1']);
  assert.equal(getVoiceSession('guild-1')?.hermesResponseId, 'resp_1');
  assert.equal(getVoiceSession('guild-1')?.listenMode, 'slash');

  clearVoiceSession('guild-1');
});

test('voice session speaker allowlist defaults to creator and supports add remove', () => {
  createVoiceSession('guild-speakers', 'channel-1', 'user-1');

  assert.deepEqual(listVoiceSessionSpeakers('guild-speakers'), ['user-1']);
  assert.equal(isVoiceSessionSpeakerAllowed('guild-speakers', 'user-1'), true);
  assert.equal(isVoiceSessionSpeakerAllowed('guild-speakers', 'user-2'), false);

  addVoiceSessionSpeaker('guild-speakers', 'user-2');
  addVoiceSessionSpeaker('guild-speakers', 'user-2');
  assert.deepEqual(listVoiceSessionSpeakers('guild-speakers'), ['user-1', 'user-2']);
  assert.equal(isVoiceSessionSpeakerAllowed('guild-speakers', 'user-2'), true);

  removeVoiceSessionSpeaker('guild-speakers', 'user-2');
  assert.deepEqual(listVoiceSessionSpeakers('guild-speakers'), ['user-1']);

  clearVoiceSession('guild-speakers');
});

test('voice session speaker allowlist cannot remove creator', () => {
  createVoiceSession('guild-speaker-owner', 'channel-1', 'user-1');
  addVoiceSessionSpeaker('guild-speaker-owner', 'user-2');
  removeVoiceSessionSpeaker('guild-speaker-owner', 'user-1');

  assert.deepEqual(listVoiceSessionSpeakers('guild-speaker-owner'), ['user-1', 'user-2']);
  assert.equal(isVoiceSessionSpeakerAllowed('guild-speaker-owner', 'user-1'), true);

  clearVoiceSession('guild-speaker-owner');
});

test('voice session listen mode can switch to auto with a bound text channel', () => {
  createVoiceSession('guild-mode', 'channel-1', 'user-1');

  const updated = setVoiceSessionListenMode('guild-mode', 'auto', { textChannelId: 'text-1' });

  assert(updated);
  assert.equal(updated?.listenMode, 'auto');
  assert.equal(updated?.autoListenTextChannelId, 'text-1');

  clearVoiceSession('guild-mode');
});

test('voice session bot speaking flag can be toggled', () => {
  createVoiceSession('guild-speaking', 'channel-1', 'user-1');

  setVoiceSessionBotSpeaking('guild-speaking', true);
  assert.equal(getVoiceSession('guild-speaking')?.botSpeaking, true);

  setVoiceSessionBotSpeaking('guild-speaking', false);
  assert.equal(getVoiceSession('guild-speaking')?.botSpeaking, false);

  clearVoiceSession('guild-speaking');
});

test('voice session verbose mode can bind a verbose thread', () => {
  createVoiceSession('guild-verbose', 'channel-1', 'user-1');

  const updated = setVoiceSessionVerbose('guild-verbose', true, { threadId: 'thread-1' });

  assert(updated);
  assert.equal(updated?.verboseEnabled, true);
  assert.equal(updated?.verboseThreadId, 'thread-1');
  assert.equal(typeof updated?.verboseStartedAt, 'number');

  setVoiceSessionVerbose('guild-verbose', false);
  assert.equal(getVoiceSession('guild-verbose')?.verboseEnabled, false);
  assert.equal(getVoiceSession('guild-verbose')?.verboseThreadId, null);
  assert.equal(getVoiceSession('guild-verbose')?.verboseStartedAt, null);

  clearVoiceSession('guild-verbose');
});

test('voice session tts provider can switch between say, elevenlabs, piper, and hermes', () => {
  createVoiceSession('guild-tts', 'channel-1', 'user-1');

  const updated = setVoiceSessionTtsProvider('guild-tts', 'elevenlabs');

  assert(updated);
  assert.equal(updated?.ttsProvider, 'elevenlabs');

  setVoiceSessionTtsProvider('guild-tts', 'say');
  assert.equal(getVoiceSession('guild-tts')?.ttsProvider, 'say');

  setVoiceSessionTtsProvider('guild-tts', 'piper');
  assert.equal(getVoiceSession('guild-tts')?.ttsProvider, 'piper');

  setVoiceSessionTtsProvider('guild-tts', 'hermes');
  assert.equal(getVoiceSession('guild-tts')?.ttsProvider, 'hermes');

  clearVoiceSession('guild-tts');
});

test('markVoiceSessionUsed stores Hermes session details after a real turn', () => {
  createVoiceSession('guild-2', 'channel-2', 'user-2');
  const updated = markVoiceSessionUsed('guild-2', {
    initialized: true,
    sessionKey: 'hermes-discord-voice:guild:guild-2:channel:channel-2:join:canonical',
    hermesResponseId: 'resp_456',
  });

  assert(updated);
  assert.equal(updated?.sessionKey, 'hermes-discord-voice:guild:guild-2:channel:channel-2:join:canonical');
  assert.equal(updated?.hermesResponseId, 'resp_456');
  assert.equal(Boolean(updated?.initializedAt), true);
  assert.equal(Boolean(updated?.lastUsedAt), true);

  clearVoiceSession('guild-2');
});

test('clearVoiceSession removes the active guild session', () => {
  createVoiceSession('guild-3', 'channel-3', 'user-3');

  const cleared = clearVoiceSession('guild-3');

  assert(cleared);
  assert.equal(getVoiceSession('guild-3'), null);
});

test('guild listen lock blocks parallel listeners from other users', () => {
  const first = beginGuildListen('guild-lock', 'user-a');
  const second = beginGuildListen('guild-lock', 'user-b');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.activeUserId, 'user-a');
  assert.equal(getActiveGuildListenUser('guild-lock'), 'user-a');

  endGuildListen('guild-lock', 'user-a');
  assert.equal(getActiveGuildListenUser('guild-lock'), null);
});

test('guild listen lock also blocks re-entrant listens from the same user', () => {
  const first = beginGuildListen('guild-lock-same-user', 'user-a');
  const second = beginGuildListen('guild-lock-same-user', 'user-a');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.activeUserId, 'user-a');

  endGuildListen('guild-lock-same-user', 'user-a');
  assert.equal(getActiveGuildListenUser('guild-lock-same-user'), null);
});

test('guild join lock blocks concurrent setup attempts', () => {
  const first = beginGuildJoin('guild-join-lock', 'user-a');
  const second = beginGuildJoin('guild-join-lock', 'user-b');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.activeUserId, 'user-a');
  assert.equal(getActiveGuildJoinUser('guild-join-lock'), 'user-a');

  endGuildJoin('guild-join-lock', 'user-a');
  assert.equal(getActiveGuildJoinUser('guild-join-lock'), null);
});
