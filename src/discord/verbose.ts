import { EmbedBuilder, Guild, TextChannel, ThreadChannel, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { askHermes } from '../hermes.js';
import { type VoiceSessionState } from '../state.js';
import { formatPipelineError, summarizeSessionKey } from './helpers.js';

type HermesTurnExecutionOptions = {
  guildId: string;
  guild: Guild;
  session: VoiceSessionState;
  transcript: string;
  logPrefix?: string;
};

function trimVerboseMessage(text: string, maxLength = 1_800): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

async function resolveVerboseThread(guild: Guild, threadId: string): Promise<ThreadChannel | null> {
  const channel = guild.channels.cache.get(threadId) ?? await guild.channels.fetch(threadId).catch(() => null);
  return channel instanceof ThreadChannel ? channel : null;
}

async function sendVerboseNoticeToThread(guild: Guild, threadId: string, message: string): Promise<void> {
  const thread = await resolveVerboseThread(guild, threadId);
  if (!thread) return;

  if (thread.archived && !thread.locked) {
    await thread.setArchived(false).catch(() => {});
  }

  await thread.send({ content: trimVerboseMessage(message) });
}

export async function runHermesTurnWithOptionalVerbose(options: HermesTurnExecutionOptions) {
  const { guild, session, transcript, logPrefix = '[turn]' } = options;

  if (session.verboseEnabled && session.verboseThreadId) {
    await sendVerboseNoticeToThread(
      guild,
      session.verboseThreadId,
      `**Hermes turn started**\nConversation: ${summarizeSessionKey(session.sessionKey)}`,
    ).catch((error) => {
      console.warn(logPrefix, 'Verbose start notice failed', { error: formatPipelineError(error) });
    });
  }

  const result = await askHermes(transcript, {
    sessionKey: session.sessionKey,
    responseId: session.hermesResponseId,
  });

  if (session.verboseEnabled && session.verboseThreadId) {
    await sendVerboseNoticeToThread(
      guild,
      session.verboseThreadId,
      `**Hermes final reply**\n${result.reply}`,
    ).catch((error) => {
      console.warn(logPrefix, 'Verbose final notice failed', { error: formatPipelineError(error) });
    });
  }

  return result;
}

function getVerboseHostChannel(channel: ChatInputCommandInteraction['channel'] | ButtonInteraction['channel']): TextChannel | null {
  if (!channel) return null;
  if (channel instanceof TextChannel) return channel;
  if (channel instanceof ThreadChannel && channel.parent instanceof TextChannel) return channel.parent;
  return null;
}

export async function ensureVerboseThread(
  guild: Guild,
  channel: ChatInputCommandInteraction['channel'] | ButtonInteraction['channel'],
  session: VoiceSessionState,
): Promise<ThreadChannel> {
  if (session.verboseThreadId) {
    const existing = await resolveVerboseThread(guild, session.verboseThreadId);
    if (existing) {
      if (existing.archived && !existing.locked) {
        await existing.setArchived(false).catch(() => {});
      }
      return existing;
    }
  }

  const hostChannel = getVerboseHostChannel(channel);
  if (!hostChannel) {
    throw new Error('Verbose mode needs a normal text channel so I can create a thread there.');
  }

  const starter = await hostChannel.send({
    content: `Verbose mode stream for ${summarizeSessionKey(session.sessionKey)}`,
  });
  const thread = await starter.startThread({
    name: `voice-verbose-${new Date().toISOString().slice(11, 16).replace(':', '-')}`,
    autoArchiveDuration: 60,
    reason: 'Hermes voice verbose stream',
  });
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('Verbose mode active')
        .setColor(0x5865f2)
        .setDescription('Hermes turn starts and final replies for this voice session will appear here.'),
    ],
  });
  return thread;
}
