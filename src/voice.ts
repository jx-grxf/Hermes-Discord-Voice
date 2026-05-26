import {
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
  StringSelectMenuInteraction,
} from 'discord.js';

async function replyInteractionError(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  message: string,
) {
  if ('deferred' in interaction && interaction.deferred) {
    await interaction.editReply({ content: message, embeds: [], components: [] });
    return;
  }

  if (interaction.isRepliable()) {
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}

function formatVoiceJoinError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/connect timeout|attempted addresses|timed?out|timeout/i.test(message)) {
    return 'Discord voice networking timed out while joining. This is usually a Discord voice edge/network flake; wait a few seconds, then run `/join` again. If it repeats, switch voice regions or leave and rejoin the channel.';
  }
  if (/ip discovery/i.test(message)) {
    return 'Discord voice networking failed while joining. Try `/join` again, or leave and rejoin the voice channel first.';
  }
  if (/aborted/i.test(message)) {
    return 'The voice connection was interrupted while joining. Wait a moment, then try `/join` again.';
  }
  return `Joining the voice channel failed: ${message}`;
}

function getVoiceJoinAttempts(): number {
  const raw = Number(process.env.VOICE_JOIN_ATTEMPTS ?? '');
  return Number.isFinite(raw) && raw >= 1 ? Math.min(4, Math.floor(raw)) : 2;
}

function getVoiceJoinReadyTimeoutMs(): number {
  const raw = Number(process.env.VOICE_JOIN_READY_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw >= 5_000 ? Math.min(30_000, Math.floor(raw)) : 10_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createVoiceConnection(
  guildId: string,
  channelId: string,
  adapterCreator: Parameters<typeof joinVoiceChannel>[0]['adapterCreator'],
) {
  return joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
}

export async function getOrCreateConnectionFromMember(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
): Promise<VoiceConnection | null> {
  const guild = interaction.guild;
  if (!guild) {
    if ('deferred' in interaction && interaction.deferred) {
      await interaction.editReply({ content: 'This command only works inside a server.' });
    } else if (interaction.isRepliable()) {
      await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }
    return null;
  }

  let member;
  try {
    member = await guild.members.fetch(interaction.user.id);
  } catch (error) {
    console.error('Failed to fetch guild member for voice join', error);
    await replyInteractionError(interaction, 'I could not inspect your voice state in Discord. Try again in a moment.');
    return null;
  }
  const channel = member.voice.channel;
  if (!channel) {
    const message = 'Join a voice channel first, then try again.';
    await replyInteractionError(interaction, message);
    return null;
  }

  let connection: VoiceConnection | null = getVoiceConnection(guild.id) ?? null;
  if (connection && connection.joinConfig.channelId !== channel.id) {
    console.log('Rejected voice connection move', {
      guildId: guild.id,
      fromChannelId: connection.joinConfig.channelId,
      requestedChannelId: channel.id,
      userId: interaction.user.id,
    });
    const message = 'I am already connected to another voice channel in this server. Use `/leave` there first, then try again.';
    if ('deferred' in interaction && interaction.deferred) {
      await interaction.editReply({ content: message, embeds: [], components: [] });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
    return null;
  }

  const maxAttempts = getVoiceJoinAttempts();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (!connection) {
        console.log('Creating voice connection', {
          guildId: guild.id,
          channelId: channel.id,
          userId: interaction.user.id,
          attempt: attempt + 1,
        });
        connection = createVoiceConnection(guild.id, channel.id, guild.voiceAdapterCreator);
      }

      await entersState(connection, VoiceConnectionStatus.Ready, getVoiceJoinReadyTimeoutMs());
      console.log('Voice connection ready', {
        guildId: guild.id,
        channelId: channel.id,
        userId: interaction.user.id,
      });
      return connection;
    } catch (error) {
      console.error('Voice connection failed', {
        guildId: guild.id,
        channelId: channel.id,
        userId: interaction.user.id,
        attempt: attempt + 1,
        error,
      });
      if (connection) {
        try {
          connection.destroy();
        } catch {}
        connection = null;
      }
      if (attempt === maxAttempts - 1) {
        await replyInteractionError(interaction, formatVoiceJoinError(error));
        return null;
      }
      await delay(750 * (attempt + 1));
    }
  }

  return null;
}
