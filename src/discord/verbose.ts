import { EmbedBuilder, Guild, TextChannel, ThreadChannel, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import {
  askOpenClaw,
  getOpenClawChatHistory,
  type OpenClawChatHistoryMessage,
} from '../openclaw.js';
import { type VoiceSessionState } from '../state.js';
import { formatPipelineError, redactSessionKey, sleep, summarizeSessionKey } from './helpers.js';

type OpenClawTurnExecutionOptions = {
  guildId: string;
  guild: Guild;
  session: VoiceSessionState;
  transcript: string;
  logPrefix?: string;
};

function buildVerboseValue(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const nested = value
      .map((entry) => buildVerboseValue(entry))
      .filter((entry) => entry.length > 0);
    if (nested.length > 0) {
      return nested.join('\n');
    }
  }
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const textParts = content
        .flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const record = entry as { type?: unknown; text?: unknown };
          return record.type === 'text' && typeof record.text === 'string' ? [record.text.trim()] : [];
        })
        .filter((entry) => entry.length > 0);
      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return '';
}

function trimVerboseMessage(text: string, maxLength = 1_800): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseTextSignaturePhase(block: Record<string, unknown>): string | null {
  const raw = typeof block.textSignature === 'string' ? block.textSignature.trim() : '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { phase?: unknown };
    return typeof parsed.phase === 'string' ? parsed.phase : null;
  } catch {
    return null;
  }
}

function buildVerboseHistoryMessages(message: OpenClawChatHistoryMessage): string[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const results: string[] = [];

  if (message.role === 'assistant') {
    for (const block of content) {
      const type = typeof block.type === 'string' ? block.type : '';

      if (type === 'text') {
        const text = typeof block.text === 'string' ? block.text.trim() : '';
        const phase = parseTextSignaturePhase(block);
        if (!text || phase === 'final_answer') continue;
        results.push(trimVerboseMessage(`**Assistant note**\n${text}`));
        continue;
      }

      if (type === 'toolCall') {
        const toolName = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool';
        const args = buildVerboseValue(block.arguments ?? block.partialJson);
        results.push(
          trimVerboseMessage(
            args
              ? `**Tool call:** \`${toolName}\`\n\`\`\`json\n${args}\n\`\`\``
              : `**Tool call:** \`${toolName}\``,
          ),
        );
      }
    }
  }

  if (message.role === 'toolResult') {
    const toolName = message.toolName?.trim() || 'tool';
    const text = content
      .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text.trim()] : []))
      .filter((entry) => entry.length > 0)
      .join('\n\n')
      .trim();

    results.push(
      trimVerboseMessage(
        text
          ? `**Tool output:** \`${toolName}\`\n\`\`\`\n${text}\n\`\`\``
          : `**Tool output:** \`${toolName}\``,
      ),
    );
  }

  return results.filter((entry) => entry.trim().length > 0);
}

function buildVerboseHistoryMessageKey(message: OpenClawChatHistoryMessage): string {
  return JSON.stringify({
    role: message.role ?? '',
    toolCallId: message.toolCallId ?? '',
    toolName: message.toolName ?? '',
    timestamp: message.timestamp ?? null,
    content: message.content ?? [],
  });
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

async function mirrorVerboseHistoryToThread(
  guild: Guild,
  threadId: string,
  sessionKey: string,
  state: { seen: Set<string>; startedAt: number | null },
): Promise<void> {
  const messages = await getOpenClawChatHistory(sessionKey, { limit: 200, timeoutMs: 15_000 });
  const minTimestamp = state.startedAt ? state.startedAt - 2_000 : null;

  for (const message of messages) {
    if (minTimestamp && typeof message.timestamp === 'number' && message.timestamp < minTimestamp) {
      continue;
    }

    const key = buildVerboseHistoryMessageKey(message);
    if (state.seen.has(key)) continue;
    state.seen.add(key);

    for (const content of buildVerboseHistoryMessages(message)) {
      try {
        await sendVerboseNoticeToThread(guild, threadId, content);
      } catch (error) {
        console.warn('Verbose thread message send failed', {
          threadId,
          sessionKeyPreview: redactSessionKey(sessionKey),
          error: formatPipelineError(error),
        });
      }
    }
  }
}

export async function runOpenClawTurnWithOptionalVerbose(options: OpenClawTurnExecutionOptions) {
  const { guild, session, transcript, logPrefix = '[turn]' } = options;

  let openClawResult;
  if (session.verboseEnabled && session.verboseThreadId) {
    const historyState = { seen: new Set<string>(), startedAt: session.verboseStartedAt };
    try {
      await mirrorVerboseHistoryToThread(guild, session.verboseThreadId, session.sessionKey, historyState);
    } catch (error) {
      console.warn(logPrefix, 'Initial verbose history sync failed', {
        error: formatPipelineError(error),
      });
    }

    let stopVerbosePolling = false;
    const verbosePolling = (async () => {
      while (!stopVerbosePolling) {
        await sleep(2500);
        if (stopVerbosePolling) break;
        try {
          await mirrorVerboseHistoryToThread(guild, session.verboseThreadId!, session.sessionKey, historyState);
        } catch (error) {
          console.warn(logPrefix, 'Verbose history poll failed', {
            error: formatPipelineError(error),
          });
        }
      }
    })();

    try {
      openClawResult = await askOpenClaw(transcript, {
        sessionKey: session.sessionKey,
        sessionId: session.openClawSessionId,
      });
    } finally {
      stopVerbosePolling = true;
      await verbosePolling.catch(() => {});
      await mirrorVerboseHistoryToThread(guild, session.verboseThreadId, session.sessionKey, historyState).catch(() => {});
    }
  } else {
    openClawResult = await askOpenClaw(transcript, {
      sessionKey: session.sessionKey,
      sessionId: session.openClawSessionId,
    });
  }

  return openClawResult;
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
    reason: 'OpenClaw voice verbose stream',
  });
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('Verbose mode active')
        .setColor(0x5865f2)
        .setDescription('Tool calls and background execution details for this voice session will appear here.'),
    ],
  });
  return thread;
}
