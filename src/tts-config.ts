import path from 'node:path';

import type { TtsProvider } from './audio.js';

export function resolveConfiguredPath(configured: string | undefined, defaultSegments: string[]): string {
  const trimmed = configured?.trim();
  if (trimmed) return path.resolve(process.cwd(), trimmed);
  return path.resolve(process.cwd(), ...defaultSegments);
}

export function getConfiguredTtsProvider(env: NodeJS.ProcessEnv = process.env): TtsProvider {
  const provider = env.TTS_PROVIDER?.trim().toLowerCase();
  if (provider === 'hermes') return 'hermes';
  if (provider === 'elevenlabs') return 'elevenlabs';
  if (provider === 'piper') return 'piper';
  return 'say';
}

export function getPiperBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfiguredPath(env.PIPER_BINARY_PATH, ['tools', 'piper-venv', 'bin', 'python']);
}

export function getPiperModelPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfiguredPath(env.PIPER_MODEL_PATH, ['models', 'piper', 'de_DE-thorsten-medium.onnx']);
}
