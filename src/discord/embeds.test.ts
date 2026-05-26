import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAllVoiceState, createVoiceSession } from '../state.js';
import {
  buildJoinControls,
  buildJoinEmbed,
  buildVoiceTtsButtons,
  formatTtsProvider,
  buildVoiceVerboseButtons,
  buildVoiceVerbosePromptEmbed,
  VOICE_MODE_AUTO,
  VOICE_MODE_SLASH,
  VOICE_TTS_ELEVENLABS,
  VOICE_TTS_HERMES,
  VOICE_TTS_PIPER,
  VOICE_TTS_SAY,
  VOICE_VERBOSE_DISABLE,
  VOICE_VERBOSE_ENABLE,
} from './embeds.js';

function getCustomIds(row: ReturnType<ReturnType<typeof buildVoiceVerboseButtons>[number]['toJSON']>) {
  return row.components.map((component) => ('custom_id' in component ? component.custom_id : null));
}

test.afterEach(() => {
  clearAllVoiceState();
});

test('buildVoiceVerboseButtons exposes yes/no actions', () => {
  const row = buildVoiceVerboseButtons(false)[0].toJSON();
  assert.deepEqual(getCustomIds(row), [VOICE_VERBOSE_ENABLE, VOICE_VERBOSE_DISABLE]);
});

test('buildVoiceTtsButtons exposes all provider switches', () => {
  const row = buildVoiceTtsButtons('piper')[0].toJSON();
  assert.deepEqual(getCustomIds(row), [VOICE_TTS_SAY, VOICE_TTS_PIPER, VOICE_TTS_ELEVENLABS, VOICE_TTS_HERMES]);
});

test('buildJoinControls combines talk-mode and tts controls', () => {
  const session = createVoiceSession('guild-1', 'channel-1', 'user-1');
  const rows = buildJoinControls(session).map((row) => row.toJSON());

  assert.deepEqual(getCustomIds(rows[0]), [VOICE_MODE_SLASH, VOICE_MODE_AUTO]);
  assert.deepEqual(getCustomIds(rows[1]), [VOICE_TTS_SAY, VOICE_TTS_PIPER, VOICE_TTS_ELEVENLABS, VOICE_TTS_HERMES]);
});

test('buildJoinEmbed includes mode, tts, and warning fields', () => {
  const session = createVoiceSession('guild-1', 'channel-1', 'user-1', {
    sessionKey: 'hermes-discord-voice:guild:1:channel:1:join:abc',
    hermesResponseId: 'session-1',
  });
  const embed = buildJoinEmbed(session, {
    channelId: 'channel-1',
    created: true,
    issues: ['ffmpeg is missing'],
  }).toJSON();

  assert.equal(embed.title, 'Voice bridge ready');
  const names = embed.fields?.map((field) => field.name) ?? [];
  assert.deepEqual(names, ['Voice', 'Mode', 'Verbose', 'TTS', 'Session key', 'Session id', 'Next', 'Warnings']);
  assert.match(embed.fields?.find((field) => field.name === 'Mode')?.value ?? '', /Slash-to-talk/);
  assert.match(embed.fields?.find((field) => field.name === 'TTS')?.value ?? '', /Say|Piper|ElevenLabs|Hermes/);
});

test('formatTtsProvider labels Hermes provider', () => {
  assert.equal(formatTtsProvider('hermes'), 'Hermes');
});

test('buildVoiceVerbosePromptEmbed reflects active thread state', () => {
  const session = createVoiceSession('guild-1', 'channel-1', 'user-1');
  session.verboseEnabled = true;
  session.verboseThreadId = 'thread-1';

  const embed = buildVoiceVerbosePromptEmbed(session).toJSON();
  assert.equal(embed.title, 'Voice verbose mode');
  assert.match(embed.fields?.find((field) => field.name === 'Current status')?.value ?? '', /thread-1/);
});
