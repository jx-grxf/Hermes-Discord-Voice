import { EmbedBuilder, Guild, TextChannel, ThreadChannel, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { askHermes, isHermesVerboseStreamingEnabled, type HermesStreamEvent } from '../hermes.js';
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

function trimVerboseBlock(text: string, maxLength = 1_200): string {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}...` : trimmed;
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

async function createVerboseStreamHandler(guild: Guild, threadId: string) {
  const thread = await resolveVerboseThread(guild, threadId);
  if (!thread) return null;

  if (thread.archived && !thread.locked) {
    await thread.setArchived(false).catch(() => {});
  }

  let replyText = '';
  let lastEditAt = 0;
  let pendingEdit: NodeJS.Timeout | null = null;
  const replyMessage = await thread.send({ content: '**Hermes streaming reply**\nWaiting for first token...' });

  const editReply = async (force = false) => {
    if (!replyText.trim()) return;
    const now = Date.now();
    if (!force && now - lastEditAt < 1_250) {
      if (!pendingEdit) {
        pendingEdit = setTimeout(() => {
          pendingEdit = null;
          void editReply(true);
        }, 1_250 - (now - lastEditAt));
      }
      return;
    }

    lastEditAt = now;
    await replyMessage.edit({ content: trimVerboseMessage(`**Hermes streaming reply**\n${replyText}`) }).catch(() => {});
  };

  const handleEvent = async (event: HermesStreamEvent) => {
    if (event.type === 'text_delta') {
      replyText += event.text;
      await editReply(false);
      return;
    }

    if (event.type === 'tool_started') {
      await thread.send({
        content: trimVerboseMessage(
          [
            `**Tool started:** \`${event.name}\``,
            event.arguments ? `\`\`\`json\n${trimVerboseBlock(event.arguments)}\n\`\`\`` : '',
          ].filter(Boolean).join('\n'),
        ),
      });
      return;
    }

    if (event.type === 'tool_completed') {
      await thread.send({
        content: trimVerboseMessage(
          [
            `**Tool completed${event.name ? `: \`${event.name}\`` : ''}**`,
            event.output ? `\`\`\`text\n${trimVerboseBlock(event.output)}\n\`\`\`` : '',
          ].filter(Boolean).join('\n'),
        ),
      });
      return;
    }

    if (event.type === 'response_completed') {
      if (!replyText.trim() && event.text?.trim()) {
        replyText = event.text.trim();
      }
      if (pendingEdit) {
        clearTimeout(pendingEdit);
        pendingEdit = null;
      }
      await editReply(true);
    }
  };

  const flush = async () => {
    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }
    await editReply(true);
  };

  return { handleEvent, flush };
}

export async function runHermesTurnWithOptionalVerbose(options: HermesTurnExecutionOptions) {
  const { guild, session, transcript, logPrefix = '[turn]' } = options;

  let streamHandler: Awaited<ReturnType<typeof createVerboseStreamHandler>> = null;
  if (session.verboseEnabled && session.verboseThreadId) {
    await sendVerboseNoticeToThread(
      guild,
      session.verboseThreadId,
      `**Hermes turn started**\nConversation: ${summarizeSessionKey(session.sessionKey)}`,
    ).catch((error) => {
      console.warn(logPrefix, 'Verbose start notice failed', { error: formatPipelineError(error) });
    });

    if (isHermesVerboseStreamingEnabled()) {
      streamHandler = await createVerboseStreamHandler(guild, session.verboseThreadId).catch((error) => {
        console.warn(logPrefix, 'Verbose stream setup failed', { error: formatPipelineError(error) });
        return null;
      });
    } else {
      await sendVerboseNoticeToThread(
        guild,
        session.verboseThreadId,
        '**Hermes streaming disabled**\nSet `HERMES_VERBOSE_STREAM=1` and point `HERMES_API_BASE_URL`/`HERMES_API_KEY` at a running Hermes API server to stream text deltas and tool events.',
      ).catch((error) => {
        console.warn(logPrefix, 'Verbose stream disabled notice failed', { error: formatPipelineError(error) });
      });
    }
  }

  const result = await askHermes(transcript, {
    sessionKey: session.sessionKey,
    responseId: session.hermesResponseId,
  }, {
    onEvent: streamHandler?.handleEvent,
  });

  if (streamHandler) {
    await streamHandler.flush().catch((error) => {
      console.warn(logPrefix, 'Verbose stream flush failed', { error: formatPipelineError(error) });
    });
  }

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
