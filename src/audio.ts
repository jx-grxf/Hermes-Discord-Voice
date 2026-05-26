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
import { synthesizeOpenClawSpeech } from './openclaw.js';
import { getConfiguredTtsProvider, getPiperBinaryPath, getPiperModelPath } from './tts-config.js';

export type TtsProvider = 'say' | 'elevenlabs' | 'piper' | 'openclaw';

export async function convertPcmToWav(pcmPath: string, wavPath: string): Promise<void> {
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
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
}

export async function convertAudioToDiscordWav(inputPath: string, wavPath: string): Promise<void> {
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
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
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

export async function transcribeWav(wavPath: string, transcriptBasePath: string): Promise<string> {
  const modelPath = getWhisperModelPath();
  if (!fs.existsSync(modelPath)) throw new Error(`Whisper model missing: ${modelPath}`);

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('whisper-cli', buildWhisperCliArgs(modelPath, wavPath, transcriptBasePath), {
      cwd: process.cwd(),
    });

    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
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
  if (provider === 'openclaw') return 'audio';
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

export async function synthesizeWithElevenLabs(text: string, outPath: string): Promise<void> {
  const controller = new AbortController();
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
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`ElevenLabs TTS timed out after ${getElevenLabsTimeoutMs()}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed with status ${response.status}: ${detail || 'no additional details'}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(outPath, audioBuffer);
}

export async function synthesizeWithOpenClaw(text: string, outPath: string): Promise<void> {
  const result = await synthesizeOpenClawSpeech(text);
  await fs.promises.copyFile(result.audioPath, outPath);
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

export async function synthesizeSpeech(text: string, outPath: string, provider: TtsProvider = getTtsProvider()): Promise<void> {
  if (provider === 'openclaw') {
    await synthesizeWithOpenClaw(text, outPath);
    return;
  }

  if (provider === 'elevenlabs') {
    await synthesizeWithElevenLabs(text, outPath);
    return;
  }

  if (provider === 'piper') {
    await synthesizeWithPiper(text, outPath);
    return;
  }

  await synthesizeWithSay(text, outPath);
}

export async function playAudioFile(connection: VoiceConnection, filePath: string): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new Error(`TTS produced no playable audio at ${filePath}.`);
  }

  const playbackPath = path.join(path.dirname(filePath), 'discord-playback.wav');
  await convertAudioToDiscordWav(filePath, playbackPath);
  const playbackStat = await fs.promises.stat(playbackPath).catch(() => null);
  if (!playbackStat || playbackStat.size === 0) {
    throw new Error(`Discord playback conversion produced no audio at ${playbackPath}.`);
  }

  console.log('Preparing Discord playback', {
    inputPath: filePath,
    inputBytes: stat.size,
    playbackPath,
    playbackBytes: playbackStat.size,
    guildId: connection.joinConfig.guildId,
    channelId: connection.joinConfig.channelId,
  });

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const probe = await demuxProbe(fs.createReadStream(playbackPath));
  const resource = createAudioResource(probe.stream, { inputType: probe.type ?? StreamType.Arbitrary });
  const subscription = connection.subscribe(player);
  if (!subscription) {
    throw new Error('Discord voice playback failed because the connection has no active subscriber.');
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    player.on('stateChange', (oldState, newState) => {
      console.log('Discord audio player state changed', {
        from: oldState.status,
        to: newState.status,
        guildId: connection.joinConfig.guildId,
        channelId: connection.joinConfig.channelId,
      });
    });

    const playbackTimeout = setTimeout(() => {
      finish(new Error('Discord voice playback did not finish within 60s.'));
    }, 60_000);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(playbackTimeout);
      player.removeAllListeners();
      player.stop(true);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    player.once('error', (error) => finish(error));
    player.once(AudioPlayerStatus.Idle, () => finish());
    player.play(resource);

    void entersState(player, AudioPlayerStatus.Playing, 5_000).catch((error) => {
      if (settled) return;
      finish(new Error(`Discord voice playback never started: ${error instanceof Error ? error.message : String(error)}`));
    });
  });
}
