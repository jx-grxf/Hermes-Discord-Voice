import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
} from '@discordjs/voice';
import { getWhisperModelPath } from './diagnostics.js';
import { getConfiguredTtsProvider, getPiperBinaryPath, getPiperModelPath } from './tts-config.js';

export type TtsProvider = 'say' | 'elevenlabs' | 'piper' | 'hermes';
export type PlaybackResult = {
  interrupted: boolean;
};
type SynthesizeSpeechOptions = {
  signal?: AbortSignal;
};
type ChildProcessOptions = {
  signal?: AbortSignal;
};

export function calculatePlaybackTimeoutMs(
  durationMs: number | null,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configuredMin = Number(env.PLAYBACK_TIMEOUT_MIN_MS ?? '');
  const configuredGrace = Number(env.PLAYBACK_TIMEOUT_GRACE_MS ?? '');
  const minMs = Number.isFinite(configuredMin) && configuredMin >= 5_000 ? Math.floor(configuredMin) : 60_000;
  const graceMs = Number.isFinite(configuredGrace) && configuredGrace >= 1_000 ? Math.floor(configuredGrace) : 15_000;

  if (!Number.isFinite(durationMs) || durationMs === null || durationMs <= 0) {
    return minMs;
  }

  return Math.max(minMs, Math.ceil(durationMs + graceMs));
}

function readWavDurationMs(filePath: string): number | null {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let bitsPerSample: number | null = null;
  let dataSize: number | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) break;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!sampleRate || !channels || !bitsPerSample || !dataSize) return null;

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;

  return (dataSize / bytesPerSecond) * 1000;
}

function formatTimeoutMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function convertPcmToWav(
  pcmPath: string,
  wavPath: string,
  options: ChildProcessOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw abortError('Audio conversion was interrupted.');

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', pcmPath,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      wavPath,
      '-y',
    ]);
    let stderr = '';
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;

    const onAbort = () => {
      aborted = true;
      ffmpeg.kill('SIGTERM');
      killTimer = setTimeout(() => ffmpeg.kill('SIGKILL'), 2_000);
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    ffmpeg.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted || options.signal?.aborted) {
        reject(abortError('Audio conversion was interrupted.'));
        return;
      }
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${stderr || 'no additional details'}`));
    });
  });
}

export async function convertAudioToDiscordWav(
  inputPath: string,
  wavPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal?.aborted) throw abortError('Discord playback conversion was interrupted.');

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      '-ar', '48000',
      '-ac', '2',
      '-c:a', 'pcm_s16le',
      wavPath,
      '-y',
    ]);
    let stderr = '';
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;

    const onAbort = () => {
      aborted = true;
      ffmpeg.kill('SIGTERM');
      killTimer = setTimeout(() => ffmpeg.kill('SIGKILL'), 2_000);
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    ffmpeg.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted || options.signal?.aborted) {
        reject(abortError('Discord playback conversion was interrupted.'));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg playback conversion exited with code ${code}: ${stderr || 'no additional details'}`));
    });
  });
}

export function createRequestTempDir(): string {
  const root = path.resolve(process.cwd(), 'tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'listen-'));
}

export async function removeRequestTempDir(dirPath: string): Promise<void> {
  await fs.promises.rm(dirPath, { recursive: true, force: true });
}

export function getWhisperThreadCount(): number {
  const raw = Number(process.env.WHISPER_THREADS ?? '');
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.max(1, Math.floor(raw));
  }

  return Math.max(1, Math.min(8, os.availableParallelism?.() ?? 4));
}

export function buildWhisperCliArgs(modelPath: string, wavPath: string, transcriptBasePath: string): string[] {
  const language = process.env.WHISPER_LANGUAGE?.trim().toLowerCase() || 'auto';

  return [
    '-m', modelPath,
    '-f', wavPath,
    '-otxt',
    '-of', transcriptBasePath,
    '-l', language,
    '-t', String(getWhisperThreadCount()),
    '-np',
    '-nt',
  ];
}

