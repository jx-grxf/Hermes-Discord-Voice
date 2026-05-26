import fs from 'node:fs';
import path from 'node:path';
import prism from 'prism-media';
import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import { EmbedBuilder, type Guild } from 'discord.js';
import {
  convertPcmToWav,
  createRequestTempDir,
  getTtsOutputExtensionForProvider,
  playAudioFile,
  removeRequestTempDir,
  synthesizeSpeech,
  transcribeWav,
} from '../audio.js';
import { beginGuildListen, endGuildListen, markVoiceSessionUsed, setVoiceSessionBotSpeaking, type VoiceSessionState } from '../state.js';
import {
  buildListenLogDetails,
  fitEmbedFieldValue,
  formatLatency,
  formatPipelineError,
  getListenTimingConfig,
  redactSessionKey,
  summarizeSessionId,
  summarizeSessionKey,
} from './helpers.js';
import { runOpenClawTurnWithOptionalVerbose } from './verbose.js';

export type ListenExecutionContext = {
  guildId: string;
  guild: Guild;
  requestUserId: string;
  connection: VoiceConnection;
  session: VoiceSessionState;
  startNotice?: () => Promise<void>;
  finishReply: (payload: { embed?: EmbedBuilder; content?: string }) => Promise<void>;
};

export async function runListenTurn(context: ListenExecutionContext) {
  const { guildId, guild, requestUserId, connection, session, startNotice, finishReply } = context;

  const listenLock = beginGuildListen(guildId, requestUserId);
  if (!listenLock.ok) {
    await finishReply({
      content: 'Another voice turn is already running in this server. Wait for it to finish, then try again.',
    });
    return;
  }

  const releaseListenLock = () => {
    endGuildListen(guildId, requestUserId);
  };
  let tmpDir: string | null = null;
  const listenStartedAt = Date.now();

  try {
    if (startNotice) {
      await startNotice();
    }

    const botMember = await guild.members.fetchMe();
    const receiveMember = await guild.members.fetch(requestUserId).catch(() => null);

    const receiver = connection.receiver;
    tmpDir = createRequestTempDir();
    const requestTmpDir = tmpDir;
    const requestId = path.basename(requestTmpDir);
    const logPrefix = `[listen:${requestId}]`;
    const log = (message: string, details?: Record<string, unknown>) => {
      console.log(logPrefix, message, details ?? {});
    };
    const timing = getListenTimingConfig();

    const opusStream = receiver.subscribe(requestUserId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1200,
      },
    });

    let decoder: prism.opus.Decoder;
    try {
      decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    } catch (error) {
      console.error(logPrefix, 'Opus decoder init failed', error);
      releaseListenLock();
      await finishReply({
        content: 'Opus decoding is unavailable. Install `opusscript` or `@discordjs/opus`, then restart the bot.',
      });
      await removeRequestTempDir(requestTmpDir);
      return;
    }

    const pcmPath = path.join(requestTmpDir, 'input.pcm');
    const wavPath = path.join(requestTmpDir, 'input.wav');
    const transcriptBasePath = path.join(requestTmpDir, 'transcript');
    const ttsPath = path.join(requestTmpDir, `reply.${getTtsOutputExtensionForProvider(session.ttsProvider)}`);
    const out = fs.createWriteStream(pcmPath);

    let completed = false;
    let receivedOpusPackets = 0;
    let receivedOpusBytes = 0;
    let receivedPcmBytes = 0;
    let speakingStarted = false;
    let ssrcMapped = false;
    let captureFinalized = false;

    const onSpeakingStart = (userId: string) => {
      if (userId !== requestUserId) return;
      speakingStarted = true;
      log('Speaking started', { userId });
    };

    const onSpeakingEnd = (userId: string) => {
      if (userId !== requestUserId) return;
      log('Speaking ended', { userId, opusPackets: receivedOpusPackets, pcmBytes: receivedPcmBytes });
    };

    const onSsrcCreate = (data: { userId: string; audioSSRC: number }) => {
      if (data.userId !== requestUserId) return;
      ssrcMapped = true;
      log('SSRC mapped', { userId: data.userId, audioSSRC: data.audioSSRC });
    };

    receiver.speaking.on('start', onSpeakingStart);
    receiver.speaking.on('end', onSpeakingEnd);
    receiver.ssrcMap.on('create', onSsrcCreate);

    const cleanupListeners = () => {
      receiver.speaking.off('start', onSpeakingStart);
      receiver.speaking.off('end', onSpeakingEnd);
      receiver.ssrcMap.off('create', onSsrcCreate);
    };

    const stopCapture = (reason: string) => {
      if (captureFinalized) return;
      captureFinalized = true;
      log('Stopping capture', {
        reason,
        ...buildListenLogDetails({
          guildId,
          channelId: connection.joinConfig.channelId,
          speakingStarted,
          ssrcMapped,
          opusPackets: receivedOpusPackets,
          opusBytes: receivedOpusBytes,
          pcmBytes: receivedPcmBytes,
          hasOpenClawSessionId: Boolean(session.openClawSessionId),
          sessionKey: session.sessionKey,
        }),
      });
      try {
        opusStream.unpipe(decoder);
      } catch {}
      try {
        decoder.unpipe(out);
      } catch {}
      try {
        opusStream.destroy();
      } catch {}
      try {
        decoder.end();
      } catch {}
      if (!out.destroyed && !out.writableEnded) {
        out.end();
      }
    };

    const finishWithError = async (message: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(noAudioTimer);
      clearTimeout(noSpeechTimer);
      clearTimeout(maxCaptureTimer);
      cleanupListeners();
      releaseListenLock();
      stopCapture('error');
      if (!out.destroyed) {
        out.destroy();
      }
      await finishReply({ content: message });
      await removeRequestTempDir(requestTmpDir);
    };

    const noAudioTimer = setTimeout(async () => {
      if (completed || receivedOpusPackets > 0) return;
      console.warn(logPrefix, 'No audio received before timeout', {
        guildId: guild.id,
        channelId: connection.joinConfig.channelId,
        speakingStarted,
        ssrcMapped,
        sessionKeyPreview: redactSessionKey(session.sessionKey),
      });
      await finishWithError(
        'I did not receive any voice signal from you. Check that Discord voice activity or push-to-talk is actually sending audio, then try again.',
      );
    }, timing.noAudioTimeoutMs);

    const noSpeechTimer = setTimeout(async () => {
      if (completed || speakingStarted) return;
      console.warn(logPrefix, 'No speech detected before timeout', {
        guildId,
        channelId: connection.joinConfig.channelId,
        opusPackets: receivedOpusPackets,
        sessionKeyPreview: redactSessionKey(session.sessionKey),
      });
      await finishWithError(
        'I only received background audio or unclear noise, not clear speech. Try again and speak more directly into the mic.',
      );
    }, timing.noSpeechTimeoutMs);

    const maxCaptureTimer = setTimeout(() => {
      if (completed) return;
      stopCapture('max-capture-timeout');
    }, timing.maxCaptureMs);

    log('Receive pipeline started', {
      ...buildListenLogDetails({
        guildId: guild.id,
        channelId: connection.joinConfig.channelId,
        speakingStarted,
        ssrcMapped,
        hasOpenClawSessionId: Boolean(session.openClawSessionId),
        sessionKey: session.sessionKey,
      }),
      botReadyForReceive: Boolean(botMember.voice?.channelId) && botMember.voice?.selfDeaf === false,
      speakerChannelMatches: receiveMember?.voice?.channelId === connection.joinConfig.channelId,
      timing,
    });

    opusStream.on('data', (chunk) => {
      receivedOpusPackets += 1;
      receivedOpusBytes += chunk.length;
      if (receivedOpusPackets === 1) {
        clearTimeout(noAudioTimer);
        log('First opus packet received', {
          ...buildListenLogDetails({
            guildId,
            channelId: connection.joinConfig.channelId,
            speakingStarted,
            ssrcMapped,
            opusPackets: receivedOpusPackets,
            opusBytes: receivedOpusBytes,
            sessionKey: session.sessionKey,
          }),
          firstPacketBytes: chunk.length,
        });
      } else if (receivedOpusPackets % 50 === 0) {
        log('Still receiving opus packets', {
          ...buildListenLogDetails({
            guildId,
            channelId: connection.joinConfig.channelId,
            speakingStarted,
            ssrcMapped,
            opusPackets: receivedOpusPackets,
            opusBytes: receivedOpusBytes,
            sessionKey: session.sessionKey,
          }),
        });
      }
    });

    decoder.on('data', (chunk: Buffer) => {
      receivedPcmBytes += chunk.length;
    });

    opusStream.on('end', () => {
      log('Opus stream ended', {
        ...buildListenLogDetails({
          guildId,
          channelId: connection.joinConfig.channelId,
          speakingStarted,
          ssrcMapped,
          opusPackets: receivedOpusPackets,
          opusBytes: receivedOpusBytes,
          pcmBytes: receivedPcmBytes,
          sessionKey: session.sessionKey,
        }),
      });
    });

    opusStream.on('close', () => {
      log('Opus stream closed');
    });

    opusStream.on('error', async (error) => {
      console.error(logPrefix, 'Opus stream error', error);
      await finishWithError('The Discord receive stream failed while listening.');
    });

    decoder.on('error', async (error) => {
      console.error(logPrefix, 'Decoder error', error);
      await finishWithError('The audio decoder failed while processing your speech.');
    });

    out.on('error', async (error) => {
      console.error(logPrefix, 'Write stream error', error);
      if (!receivedOpusPackets) {
        await finishWithError('I could not capture usable audio. Check your mic and Discord voice settings, then try again.');
        return;
      }
      await finishWithError('Saving the captured audio failed.');
    });

    out.on('finish', async () => {
      if (completed) return;

      clearTimeout(maxCaptureTimer);
      clearTimeout(noSpeechTimer);

      log('PCM file complete', {
        ...buildListenLogDetails({
          guildId,
          channelId: connection.joinConfig.channelId,
          speakingStarted,
          ssrcMapped,
          opusPackets: receivedOpusPackets,
          opusBytes: receivedOpusBytes,
          pcmBytes: receivedPcmBytes,
          sessionKey: session.sessionKey,
        }),
        pcmPath,
      });

      if (!receivedOpusPackets || receivedPcmBytes === 0) {
        await finishWithError(
          'I still did not receive decodable speech audio. Check Discord voice activity, your input device, and whether you spoke after `/listen` started.',
        );
        return;
      }

      try {
        const convertStartedAt = Date.now();
        await convertPcmToWav(pcmPath, wavPath);
        log('Converted PCM to WAV', { wavPath, durationMs: Date.now() - convertStartedAt });

        const transcriptionStartedAt = Date.now();
        const transcript = await transcribeWav(wavPath, transcriptBasePath);
        log('Transcription finished', {
          ...buildListenLogDetails({
            guildId,
            channelId: connection.joinConfig.channelId,
            speakingStarted,
            ssrcMapped,
            transcriptLength: transcript.length,
            hasOpenClawSessionId: Boolean(session.openClawSessionId),
            sessionKey: session.sessionKey,
          }),
          durationMs: Date.now() - transcriptionStartedAt,
        });
        if (!transcript.trim()) {
          throw new Error('Audio arrived, but Whisper could not recognize any speech. Try speaking more clearly or a little louder.');
        }

        const openClawStartedAt = Date.now();
        const openClawResult = await runOpenClawTurnWithOptionalVerbose({
          guildId,
          guild,
          session,
          transcript,
          logPrefix,
        });
        log('OpenClaw turn finished', {
          sessionKeyPreview: redactSessionKey(openClawResult.sessionKey),
          hasOpenClawSessionId: Boolean(openClawResult.sessionId),
          durationMs: Date.now() - openClawStartedAt,
        });

        const ttsStartedAt = Date.now();
        await synthesizeSpeech(openClawResult.reply, ttsPath, session.ttsProvider);
        log('TTS synthesis finished', { ttsPath, durationMs: Date.now() - ttsStartedAt, provider: session.ttsProvider });
        setVoiceSessionBotSpeaking(guildId, true);
        const playbackStartedAt = Date.now();
        await playAudioFile(connection, ttsPath);
        setVoiceSessionBotSpeaking(guildId, false);
        log('Reply playback finished', { durationMs: Date.now() - playbackStartedAt });
        markVoiceSessionUsed(guildId, {
          initialized: true,
          sessionKey: openClawResult.sessionKey,
          openClawSessionId: openClawResult.sessionId,
        });

        completed = true;
        clearTimeout(noAudioTimer);
        clearTimeout(noSpeechTimer);
        clearTimeout(maxCaptureTimer);
        cleanupListeners();
        releaseListenLock();
        const replyEmbed = new EmbedBuilder()
          .setTitle('Turn complete')
          .setColor(0x57f287)
          .addFields(
            {
              name: 'You said',
              value: fitEmbedFieldValue(transcript),
              inline: false,
            },
            {
              name: 'OpenClaw replied',
              value: fitEmbedFieldValue(openClawResult.reply),
              inline: false,
            },
            {
              name: 'Session key',
              value: summarizeSessionKey(openClawResult.sessionKey),
              inline: false,
            },
            {
              name: 'Session id',
              value: summarizeSessionId(openClawResult.sessionId),
              inline: false,
            },
            {
              name: 'Latency',
              value: formatLatency(Date.now() - listenStartedAt),
              inline: false,
            },
          )
          .setFooter({ text: 'Use /info if you need the full bridge state' });
        await finishReply({ embed: replyEmbed });
      } catch (error) {
        console.error(logPrefix, 'Listen pipeline failed', error);
        completed = true;
        clearTimeout(noAudioTimer);
        clearTimeout(noSpeechTimer);
        clearTimeout(maxCaptureTimer);
        cleanupListeners();
        releaseListenLock();
        setVoiceSessionBotSpeaking(guildId, false);
        await finishReply({ content: `Processing failed: ${formatPipelineError(error)}` });
      } finally {
        await removeRequestTempDir(requestTmpDir);
      }
    });

    opusStream.pipe(decoder).pipe(out);
  } catch (error) {
    releaseListenLock();
    if (tmpDir) {
      await removeRequestTempDir(tmpDir).catch(() => {});
    }
    throw error;
  }
}
