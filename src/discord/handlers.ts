import path from 'node:path';
import { VoiceConnection, getVoiceConnection } from '@discordjs/voice';
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  type Message,
  MessageFlags,
} from 'discord.js';
import {
  createRequestTempDir,
  getTtsOutputExtensionForProvider,
  playAudioFile,
  removeRequestTempDir,
  synthesizeSpeech,
  type TtsProvider,
} from '../audio.js';
import { summarizeHealthIssues, collectBridgeHealth } from '../diagnostics.js';
import { createHermesSession } from '../hermes.js';
import {
  beginGuildJoin,
  buildVoiceSessionKey,
  clearVoiceSession,
  createVoiceSession,
  endGuildJoin,
  getActiveGuildJoinUser,
  getActiveGuildListenUser,
  getVoiceSession,
  markVoiceSessionUsed,
  setVoiceSessionBotSpeaking,
  setVoiceSessionVerbose,
  setVoiceSessionListenMode,
  setVoiceSessionTtsProvider,
} from '../state.js';
import { getOrCreateConnectionFromMember } from '../voice.js';
import {
  VOICE_MODE_AUTO,
  VOICE_TTS_ELEVENLABS,
  VOICE_TTS_HERMES,
  VOICE_TTS_PIPER,
  VOICE_TTS_SAY,
  VOICE_VERBOSE_DISABLE,
  VOICE_VERBOSE_ENABLE,
  buildInfoEmbed,
  buildJoinControls,
  buildJoinEmbed,
  buildVoiceVerboseButtons,
  buildVoiceVerbosePromptEmbed,
  formatTtsProvider,
} from './embeds.js';
import {
  fitEmbedFieldValue,
  formatLatency,
  formatPipelineError,
  sleep,
  summarizeSessionId,
  summarizeSessionKey,
} from './helpers.js';
import { runListenTurn, type ListenExecutionContext } from './listen-turn.js';
import { ensureVerboseThread, runHermesTurnWithOptionalVerbose } from './verbose.js';

export { buildListenLogDetails, getListenTimingConfig, redactSessionKey } from './helpers.js';

type AutoListenController = {
  dispose: () => void;
  triggerActive: boolean;
  playbackAbortController: AbortController | null;
  statusMessage: Message | null;
};
type VoiceRunPhase = 'thinking' | 'synthesizing' | 'playing';
type ActiveVoiceRun = {
  abortController: AbortController;
  phase: VoiceRunPhase;
  source: string;
  finish: () => void;
  setPhase: (phase: VoiceRunPhase) => void;
};

const autoListenControllers = new Map<string, AutoListenController>();
const activeVoiceRuns = new Map<string, ActiveVoiceRun>();

function beginActiveVoiceRun(guildId: string, source: string): ActiveVoiceRun {
  activeVoiceRuns.get(guildId)?.abortController.abort();

  const abortController = new AbortController();
  const run: ActiveVoiceRun = {
    abortController,
    phase: 'thinking',
    source,
    finish: () => {
      if (activeVoiceRuns.get(guildId) === run) {
        activeVoiceRuns.delete(guildId);
      }
    },
    setPhase: (phase) => {
      run.phase = phase;
    },
  };
  activeVoiceRuns.set(guildId, run);
  return run;
}

function stopActiveVoiceRun(guildId: string): ActiveVoiceRun | null {
  const run = activeVoiceRuns.get(guildId);
  if (!run || run.abortController.signal.aborted) return null;
  run.abortController.abort();
  return run;
}

function disposeAutoListen(guildId: string) {
  const controller = autoListenControllers.get(guildId);
  if (!controller) return;
  stopActiveVoiceRun(guildId);
  controller.playbackAbortController?.abort();
  controller.dispose();
  autoListenControllers.delete(guildId);
}

function interruptAutoPlayback(guildId: string): 'interrupted' | 'busy' | 'not-playing' {
  const controller = autoListenControllers.get(guildId);
  const playbackAbortController = controller?.playbackAbortController;
  if (!controller) return 'not-playing';
  if (!playbackAbortController || playbackAbortController.signal.aborted) {
    return controller.triggerActive ? 'busy' : 'not-playing';
  }

  playbackAbortController.abort();
  return 'interrupted';
}

