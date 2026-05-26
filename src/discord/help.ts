import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { checkDiscordBotAuth, collectBridgeHealth } from '../diagnostics.js';
import { buildInfoEmbed } from './embeds.js';

const HELP_HOME = 'help:home';
const HELP_COMMANDS = 'help:commands';
const HELP_INFO = 'help:info';
const HELP_DOCTOR = 'help:doctor';

function buildHelpButtons(active: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(HELP_HOME)
        .setLabel('Home')
        .setStyle(active === HELP_HOME ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(HELP_COMMANDS)
        .setLabel('Commands')
        .setStyle(active === HELP_COMMANDS ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(HELP_INFO)
        .setLabel('Info')
        .setStyle(active === HELP_INFO ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(HELP_DOCTOR)
        .setLabel('Doctor')
        .setStyle(active === HELP_DOCTOR ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  ];
}

function buildHomeEmbed() {
  return new EmbedBuilder()
    .setTitle('Help')
    .setColor(0x5865f2)
    .setDescription('Choose a panel below to browse commands, open the live status view, or run a bridge health check right inside Discord.')
    .addFields(
      {
        name: 'Commands',
        value: 'See every available slash command with a short explanation.',
      },
      {
        name: 'Info',
        value: 'Open the same status dashboard as `/info`.',
      },
      {
        name: 'Doctor',
        value: 'Run a lightweight bridge health check for env, binaries, model, and Discord auth.',
      },
    )
    .setFooter({ text: 'All help panels are ephemeral and only visible to you.' });
}

export function buildCommandsEmbed() {
  return new EmbedBuilder()
    .setTitle('Commands')
    .setColor(0x5865f2)
    .addFields(
      { name: '/join', value: 'Join your current voice channel and prepare an Hermes session.' },
      { name: '/listen', value: 'Capture one spoken turn, send it to Hermes, and play the spoken reply.' },
      { name: '/interrupt', value: 'Stop the current Auto-listen playback.' },
      { name: '/stop-voice', value: 'Stop the current voice playback, TTS request, or Hermes run.' },
      { name: '/voice-verbose', value: 'Enable a separate Discord thread for tool calls and background execution details.' },
      { name: '/debugtext', value: 'Send plain text directly into the active voice session for debugging.' },
      { name: '/leave', value: 'Leave voice and clean up the active Hermes session.' },
      { name: '/info', value: 'Show the live bridge status, session state, locks, and dependency summary.' },
      { name: '/help', value: 'Open this interactive help menu.' },
      { name: '/ping', value: 'Quick liveness check for the bot.' },
    );
}

async function buildDoctorEmbed() {
  const health = collectBridgeHealth(process.env);
  const token = process.env.DISCORD_TOKEN?.trim() || '';
  const discordAuth = token
    ? await checkDiscordBotAuth(token)
    : { name: 'Discord bot auth', ok: false, detail: 'DISCORD_TOKEN is missing.' };
  const issues = [
    ...health.env.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`),
    ...health.binaries.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`),
    ...(health.whisperModel.ok ? [] : [`${health.whisperModel.name}: ${health.whisperModel.detail}`]),
    ...(discordAuth.ok ? [] : [`${discordAuth.name}: ${discordAuth.detail}`]),
  ];

  return new EmbedBuilder()
    .setTitle('Doctor')
    .setColor(issues.length ? 0xed4245 : 0x57f287)
    .setDescription(issues.length ? 'Bridge health check completed with warnings.' : 'Bridge health check passed.')
    .addFields(
      {
        name: 'Environment',
        value: health.env.map((item) => `${item.ok ? 'OK' : 'MISSING'} ${item.name}`).join('\n'),
        inline: true,
      },
      {
        name: 'Binaries',
        value: health.binaries.map((item) => `${item.ok ? 'OK' : 'MISSING'} ${item.name}`).join('\n'),
        inline: true,
      },
      {
        name: 'Whisper model',
        value: `${health.whisperModel.ok ? 'OK' : 'MISSING'} ${health.whisperModel.detail}`,
        inline: false,
      },
      {
        name: 'Discord auth',
        value: `${discordAuth.ok ? 'OK' : 'FAIL'} ${discordAuth.ok ? 'succeeded' : discordAuth.detail}`,
        inline: false,
      },
    )
    .setFooter({ text: 'For the terminal version, run npm run doctor:bridge' });
}

export async function handleHelpCommand(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    embeds: [buildHomeEmbed()],
    components: buildHelpButtons(HELP_HOME),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHelpButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith('help:')) return;

  await interaction.deferUpdate();

  if (interaction.customId === HELP_HOME) {
    await interaction.editReply({ embeds: [buildHomeEmbed()], components: buildHelpButtons(HELP_HOME) });
    return;
  }

  if (interaction.customId === HELP_COMMANDS) {
    await interaction.editReply({ embeds: [buildCommandsEmbed()], components: buildHelpButtons(HELP_COMMANDS) });
    return;
  }

  if (interaction.customId === HELP_INFO) {
    await interaction.editReply({
      embeds: [buildInfoEmbed(interaction.guildId, interaction.user.id)],
      components: buildHelpButtons(HELP_INFO),
    });
    return;
  }

  if (interaction.customId === HELP_DOCTOR) {
    await interaction.editReply({
      embeds: [await buildDoctorEmbed()],
      components: buildHelpButtons(HELP_DOCTOR),
    });
  }
}
