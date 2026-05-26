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
  markVoiceSessionUsed,
  setVoiceSessionBotSpeaking,
  setVoiceSessionListenMode,
  setVoiceSessionTtsProvider,
  setVoiceSessionVerbose,
} from './state.js';

test('buildVoiceSessionKey creates a guild-channel scoped ephemeral key', () => {
  const key = buildVoiceSessionKey('guild-1', 'channel-1');

  assert.match(key, /^agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:/);
});

test('buildVoiceSessionKey can target a custom voice agent namespace', () => {
  process.env.OPENCLAW_VOICE_AGENT_ID = 'custom-voice';
  const key = buildVoiceSessionKey('guild-1', 'channel-1');
  delete process.env.OPENCLAW_VOICE_AGENT_ID;

  assert.match(key, /^agent:custom-voice:discord:voice:guild:guild-1:channel:channel-1:join:/);
});

test('createVoiceSession stores one active session per guild', () => {
  const created = createVoiceSession('guild-1', 'channel-1', 'user-1', {
    sessionKey: 'agent:discord-voice:discord:voice:guild:guild-1:channel:channel-1:join:test',
    openClawSessionId: 'oc-session-1',
  });

  assert.equal(created.channelId, 'channel-1');
  assert.equal(created.createdByUserId, 'user-1');
  assert.equal(getVoiceSession('guild-1')?.openClawSessionId, 'oc-session-1');
  assert.equal(getVoiceSession('guild-1')?.listenMode, 'slash');

  clearVoiceSession('guild-1');
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

test('voice session tts provider can switch between say, elevenlabs, piper, and openclaw', () => {
  createVoiceSession('guild-tts', 'channel-1', 'user-1');

  const updated = setVoiceSessionTtsProvider('guild-tts', 'elevenlabs');

  assert(updated);
  assert.equal(updated?.ttsProvider, 'elevenlabs');

  setVoiceSessionTtsProvider('guild-tts', 'say');
  assert.equal(getVoiceSession('guild-tts')?.ttsProvider, 'say');

  setVoiceSessionTtsProvider('guild-tts', 'piper');
  assert.equal(getVoiceSession('guild-tts')?.ttsProvider, 'piper');

  setVoiceSessionTtsProvider('guild-tts', 'openclaw');
  assert.equal(getVoiceSession('guild-tts')?.ttsProvider, 'openclaw');

  clearVoiceSession('guild-tts');
});

test('markVoiceSessionUsed stores OpenClaw session details after a real turn', () => {
  createVoiceSession('guild-2', 'channel-2', 'user-2');
  const updated = markVoiceSessionUsed('guild-2', {
    initialized: true,
    sessionKey: 'agent:discord-voice:discord:voice:guild:guild-2:channel:channel-2:join:canonical',
    openClawSessionId: 'oc-session-456',
  });

  assert(updated);
  assert.equal(updated?.sessionKey, 'agent:discord-voice:discord:voice:guild:guild-2:channel:channel-2:join:canonical');
  assert.equal(updated?.openClawSessionId, 'oc-session-456');
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
