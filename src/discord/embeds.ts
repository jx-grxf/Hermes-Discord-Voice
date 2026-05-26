import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';
import { collectBridgeHealth, summarizeHealthIssues } from '../diagnostics.js';
import { getActiveGuildJoinUser, getActiveGuildListenUser, getVoiceSession, type VoiceSessionState } from '../state.js';
import { getVoiceConnection } from '@discordjs/voice';
import type { TtsProvider } from '../audio.js';
import { formatAge } from '../utils.js';
import {
  formatSessionStatus,
  summarizeSessionId,
  summarizeSessionKey,
  statusLabel,
} from './helpers.js';

export const VOICE_MODE_SLASH = 'voice-mode:slash';
export const VOICE_MODE_AUTO = 'voice-mode:auto';
export const VOICE_VERBOSE_ENABLE = 'voice-verbose:enable';
export const VOICE_VERBOSE_DISABLE = 'voice-verbose:disable';
export const VOICE_TTS_SAY = 'voice-tts:say';
export const VOICE_TTS_PIPER = 'voice-tts:piper';
export const VOICE_TTS_ELEVENLABS = 'voice-tts:elevenlabs';
export const VOICE_TTS_HERMES = 'voice-tts:hermes';
export const VOICE_ALLOWLIST_ADD = 'voice-allowlist:add';
export const VOICE_ALLOWLIST_REMOVE = 'voice-allowlist:remove';
export const VOICE_ALLOWLIST_DONE = 'voice-allowlist:done';
export const VOICE_ALLOWLIST_ADD_SELECT = 'voice-allowlist:add-select';
export const VOICE_ALLOWLIST_REMOVE_SELECT = 'voice-allowlist:remove-select';

export function formatTtsProvider(provider: TtsProvider): string {
  if (provider === 'hermes') return 'Hermes';
  if (provider === 'elevenlabs') return 'ElevenLabs';
  if (provider === 'piper') return 'Piper';
  return 'Say';
}

export function buildVoiceVerboseButtons(active: boolean) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(VOICE_VERBOSE_ENABLE)
        .setLabel('Yes')
        .setStyle(active ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(VOICE_VERBOSE_DISABLE)
        .setLabel('No')
        .setStyle(active ? ButtonStyle.Danger : ButtonStyle.Secondary),
    ),
  ];
}