export async function handleJoin(interaction: ChatInputCommandInteraction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guildId;
  const guild = interaction.guild;
  if (!guildId || !guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const hadVoiceConnectionBeforeJoin = Boolean(getVoiceConnection(guildId));

  await interaction.editReply({ content: 'Connecting to your Discord voice channel...' });
  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  await interaction.editReply({ content: 'Voice connected. Preparing the Hermes voice session...' });

  const health = collectBridgeHealth();
  const issues = summarizeHealthIssues(health);
  let session = getVoiceSession(guildId);
  let created = false;

  const channelId = connection.joinConfig.channelId;
  if (session && !hadVoiceConnectionBeforeJoin) {
    console.warn('Discarding stale voice session after reconnect', {
      guildId,
      previousChannelId: session.channelId,
      requestedChannelId: channelId,
    });
    disposeAutoListen(guildId);
    clearVoiceSession(guildId);
    session = null;
  }

  if (session && channelId && session.channelId !== channelId) {
    console.warn('Discarding stale voice session for different channel', {
      guildId,
      previousChannelId: session.channelId,
      requestedChannelId: channelId,
    });
    disposeAutoListen(guildId);
    clearVoiceSession(guildId);
    session = null;
  }

  if (!session) {
    const joinLock = beginGuildJoin(guildId, interaction.user.id);
    if (!joinLock.ok) {
      await interaction.editReply({
        content: 'A voice session is already being prepared in this server. Wait a moment, then try again.',
      });
      return;
    }
    try {
      if (!channelId) {
        connection.destroy();
        await interaction.editReply({
          content: 'The voice connection has no channel id yet. Please try `/join` again.',
        });
        return;
      }
      const requestedKey = buildVoiceSessionKey(guildId, channelId);
      const hermesSession = createHermesSession(requestedKey);
      session = createVoiceSession(guildId, channelId, interaction.user.id, {
        sessionKey: hermesSession.sessionKey,
        hermesResponseId: hermesSession.responseId,
      });
      created = true;
    } catch (error) {
      connection.destroy();
      await interaction.editReply({
        content: `Joining voice worked, but creating the Hermes session failed: ${formatPipelineError(error)}`,
      });
      return;
    } finally {
      endGuildJoin(guildId, interaction.user.id);
    }
  }

  const embed = buildJoinEmbed(session, {
    channelId: connection.joinConfig.channelId,
    created,
    issues,
  });

  if (session.listenMode === 'auto') {
    enableAutoListen(guildId, guild, connection);
  } else {
    disposeAutoListen(guildId);
  }

  await interaction.editReply({
    embeds: [embed],
    components: buildJoinControls(session),
  });
}

export async function handleListen(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const session = getVoiceSession(guildId);
  if (!session) {
    if (getActiveGuildJoinUser(guildId)) {
      await interaction.editReply('The Hermes voice session is still being prepared. Wait a moment, then run `/listen` again.');
      return;
    }
    await interaction.editReply('No Hermes voice session is active yet. Run `/join` first.');
    return;
  }

  if (session.listenMode === 'auto') {
    await interaction.editReply('Auto-listen Beta is active in this server. Just speak while the bot is idle, or switch back to Slash-to-talk in `/join`.');
    return;
  }

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  const run = beginActiveVoiceRun(guildId, 'listen');
  try {
    await runListenTurn({
      guildId,
      guild: interaction.guild,
      requestUserId: interaction.user.id,
      connection,
      session,
      runSignal: run.abortController.signal,
      onRunPhase: run.setPhase,
      startNotice: async () => {
        const listeningEmbed = new EmbedBuilder()
          .setTitle('Listening now')
          .setColor(0x5865f2)
          .setDescription('Speak a short sentence. Capture stops after about 1.2 seconds of silence.')
          .addFields(
            {
              name: 'Voice session',
              value: summarizeSessionKey(session.sessionKey),
              inline: false,
            },
            {
              name: 'Tip',
              value: 'Speak after this message appears and avoid push-to-talk gaps at the start.',
              inline: false,
            },
          );
        await interaction.editReply({ embeds: [listeningEmbed] });
      },
      progressReply: async ({ embed, content }) => {
        if (embed) {
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        if (content) {
          await interaction.editReply({ content, embeds: [] });
        }
      },
      finishReply: async ({ embed, content }) => {
        if (embed) {
          await interaction.editReply({ embeds: [embed], content: '' });
          return;
        }
        if (content) {
          await interaction.editReply({ content, embeds: [] });
        }
      },
    });
  } finally {
    run.finish();
  }
}

export async function handleDebugText(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const session = getVoiceSession(guildId);
  if (!session) {
    if (getActiveGuildJoinUser(guildId)) {
      await interaction.editReply('The Hermes voice session is still being prepared. Wait a moment, then run `/debugtext` again.');
      return;
    }
    await interaction.editReply('No Hermes voice session is active yet. Run `/join` first.');
    return;
  }

  const transcript = interaction.options.getString('text', true).trim();
  const ttsEnabled = interaction.options.getString('tts', true) === 'on';
  const startedAt = Date.now();
  let ttsFinalStatus = ttsEnabled ? `Played via ${formatTtsProvider(session.ttsProvider)}` : 'Off';

  if (!transcript) {
    await interaction.editReply('Please provide some text for `/debugtext`.');
    return;
  }

  const run = beginActiveVoiceRun(guildId, 'debugtext');

  const buildDebugEmbed = (options: {
    title: string;
    color: number;
    status: string;
    reply?: string;
    responseId?: string | null;
    ttsStatus?: string;
    latencyMs?: number;
  }) => new EmbedBuilder()
    .setTitle(options.title)
    .setColor(options.color)
    .addFields(
      {
        name: 'Status',
        value: options.status,
        inline: false,
      },
      {
        name: 'You sent',
        value: fitEmbedFieldValue(transcript),
        inline: false,
      },
      ...(options.reply
        ? [{
            name: 'Hermes replied',
            value: fitEmbedFieldValue(options.reply),
            inline: false,
          }]
        : []),
      {
        name: 'TTS playback',
        value: options.ttsStatus ?? (ttsEnabled ? `Pending via ${formatTtsProvider(session.ttsProvider)}` : 'Off'),
        inline: false,
      },
      {
        name: 'Session key',
        value: summarizeSessionKey(session.sessionKey),
        inline: false,
      },
      {
        name: 'Session id',
        value: summarizeSessionId(options.responseId ?? session.hermesResponseId),
        inline: false,
      },
      ...(typeof options.latencyMs === 'number'
        ? [{
            name: 'Latency',
            value: formatLatency(options.latencyMs),
            inline: false,
          }]
        : []),
    )
    .setFooter({ text: 'Debug text only affects this one command call.' });

  try {
    await interaction.editReply({
      embeds: [
        buildDebugEmbed({
          title: 'Debug text running',
          color: 0x5865f2,
          status: 'Hermes is preparing a reply.',
          ttsStatus: ttsEnabled ? `Waiting for Hermes, then ${formatTtsProvider(session.ttsProvider)} playback.` : 'Off',
        }),
      ],
    });

    const hermesResult = await runHermesTurnWithOptionalVerbose({
      guildId,
      guild: interaction.guild,
      session,
      transcript,
      logPrefix: '[debugtext]',
      signal: run.abortController.signal,
    });

    await interaction.editReply({
      embeds: [
        buildDebugEmbed({
          title: ttsEnabled ? 'Debug text reply ready' : 'Debug text complete',
          color: ttsEnabled ? 0x5865f2 : 0x57f287,
          status: ttsEnabled ? 'Hermes replied. Preparing speech audio now.' : 'Hermes replied.',
          reply: hermesResult.reply,
          responseId: hermesResult.responseId,
          ttsStatus: ttsEnabled ? `Preparing via ${formatTtsProvider(session.ttsProvider)}` : 'Off',
          latencyMs: ttsEnabled ? undefined : Date.now() - startedAt,
        }),
      ],
    });

    if (ttsEnabled) {
      const connection = getVoiceConnection(guildId);
      if (!connection) {
        ttsFinalStatus = 'Skipped because the bot is not connected to voice.';
        await interaction.editReply({
          embeds: [
            buildDebugEmbed({
              title: 'Debug text complete',
              color: 0xfee75c,
              status: 'Hermes replied, but the bot is not connected to voice.',
              reply: hermesResult.reply,
              responseId: hermesResult.responseId,
              ttsStatus: 'Skipped because the bot is not connected to voice.',
              latencyMs: Date.now() - startedAt,
            }),
          ],
        });
      } else {
        const tmpDir = createRequestTempDir();
        try {
          const ttsPath = path.join(tmpDir, `reply.${getTtsOutputExtensionForProvider(session.ttsProvider)}`);
          run.setPhase('synthesizing');
          await synthesizeSpeech(hermesResult.reply, ttsPath, session.ttsProvider, { signal: run.abortController.signal });
          await interaction.editReply({
            embeds: [
              buildDebugEmbed({
                title: 'Debug text speaking',
                color: 0x5865f2,
                status: 'Playing the Hermes reply in voice.',
                reply: hermesResult.reply,
                responseId: hermesResult.responseId,
                ttsStatus: `Playing via ${formatTtsProvider(session.ttsProvider)}`,
              }),
            ],
          });
          setVoiceSessionBotSpeaking(guildId, true);
          run.setPhase('playing');
          await playAudioFile(connection, ttsPath, { signal: run.abortController.signal });
          ttsFinalStatus = `Played via ${formatTtsProvider(session.ttsProvider)}`;
        } finally {
          setVoiceSessionBotSpeaking(guildId, false);
          await removeRequestTempDir(tmpDir);
        }
      }
    }

    markVoiceSessionUsed(guildId, {
      initialized: true,
      sessionKey: hermesResult.sessionKey,
      hermesResponseId: hermesResult.responseId,
    });

    await interaction.editReply({
      embeds: [
        buildDebugEmbed({
          title: 'Debug text complete',
          color: 0x57f287,
          status: 'Completed.',
          reply: hermesResult.reply,
          responseId: hermesResult.responseId,
          ttsStatus: ttsFinalStatus,
          latencyMs: Date.now() - startedAt,
        }),
      ],
    });
  } catch (error) {
    await interaction.editReply({ content: `Processing failed: ${formatPipelineError(error)}` });
  } finally {
    run.finish();
  }
}

export async function handleVoiceVerbose(interaction: ChatInputCommandInteraction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const session = getVoiceSession(guildId);
  if (!session) {
    await interaction.editReply({ content: 'No Hermes voice session is active yet. Run `/join` first.' });
    return;
  }

  await interaction.editReply({
    embeds: [buildVoiceVerbosePromptEmbed(session)],
    components: buildVoiceVerboseButtons(session.verboseEnabled),
  });
}

export async function handleInterrupt(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const session = getVoiceSession(guildId);
  if (!session) {
    await interaction.editReply({ content: 'No Hermes voice session is active yet. Run `/join` first.' });
    return;
  }

  if (session.listenMode !== 'auto') {
    await interaction.editReply({ content: 'Interrupt is only active in Auto-listen mode. Switch to Auto-listen from `/join` first.' });
    return;
  }

  const connection = getVoiceConnection(guildId);
  if (!connection) {
    await interaction.editReply({ content: 'The bot is not connected to voice right now. Run `/join` first.' });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || member.voice.channelId !== connection.joinConfig.channelId) {
    await interaction.editReply({ content: 'You need to be in the same voice channel as the bot to interrupt playback.' });
    return;
  }

  const interruptResult = interruptAutoPlayback(guildId);
  if (interruptResult === 'busy') {
    await interaction.editReply({ content: 'The current Auto-listen turn is still being prepared. Playback can be interrupted as soon as the bot starts speaking.' });
    return;
  }
  if (interruptResult === 'not-playing') {
    await interaction.editReply({ content: 'Nothing is playing right now, so there is nothing to interrupt.' });
    return;
  }

  await interaction.editReply({ content: 'Interrupted current playback. Speak again when the bot is idle.' });
}

export async function handleStopVoice(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const session = getVoiceSession(guildId);
  if (!session) {
    await interaction.editReply({ content: 'No Hermes voice session is active yet. Run `/join` first.' });
    return;
  }

  const connection = getVoiceConnection(guildId);
  if (!connection) {
    await interaction.editReply({ content: 'The bot is not connected to voice right now. Run `/join` first.' });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || member.voice.channelId !== connection.joinConfig.channelId) {
    await interaction.editReply({ content: 'You need to be in the same voice channel as the bot to stop the voice run.' });
    return;
  }

  const stoppedRun = stopActiveVoiceRun(guildId);
  if (!stoppedRun) {
    setVoiceSessionBotSpeaking(guildId, false);
    await interaction.editReply({ content: 'No voice run is active right now.' });
    return;
  }

  setVoiceSessionBotSpeaking(guildId, false);
  await interaction.editReply({
    content: `Stopped current voice run (${stoppedRun.source}, ${stoppedRun.phase}). The voice session stays connected.`,
  });
}

function enableAutoListen(guildId: string, guild: NonNullable<ListenExecutionContext['guild']>, connection: VoiceConnection) {
  disposeAutoListen(guildId);

  const receiver = connection.receiver;
  const controller: AutoListenController = {
    dispose: () => {},
    triggerActive: false,
    playbackAbortController: null,
    statusMessage: null,
  };

  const upsertAutoModeMessage = async (payload: { embed?: EmbedBuilder; content?: string }) => {
    const textChannelId = getVoiceSession(guildId)?.autoListenTextChannelId ?? null;
    if (!textChannelId) return;

    const channel = guild.channels.cache.get(textChannelId) ?? await guild.channels.fetch(textChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const messagePayload = payload.embed
      ? { embeds: [payload.embed], content: payload.content ?? '' }
      : { embeds: [], content: payload.content ?? '' };

    if (controller.statusMessage) {
      try {
        controller.statusMessage = await controller.statusMessage.edit(messagePayload);
        return;
      } catch (error) {
        console.error('Failed to edit auto-listen status message; sending a replacement', error);
        controller.statusMessage = null;
      }
    }

    controller.statusMessage = await channel.send(messagePayload);
  };

  const onSpeakingStart = (userId: string) => {
    const session = getVoiceSession(guildId);
    if (!session || session.listenMode !== 'auto') return;
    if (userId !== session.createdByUserId) return;
    if (session.botSpeaking) {
      if (interruptAutoPlayback(guildId) === 'interrupted') {
        void upsertAutoModeMessage({
          content: 'Interrupted current playback. Speak again when the bot is idle.',
        });
      }
      return;
    }
    if (controller.triggerActive || getActiveGuildListenUser(guildId)) return;

    controller.triggerActive = true;
    const run = beginActiveVoiceRun(guildId, 'auto-listen');
    void runListenTurn({
      guildId,
      guild,
      requestUserId: userId,
      connection,
      session,
      runSignal: run.abortController.signal,
      onRunPhase: run.setPhase,
      preparePlayback: () => {
        controller.playbackAbortController = run.abortController;
        return controller.playbackAbortController.signal;
      },
      finishPlayback: () => {
        controller.playbackAbortController = null;
      },
      progressReply: upsertAutoModeMessage,
      finishReply: async (payload) => {
        await upsertAutoModeMessage(payload);
      },
    })
      .catch((error) => {
        console.error('Error during auto-listen runListenTurn:', error);
      })
      .finally(() => {
        controller.triggerActive = false;
        controller.playbackAbortController = null;
        controller.statusMessage = null;
        run.finish();
      });
  };

  receiver.speaking.on('start', onSpeakingStart);

  controller.dispose = () => {
    receiver.speaking.off('start', onSpeakingStart);
  };

  autoListenControllers.set(guildId, controller);
}

export async function handleVoiceVerboseButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith('voice-verbose:')) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const session = getVoiceSession(guildId);
  if (!session) {
    await interaction.editReply({
      content: 'The voice session is no longer active. Run `/join` again first.',
      embeds: [],
      components: [],
    });
    return;
  }

  const enable = interaction.customId === VOICE_VERBOSE_ENABLE;
  if (!enable) {
    const updated = setVoiceSessionVerbose(guildId, false);
    if (!updated) return;

    await interaction.editReply({
      embeds: [buildVoiceVerbosePromptEmbed(updated)],
      components: buildVoiceVerboseButtons(false),
    });
    return;
  }

  const thread = await ensureVerboseThread(interaction.guild, interaction.channel, session);
  const updated = setVoiceSessionVerbose(guildId, true, { threadId: thread.id });
  if (!updated) return;

  await interaction.editReply({
    embeds: [buildVoiceVerbosePromptEmbed(updated)],
    components: buildVoiceVerboseButtons(true),
  });
}

export async function handleJoinModeButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith('voice-mode:')) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const session = getVoiceSession(guildId);
  const connection = getVoiceConnection(guildId);
  if (!session || !connection) {
    await interaction.editReply({
      content: 'The voice session is no longer active. Run `/join` again first.',
      embeds: [],
      components: [],
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || member.voice.channelId !== connection.joinConfig.channelId) {
    await interaction.followUp({
      content: 'You need to be in the same voice channel as the bot to change the talk mode.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nextMode = interaction.customId === VOICE_MODE_AUTO ? 'auto' : 'slash';
  setVoiceSessionListenMode(guildId, nextMode, { textChannelId: interaction.channelId });

  if (nextMode === 'auto') {
    enableAutoListen(guildId, interaction.guild, connection);
  } else {
    disposeAutoListen(guildId);
  }

  const updatedSession = getVoiceSession(guildId);
  if (!updatedSession) return;

  await interaction.editReply({
    embeds: [
      buildJoinEmbed(updatedSession, {
        channelId: connection.joinConfig.channelId,
        created: false,
        issues: summarizeHealthIssues(collectBridgeHealth()),
      }),
    ],
    components: buildJoinControls(updatedSession),
  });
}

export async function handleVoiceTtsButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith('voice-tts:')) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const session = getVoiceSession(guildId);
  const connection = getVoiceConnection(guildId);
  if (!session || !connection) {
    await interaction.editReply({
      content: 'The voice session is no longer active. Run `/join` again first.',
      embeds: [],
      components: [],
    });
    return;
  }

  let nextProvider: TtsProvider;
  if (interaction.customId === VOICE_TTS_ELEVENLABS) {
    nextProvider = 'elevenlabs';
  } else if (interaction.customId === VOICE_TTS_HERMES) {
    nextProvider = 'hermes';
  } else if (interaction.customId === VOICE_TTS_PIPER) {
    nextProvider = 'piper';
  } else if (interaction.customId === VOICE_TTS_SAY) {
    nextProvider = 'say';
  } else {
    await interaction.editReply({
      content: `Unrecognized TTS button: \`${interaction.customId}\`. Please re-run \`/join\`.`,
      embeds: [],
      components: [],
    });
    return;
  }
  const updatedSession = setVoiceSessionTtsProvider(guildId, nextProvider);
  if (!updatedSession) return;

  await interaction.editReply({
    embeds: [
      buildJoinEmbed(updatedSession, {
        channelId: connection.joinConfig.channelId,
        created: false,
        issues: summarizeHealthIssues(collectBridgeHealth()),
      }),
    ],
    components: buildJoinControls(updatedSession),
  });
}

export async function handleLeave(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const connection = getVoiceConnection(interaction.guild.id);
  if (!connection) {
    await interaction.editReply({ content: 'I am not connected to a voice channel right now.' });
    return;
  }

  const activeListenUserId = getActiveGuildListenUser(interaction.guild.id);
  if (activeListenUserId) {
    await interaction.editReply({ content: 'A `/listen` turn is still running in this server. Try again in a moment.' });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (member.voice.channelId !== connection.joinConfig.channelId) {
    await interaction.editReply({ content: 'You need to be in the same voice channel as the bot to use `/leave`.' });
    return;
  }

  const session = getVoiceSession(interaction.guild.id);
  stopActiveVoiceRun(interaction.guild.id);
  disposeAutoListen(interaction.guild.id);
  connection.destroy();

  if (!session) {
    const embed = new EmbedBuilder()
      .setTitle('Disconnected')
      .setColor(0x5865f2)
      .setDescription('Left the voice channel.');
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  clearVoiceSession(interaction.guild.id);
  const embed = new EmbedBuilder()
    .setTitle('Disconnected')
    .setColor(0x5865f2)
    .setDescription('Left the voice channel and cleared the local Hermes voice session reference.')
    .addFields({
      name: 'Hermes conversation',
      value: summarizeSessionKey(session.sessionKey),
      inline: false,
    });
  await interaction.editReply({ embeds: [embed] });
}

export async function handleInfo(interaction: ChatInputCommandInteraction) {
  await interaction.editReply({ embeds: [buildInfoEmbed(interaction.guildId, interaction.user.id)] });
}
