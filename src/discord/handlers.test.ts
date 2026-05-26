import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDebugText, handleJoin, handleStopVoice } from './handlers.js';

test('handlers module exports join handler', () => {
  assert.equal(typeof handleJoin, 'function');
});

test('handlers module exports debug text handler', () => {
  assert.equal(typeof handleDebugText, 'function');
});

test('handlers module exports stop voice handler', () => {
  assert.equal(typeof handleStopVoice, 'function');
});
