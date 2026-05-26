import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommandsEmbed } from './help.js';

test('help commands embed lists voice verbose and debug text commands', () => {
  const embed = buildCommandsEmbed().toJSON();
  const names = embed.fields?.map((field) => field.name) ?? [];

  assert(names.includes('/voice-verbose'));
  assert(names.includes('/debugtext'));
});
