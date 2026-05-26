import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAge, truncate } from './utils.js';

test('truncate returns empty string for non-positive limits', () => {
  assert.equal(truncate('hello', 0), '');
  assert.equal(truncate('hello', -1), '');
});

test('truncate keeps single-character budget valid', () => {
  assert.equal(truncate('hello', 1), '…');
  assert.equal(truncate('h', 1), 'h');
});

test('formatAge returns just now for under one minute', () => {
  assert.equal(formatAge(0), 'just now');
  assert.equal(formatAge(59_999), 'just now');
});

test('formatAge returns minutes ago for under one hour', () => {
  assert.equal(formatAge(60_000), '1m ago');
  assert.equal(formatAge(3_599_999), '59m ago');
});

test('formatAge returns hours ago for under one day', () => {
  assert.equal(formatAge(3_600_000), '1h ago');
  assert.equal(formatAge(86_399_999), '23h ago');
});

test('formatAge returns days ago for one day or more', () => {
  assert.equal(formatAge(86_400_000), '1d ago');
  assert.equal(formatAge(172_800_000), '2d ago');
});