export async function transcribeWav(
  wavPath: string,
  transcriptBasePath: string,
  options: ChildProcessOptions = {},
): Promise<string> {
  const modelPath = getWhisperModelPath();
  if (!fs.existsSync(modelPath)) throw new Error(`Whisper model missing: ${modelPath}`);
  if (options.signal?.aborted) throw abortError('Whisper transcription was interrupted.');

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('whisper-cli', buildWhisperCliArgs(modelPath, wavPath, transcriptBasePath), {
      cwd: process.cwd(),
    });

    let stderr = '';
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      aborted = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => proc.kill('SIGKILL'), 2_000);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    proc.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (aborted || options.signal?.aborted) {
        reject(abortError('Whisper transcription was interrupted.'));
        return;
      }
      if (code !== 0) return reject(new Error(`whisper-cli exited with code ${code}: ${stderr}`));
      const txtPath = `${transcriptBasePath}.txt`;
      if (!fs.existsSync(txtPath)) return resolve('');
      resolve(fs.readFileSync(txtPath, 'utf8').trim());
    });
  });
}

function getTtsVoice(): string {
  return process.env.TTS_VOICE?.trim() || 'Flo';
}

function getTtsRate(): string {
  const raw = process.env.TTS_RATE?.trim();
  return raw && /^\d+$/.test(raw) ? raw : '220';
}

export function getTtsProvider(): TtsProvider {
  return getConfiguredTtsProvider(process.env);
}

function getElevenLabsApiKey(): string {
  const value = process.env.ELEVENLABS_API_KEY?.trim();
  if (!value) {
    throw new Error('ELEVENLABS_API_KEY is required when TTS_PROVIDER=elevenlabs.');
  }
  return value;
}

function getElevenLabsVoiceId(): string {
  const value = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!value) {
    throw new Error('ELEVENLABS_VOICE_ID is required when TTS_PROVIDER=elevenlabs.');
  }
  return value;
}

function getElevenLabsModelId(): string {
  return process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2';
}

function getElevenLabsOutputFormat(): string {
  return process.env.ELEVENLABS_OUTPUT_FORMAT?.trim() || 'mp3_44100_128';
}

function getElevenLabsTimeoutMs(): number {
  const raw = Number(process.env.ELEVENLABS_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

function getPiperSpeaker(): string | null {
  const configured = process.env.PIPER_SPEAKER?.trim();
  return configured || null;
}

export function getTtsOutputExtension(): string {
  return getTtsOutputExtensionForProvider(getTtsProvider());
}

export function getTtsOutputExtensionForProvider(provider: TtsProvider): string {
  if (provider === 'elevenlabs') return 'mp3';
  if (provider === 'piper') return 'wav';
  if (provider === 'hermes') return 'audio';
  return 'aiff';
}

export async function synthesizeWithSay(text: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('say', ['-v', getTtsVoice(), '-r', getTtsRate(), '-o', outPath, text]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`say exited with code ${code}: ${stderr || 'no additional details'}`));
    });
  });
}

export async function synthesizeWithElevenLabs(
  text: string,
  outPath: string,
  options: SynthesizeSpeechOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw abortError('ElevenLabs TTS was interrupted.');

  const controller = new AbortController();
  let externalAborted = false;
  const onAbort = () => {
    externalAborted = true;
    controller.abort();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), getElevenLabsTimeoutMs());

  let response: Response;
  try {
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(getElevenLabsVoiceId())}`);
    url.searchParams.set('output_format', getElevenLabsOutputFormat());

    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': getElevenLabsApiKey(),
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: getElevenLabsModelId(),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (externalAborted || options.signal?.aborted) {
      throw abortError('ElevenLabs TTS was interrupted.');
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`ElevenLabs TTS timed out after ${getElevenLabsTimeoutMs()}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed with status ${response.status}: ${detail || 'no additional details'}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(outPath, audioBuffer);
}

function getHermesTtsCommand(): string {
  const command = process.env.HERMES_TTS_COMMAND?.trim();
  if (!command) {
    throw new Error('HERMES_TTS_COMMAND is required when TTS_PROVIDER=hermes. The command receives output path and text as arguments.');
  }
  return command;
}

