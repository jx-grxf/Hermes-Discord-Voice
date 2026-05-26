import path from 'node:path';
import { VoiceConnection, getVoiceConnection } from '@discordjs/voice';
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
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

const autoListenControllers = new Map<string, { dispose: () => void; triggerActive: boolean }>();

function disposeAutoListen(guildId: string) {
  const controller = autoListenControllers.get(guildId);
  if (!controller) return;
  controller.dispose();
  autoListenControllers.delete(guildId);
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

  await runListenTurn({
    guildId,
    guild: interaction.guild,
    requestUserId: interaction.user.id,
    connection,
    session,
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
    finishReply: async ({ embed, content }) => {
      if (embed) {
        await interaction.followUp({ embeds: [embed] });
        return;
      }
      if (content) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      }
    },
  });
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

  if (!transcript) {
    await interaction.editReply('Please provide some text for `/debugtext`.');
    return;
  }

  try {
    const hermesResult = await runHermesTurnWithOptionalVerbose({
      guildId,
      guild: interaction.guild,
      session,
      transcript,
      logPrefix: '[debugtext]',
    });

    if (ttsEnabled) {
      const connection = getVoiceConnection(guildId);
      if (!connection) {
        await interaction.editReply('TTS is set to `on`, but the bot is not connected to voice right now. Run `/join` first or use `tts: off`.');
        return;
      }

      const tmpDir = createRequestTempDir();
      try {
        const ttsPath = path.join(tmpDir, `reply.${getTtsOutputExtensionForProvider(session.ttsProvider)}`);
        await synthesizeSpeech(hermesResult.reply, ttsPath, session.ttsProvider);
        setVoiceSessionBotSpeaking(guildId, true);
        await playAudioFile(connection, ttsPath);
      } finally {
        setVoiceSessionBotSpeaking(guildId, false);
        await removeRequestTempDir(tmpDir);
      }
    }

    markVoiceSessionUsed(guildId, {
      initialized: true,
      sessionKey: hermesResult.sessionKey,
      hermesResponseId: hermesResult.responseId,
    });

    const replyEmbed = new EmbedBuilder()
      .setTitle('Debug text complete')
      .setColor(0x57f287)
      .addFields(
        {
          name: 'You sent',
          value: fitEmbedFieldValue(transcript),
          inline: false,
        },
        {
          name: 'Hermes replied',
          value: fitEmbedFieldValue(hermesResult.reply),
          inline: false,
        },
        {
          name: 'TTS playback',
          value: ttsEnabled
            ? `On via ${formatTtsProvider(session.ttsProvider)}`
            : 'Off',
          inline: false,
        },
        {
          name: 'Session key',
          value: summarizeSessionKey(hermesResult.sessionKey),
          inline: false,
        },
        {
          name: 'Session id',
          value: summarizeSessionId(hermesResult.responseId),
          inline: false,
        },
        {
          name: 'Latency',
          value: formatLatency(Date.now() - startedAt),
          inline: false,
        },
      )
      .setFooter({ text: 'Debug text only affects this one command call.' });

    await interaction.editReply({ embeds: [replyEmbed] });
  } catch (error) {
    await interaction.editReply({ content: `Processing failed: ${formatPipelineError(error)}` });
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

async function sendAutoModeMessage(guild: NonNullable<ListenExecutionContext['guild']>, textChannelId: string | null, payload: {
  embed?: EmbedBuilder;
  content?: string;
}) {
  if (!textChannelId) return;

  const channel = guild.channels.cache.get(textChannelId) ?? await guild.channels.fetch(textChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  if (payload.embed) {
    await channel.send({ embeds: [payload.embed] });
    return;
  }

  if (payload.content) {
    await channel.send({ content: payload.content });
  }
}

function enableAutoListen(guildId: string, guild: NonNullable<ListenExecutionContext['guild']>, connection: VoiceConnection) {
  disposeAutoListen(guildId);

  const receiver = connection.receiver;
  const controller = { dispose: () => {}, triggerActive: false };

  const onSpeakingStart = (userId: string) => {
    const session = getVoiceSession(guildId);
    if (!session || session.listenMode !== 'auto') return;
    if (userId !== session.createdByUserId) return;
    if (session.botSpeaking || controller.triggerActive || getActiveGuildListenUser(guildId)) return;

    controller.triggerActive = true;
    void runListenTurn({
      guildId,
      guild,
      requestUserId: userId,
      connection,
      session,
      finishReply: async (payload) => {
        const activeSession = getVoiceSession(guildId);
        await sendAutoModeMessage(guild, activeSession?.autoListenTextChannelId ?? null, payload);
      },
    })
      .catch((error) => {
        console.error('Error during auto-listen runListenTurn:', error);
      })
      .finally(() => {
        controller.triggerActive = false;
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
