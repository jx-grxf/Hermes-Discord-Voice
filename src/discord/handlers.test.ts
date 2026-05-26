import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAutoInterruptMinSpeechMs,
  handleDebugText,
  handleJoin,
  handleNewVoiceSession,
  handleStopVoice,
  handleVoiceAllowlist,
} from './handlers.js';

test('handlers module exports join handler', () => {
  assert.equal(typeof handleJoin, 'function');
});

test('handlers module exports debug text handler', () => {
  assert.equal(typeof handleDebugText, 'function');
});

test('handlers module exports stop voice handler', () => {
  assert.equal(typeof handleStopVoice, 'function');
});

test('handlers module exports voice session management handlers', () => {
  assert.equal(typeof handleVoiceAllowlist, 'function');
  assert.equal(typeof handleNewVoiceSession, 'function');
});

test('auto interrupt speech threshold defaults and clamps', () => {
  assert.equal(getAutoInterruptMinSpeechMs({}), 750);
  assert.equal(getAutoInterruptMinSpeechMs({ VOICE_AUTO_INTERRUPT_MIN_SPEECH_MS: '100' }), 250);
  assert.equal(getAutoInterruptMinSpeechMs({ VOICE_AUTO_INTERRUPT_MIN_SPEECH_MS: '900' }), 900);
  assert.equal(getAutoInterruptMinSpeechMs({ VOICE_AUTO_INTERRUPT_MIN_SPEECH_MS: '9000' }), 5_000);
});