export function buildVoiceTtsButtons(activeProvider: TtsProvider) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(VOICE_TTS_SAY)
        .setLabel('Say')
        .setStyle(activeProvider === 'say' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(VOICE_TTS_PIPER)
        .setLabel('Piper')
        .setStyle(activeProvider === 'piper' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(VOICE_TTS_ELEVENLABS)
        .setLabel('ElevenLabs')
        .setStyle(activeProvider === 'elevenlabs' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(VOICE_TTS_HERMES)
        .setLabel('Hermes')
        .setStyle(activeProvider === 'hermes' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  ];
}

export function buildVoiceVerbosePromptEmbed(session: VoiceSessionState) {
  return new EmbedBuilder()
    .setTitle('Voice verbose mode')
    .setColor(session.verboseEnabled ? 0x5865f2 : 0xfee75c)
    .setDescription('Do you want to activate verbose mode for this voice session?')
    .addFields(
      {
        name: 'Session',
        value: summarizeSessionKey(session.sessionKey),
        inline: false,
      },
      {
        name: 'Current status',
        value: session.verboseEnabled
          ? `Active${session.verboseThreadId ? ` in <#${session.verboseThreadId}>` : ''}`
          : 'Inactive',
        inline: false,
      },
      {
        name: 'What it does',
        value: 'Tool calls, verbose updates, and background execution details go into a separate Discord thread. Final voice replies still stay in the normal chat.',
        inline: false,
      },
    );
}

function listSpeakerIds(session: VoiceSessionState): string[] {
  return Array.from(new Set([session.createdByUserId, ...session.speakerAllowlistUserIds]));
}

function listRemovableSpeakerIds(session: VoiceSessionState): string[] {
  return listSpeakerIds(session).filter((userId) => userId !== session.createdByUserId);
}

function formatSpeakerAccess(session: VoiceSessionState): string {
  const speakers = listSpeakerIds(session);
  return speakers
    .map((userId) => userId === session.createdByUserId ? `<@${userId}> (creator)` : `<@${userId}>`)
    .join('\n');
}

export function buildVoiceAllowlistEmbed(session: VoiceSessionState) {
  const removableCount = listRemovableSpeakerIds(session).length;
  return new EmbedBuilder()
    .setTitle('Voice allowlist')
    .setColor(0x5865f2)
    .setDescription('Only users listed here can trigger voice turns for the active session.')
    .addFields(
      {
        name: 'Allowed speakers',
        value: formatSpeakerAccess(session),
        inline: false,
      },
      {
        name: 'Management',
        value: removableCount > 0
          ? 'Use the buttons below to add or remove allowed speakers.'
          : 'Only the creator is currently allowed. Add a user before removal is available.',
        inline: false,
      },
      {
        name: 'Scope',
        value: 'This allowlist is in memory and resets when the voice session is cleared.',
        inline: false,
      },
    );
}

export function buildVoiceAllowlistButtons(session: VoiceSessionState) {
  const hasRemovableSpeakers = listRemovableSpeakerIds(session).length > 0;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(VOICE_ALLOWLIST_ADD)
        .setLabel('Elevate user')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(VOICE_ALLOWLIST_REMOVE)
        .setLabel('Delete user from allowlist')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!hasRemovableSpeakers),
      new ButtonBuilder()
        .setCustomId(VOICE_ALLOWLIST_DONE)
        .setLabel('Done')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildVoiceAllowlistAddSelect() {
  return [
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(VOICE_ALLOWLIST_ADD_SELECT)
        .setPlaceholder('Select a user to allow')
        .setMinValues(1)
        .setMaxValues(1),
    ),
  ];
}

export function buildVoiceAllowlistRemoveSelect(session: VoiceSessionState) {
  const removable = listRemovableSpeakerIds(session).slice(0, 25);
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(VOICE_ALLOWLIST_REMOVE_SELECT)
        .setPlaceholder('Select an allowed user to remove')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          removable.map((userId) => ({
            label: userId,
            value: userId,
            description: `Remove <@${userId}> from this voice session`,
          })),
        ),
    ),
  ];
}