export async function synthesizeWithHermes(text: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(getHermesTtsCommand(), [outPath, text], {
      cwd: process.cwd(),
      env: process.env,
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Hermes TTS command exited with code ${code}: ${stderr || 'no additional details'}`));
    });
  });
}

export async function synthesizeWithPiper(text: string, outPath: string): Promise<void> {
  const binaryPath = getPiperBinaryPath();
  const modelPath = getPiperModelPath();

  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Piper binary missing: ${binaryPath}`);
  }

  if (!fs.existsSync(modelPath)) {
    throw new Error(`Piper model missing: ${modelPath}`);
  }

  await new Promise<void>((resolve, reject) => {
    const isPythonLauncher = /(^|\/)python[0-9.]*$/.test(binaryPath);
    const args = [
      ...(isPythonLauncher ? ['-m', 'piper'] : []),
      '--model',
      modelPath,
      '--output_file',
      outPath,
    ];
    const speaker = getPiperSpeaker();
    if (speaker) {
      args.push('--speaker', speaker);
    }

    const proc = spawn(binaryPath, args, {
      cwd: process.cwd(),
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`piper exited with code ${code}: ${stderr || 'no additional details'}`));
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

export async function synthesizeSpeech(
  text: string,
  outPath: string,
  provider: TtsProvider = getTtsProvider(),
  options: SynthesizeSpeechOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw abortError('TTS was interrupted.');

  if (provider === 'hermes') {
    await synthesizeWithHermes(text, outPath);
    return;
  }

  if (provider === 'elevenlabs') {
    await synthesizeWithElevenLabs(text, outPath, options);
    return;
  }

  if (provider === 'piper') {
    await synthesizeWithPiper(text, outPath);
    return;
  }

  await synthesizeWithSay(text, outPath);
}

export async function playAudioFile(
  connection: VoiceConnection,
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<PlaybackResult> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new Error(`TTS produced no playable audio at ${filePath}.`);
  }

  const playbackPath = path.join(path.dirname(filePath), 'discord-playback.wav');
  try {
    await convertAudioToDiscordWav(filePath, playbackPath, { signal: options.signal });
  } catch (error) {
    if (isAbortError(error)) return { interrupted: true };
    throw error;
  }
  const playbackStat = await fs.promises.stat(playbackPath).catch(() => null);
  if (!playbackStat || playbackStat.size === 0) {
    throw new Error(`Discord playback conversion produced no audio at ${playbackPath}.`);
  }
  const playbackDurationMs = readWavDurationMs(playbackPath);
  const playbackTimeoutMs = calculatePlaybackTimeoutMs(playbackDurationMs);

  console.log('Preparing Discord playback', {
    inputPath: filePath,
    inputBytes: stat.size,
    playbackPath,
    playbackBytes: playbackStat.size,
    playbackDurationMs,
    playbackTimeoutMs,
    guildId: connection.joinConfig.guildId,
    channelId: connection.joinConfig.channelId,
  });

  if (options.signal?.aborted) {
    return { interrupted: true };
  }

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const probe = await demuxProbe(fs.createReadStream(playbackPath));
  const resource = createAudioResource(probe.stream, { inputType: probe.type ?? StreamType.Arbitrary });
  const subscription = connection.subscribe(player);
  if (!subscription) {
    throw new Error('Discord voice playback failed because the connection has no active subscriber.');
  }

  return await new Promise<PlaybackResult>((resolve, reject) => {
    let settled = false;
    let playbackTimeout: NodeJS.Timeout;

    function onAbort() {
      finish(undefined, true);
    }

    function finish(error?: Error, interrupted = false) {
      if (settled) return;
      settled = true;
      clearTimeout(playbackTimeout);
      options.signal?.removeEventListener('abort', onAbort);
      player.removeAllListeners();
      player.stop(true);
      if (error) {
        reject(error);
        return;
      }
      resolve({ interrupted });
    }

    playbackTimeout = setTimeout(() => {
      finish(new Error(`Discord voice playback did not finish within ${formatTimeoutMs(playbackTimeoutMs)}.`));
    }, playbackTimeoutMs);

    player.on('stateChange', (oldState, newState) => {
      console.log('Discord audio player state changed', {
        from: oldState.status,
        to: newState.status,
        guildId: connection.joinConfig.guildId,
        channelId: connection.joinConfig.channelId,
      });
    });

    options.signal?.addEventListener('abort', onAbort, { once: true });
    player.once('error', (error) => finish(error));
    player.once(AudioPlayerStatus.Idle, () => finish());
    player.play(resource);

    void entersState(player, AudioPlayerStatus.Playing, 5_000).catch((error) => {
      if (settled) return;
      finish(new Error(`Discord voice playback never started: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}
