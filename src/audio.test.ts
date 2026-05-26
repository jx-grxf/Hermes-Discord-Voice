import test from 'node:test';
import assert from 'node:assert/strict';

import { calculatePlaybackTimeoutMs } from './audio.js';

test('calculatePlaybackTimeoutMs keeps a minimum timeout for short audio', () => {
  assert.equal(calculatePlaybackTimeoutMs(5_000, {}), 60_000);
});

test('calculatePlaybackTimeoutMs scales with long generated speech', () => {
  assert.equal(calculatePlaybackTimeoutMs(75_000, {}), 90_000);
});

test('calculatePlaybackTimeoutMs supports configured minimum and grace', () => {
  assert.equal(
    calculatePlaybackTimeoutMs(75_000, {
      PLAYBACK_TIMEOUT_MIN_MS: '30000',
      PLAYBACK_TIMEOUT_GRACE_MS: '5000',
    }),
    80_000,
  );
});