export function buildJoinModeButtons(activeMode: 'slash' | 'auto') {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(VOICE_MODE_SLASH)
        .setLabel('Slash-to-talk')
        .setStyle(activeMode === 'slash' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(VOICE_MODE_AUTO)
        .setLabel('Auto-listen (Beta)')
        .setStyle(activeMode === 'auto' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  ];
}

export function buildJoinControls(session: VoiceSessionState) {
  return [
    ...buildJoinModeButtons(session.listenMode),
    ...buildVoiceTtsButtons(session.ttsProvider),
  ];
}

export function buildJoinEmbed(session: VoiceSessionState, options: {
  channelId: string | null;
  created: boolean;
  issues: string[];
}) {
  const modeText = session.listenMode === 'auto'
    ? 'Auto-listen Beta is active. Speak naturally while the bot is idle, but expect rough edges.'
    : 'Slash-to-talk is active. Run `/listen` whenever you want to speak.';

  const embed = new EmbedBuilder()
    .setTitle('Voice bridge ready')
    .setColor(options.issues.length ? 0xfee75c : 0x57f287)
    .setDescription(`Connected to your voice channel. ${options.created ? 'Created' : 'Reusing'} the active Hermes voice session.`)
    .addFields(
      {
        name: 'Voice',
        value: options.channelId ? `<#${options.channelId}>` : 'Connected',
        inline: true,
      },
      {
        name: 'Mode',
        value: session.listenMode === 'auto' ? 'Auto-listen (Beta)' : 'Slash-to-talk',
        inline: true,
      },
      {
        name: 'Verbose',
        value: session.verboseEnabled
          ? session.verboseThreadId ? `On in <#${session.verboseThreadId}>` : 'On'
          : 'Off',
        inline: true,
      },
      {
        name: 'TTS',
        value: formatTtsProvider(session.ttsProvider),
        inline: true,
      },
      {
        name: 'Speakers',
        value: formatSpeakerAccess(session),
        inline: false,
      },
      {
        name: 'Session key',
        value: summarizeSessionKey(session.sessionKey),
        inline: false,
      },
      {
        name: 'Session id',
        value: summarizeSessionId(session.hermesResponseId),
        inline: false,
      },
      {
        name: 'Next',
        value: `${modeText}\nUse the buttons below to switch modes at any time.`,
        inline: false,
      },
    )
    .setFooter({ text: options.created ? 'Fresh Hermes session prepared' : 'Existing Hermes session reused' });

  if (options.issues.length) {
    embed.addFields({
      name: 'Warnings',
      value: options.issues.map((issue) => `- ${issue}`).join('\n').slice(0, 1024),
    });
  }

  return embed;
}

export function buildInfoEmbed(guildId: string | null, userId: string): EmbedBuilder {
  const health = collectBridgeHealth();
  const issues = summarizeHealthIssues(health);
  const connection = guildId ? getVoiceConnection(guildId) : null;
  const session = guildId ? getVoiceSession(guildId) : null;
  const joinUserId = guildId ? getActiveGuildJoinUser(guildId) : null;
  const listenUserId = guildId ? getActiveGuildListenUser(guildId) : null;
  const sessionLines = session
    ? [
        `Key: ${summarizeSessionKey(session.sessionKey)}`,
        `Id: ${summarizeSessionId(session.hermesResponseId)}`,
        `Created by: \`${session.createdByUserId}\``,
        `Speakers: ${listSpeakerIds(session).map((userId) => `<@${userId}>`).join(', ')}`,
        `Age: ${formatAge(Date.now() - session.createdAt)}`,
        session.lastUsedAt ? `Last used: ${formatAge(Date.now() - session.lastUsedAt)}` : 'Last used: not yet',
      ]
    : [formatSessionStatus(guildId, userId)];
  const activityLines = [
    joinUserId ? `Join setup by \`${joinUserId}\`` : 'No join in progress',
    listenUserId ? `Listen lock by \`${listenUserId}\`` : 'No active listen lock',
    connection?.joinConfig.channelId ? `Voice channel: <#${connection.joinConfig.channelId}>` : 'Voice channel: not connected',
    session ? `Talk mode: ${session.listenMode === 'auto' ? 'Auto-listen (Beta)' : 'Slash-to-talk'}` : 'Talk mode: not set',
    session
      ? `Verbose: ${session.verboseEnabled ? (session.verboseThreadId ? `<#${session.verboseThreadId}>` : 'active') : 'off'}`
      : 'Verbose: not set',
    session?.botSpeaking ? 'Bot speech: active' : 'Bot speech: idle',
  ];
  const envLines = health.env.map((item) => `${statusLabel(item.ok)} ${item.name}`);
  const binaryLines = health.binaries.map((item) => `${statusLabel(item.ok)} ${item.name}`);

  const embed = new EmbedBuilder()
    .setTitle('Bridge status')
    .setColor(issues.length ? 0xed4245 : 0x57f287)
    .setDescription(
      issues.length
        ? 'Bridge is running with warnings. Check the issue summary below.'
        : 'Bridge is healthy and ready for the next voice turn.',
    )
    .addFields(
      {
        name: 'Overview',
        value: [
          connection ? 'Voice: connected' : 'Voice: not connected',
          session ? 'Session: active' : joinUserId ? 'Session: preparing' : 'Session: idle',
          issues.length ? `Runtime: ${issues.length} warning(s)` : 'Runtime: healthy',
        ].join('\n'),
      },
      {
        name: 'Session',
        value: sessionLines.join('\n').slice(0, 1024),
      },
      {
        name: 'Activity',
        value: activityLines.join('\n'),
      },
      {
        name: 'Env',
        value: envLines.join('\n'),
        inline: true,
      },
      {
        name: 'Binaries',
        value: binaryLines.join('\n'),
        inline: true,
      },
      {
        name: 'Whisper',
        value: `${statusLabel(health.whisperModel.ok)} ${health.whisperModel.detail}`,
        inline: true,
      },
    )
    .setFooter({ text: 'Use /join to prepare a session and /listen to capture one turn.' })
    .setTimestamp();

  if (issues.length) {
    embed.addFields({
      name: 'Issue summary',
      value: issues.map((issue) => `- ${issue}`).join('\n').slice(0, 1024),
    });
  }

  return embed;
}
