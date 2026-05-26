import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { getVoiceConnections } from '@discordjs/voice';
import { Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { assertStartupReadiness } from './diagnostics.js';
import {
  handleDebugText,
  handleInfo,
  handleJoin,
  handleJoinModeButton,
  handleLeave,
  handleListen,
  handleVoiceTtsButton,
  handleVoiceVerbose,
  handleVoiceVerboseButton,
} from './discord/handlers.js';
import { handleHelpButton, handleHelpCommand } from './discord/help.js';
import { clearAllVoiceState, listVoiceSessions } from './state.js';

dotenv.config({ override: true, quiet: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const DISCORD_TOKEN = requireEnv('DISCORD_TOKEN');
const DISCORD_GUILD_ID = requireEnv('DISCORD_GUILD_ID');
assertStartupReadiness(process.env);
const LOCK_DIR = path.resolve(process.cwd(), 'tmp');
const LOCK_FILE = path.join(LOCK_DIR, 'bot.lock');

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check if bot is alive'),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and prepare the bridge'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave current voice channel'),
  new SlashCommandBuilder().setName('listen').setDescription('Listen, transcribe, and reply in voice'),
  new SlashCommandBuilder().setName('info').setDescription('Show bridge status and dependency health'),
  new SlashCommandBuilder().setName('help').setDescription('Open the interactive help menu'),
  new SlashCommandBuilder().setName('voice-verbose').setDescription('Configure verbose tool/thread streaming for the active voice session'),
  new SlashCommandBuilder()
    .setName('debugtext')
    .setDescription('Send text directly to the active Hermes voice session')
    .addStringOption((option) =>
      option
        .setName('text')
        .setDescription('The text you want to send instead of speaking')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('tts')
        .setDescription('Play the reply back in voice or keep it chat-only')
        .setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
        ),
    ),
].map((c) => c.toJSON());

async function registerCommands(applicationId: string) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(applicationId, DISCORD_GUILD_ID), {
    body: commands,
  });
  console.log('Slash commands registered');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let shutdownStarted = false;
let botLockHeld = false;

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireBotLock() {
  fs.mkdirSync(LOCK_DIR, { recursive: true });

  if (fs.existsSync(LOCK_FILE)) {
    try {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const existingPid = Number(raw);
      if (Number.isFinite(existingPid) && existingPid > 0 && pidExists(existingPid)) {
        console.error(`Another Hermes-Discord-Voice process is already running (pid ${existingPid}). Stop it before starting a new one.`);
        process.exit(1);
      }
      fs.rmSync(LOCK_FILE, { force: true });
    } catch {
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }

  fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: 'wx' });
  botLockHeld = true;
}

function releaseBotLock() {
  if (!botLockHeld) return;
  try {
    const raw = fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, 'utf8').trim() : '';
    if (!raw || Number(raw) === process.pid) {
      fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch {
    fs.rmSync(LOCK_FILE, { force: true });
  } finally {
    botLockHeld = false;
  }
}

function destroyAllVoiceConnections() {
  const connections = Array.from(getVoiceConnections().entries());
  for (const [guildId, connection] of connections) {
    try {
      console.log('Destroying voice connection during shutdown', {
        guildId,
        channelId: connection.joinConfig.channelId,
      });
      connection.destroy();
    } catch (error) {
      console.error('Failed to destroy voice connection during shutdown', { guildId, error });
    }
  }
}

async function gracefulShutdown(signal: NodeJS.Signals | 'UNCAUGHT_EXCEPTION' | 'UNHANDLED_REJECTION') {
  if (shutdownStarted) return;
  shutdownStarted = true;

  console.log(`Received ${signal}. Cleaning up Discord voice connections...`);

  try {
    const sessions = listVoiceSessions();
    if (sessions.length > 0) {
      console.log('Clearing Hermes voice session references during shutdown', { sessionCount: sessions.length });
    }
    destroyAllVoiceConnections();
    clearAllVoiceState();
    client.destroy();
    releaseBotLock();
  } catch (error) {
    console.error('Shutdown cleanup failed', error);
    releaseBotLock();
  }

  const exitCode = signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1;
  setTimeout(() => process.exit(exitCode), 50).unref();
}

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  void gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  void gracefulShutdown('UNHANDLED_REJECTION');
});

acquireBotLock();

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  const applicationId = client.application?.id;
  if (!applicationId) {
    throw new Error('Could not determine Discord application id after login.');
  }
  await registerCommands(applicationId);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ping') {
        await interaction.reply('pong');
        return;
      }

      if (interaction.commandName === 'help') {
        await handleHelpCommand(interaction);
        return;
      }

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'join') {
        await handleJoin(interaction);
        return;
      }

      if (interaction.commandName === 'voice-verbose') {
        await handleVoiceVerbose(interaction);
        return;
      }

      if (interaction.commandName === 'leave') {
        await handleLeave(interaction);
        return;
      }

      if (interaction.commandName === 'listen') {
        await handleListen(interaction);
        return;
      }

      if (interaction.commandName === 'debugtext') {
        await handleDebugText(interaction);
        return;
      }

      if (interaction.commandName === 'info') {
        await handleInfo(interaction);
        return;
      }

      await interaction.editReply('Unknown command.');
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('voice-mode:')) {
        await handleJoinModeButton(interaction);
        return;
      }

      if (interaction.customId.startsWith('voice-tts:')) {
        await handleVoiceTtsButton(interaction);
        return;
      }

      if (interaction.customId.startsWith('voice-verbose:')) {
        await handleVoiceVerboseButton(interaction);
        return;
      }

      await handleHelpButton(interaction);
    }

  } catch (err) {
    console.error('Command error:', err);
    if (!interaction.isRepliable()) return;
    const msg = `Error: ${err instanceof Error ? err.message : 'unknown error'}`;
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: msg });
      } else if (interaction.replied) {
        await interaction.followUp({ content: msg, flags: 64 });
      } else {
        await interaction.reply({ content: msg, flags: 64 });
      }
    } catch (replyErr) {
      console.error('Failed to send error response:', replyErr);
    }
  }
});

client.login(DISCORD_TOKEN);
