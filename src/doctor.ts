import dotenv from 'dotenv';
import { spawnSync } from 'node:child_process';
import {
  checkDiscordBotAuth,
  checkDiscordCommandRegistrationAccess,
  checkDiscordGuildAccess,
  collectBridgeHealth,
  collectHermesApiHealth,
} from './diagnostics.js';
import { getHermesTransport } from './hermes.js';

dotenv.config({ override: true, quiet: true });

type DoctorRow = {
  label: string;
  ok: boolean;
  detail: string;
};

function printSection(title: string, rows: DoctorRow[]) {
  console.log(`\n== ${title} ==`);
  for (const row of rows) {
    const status = row.ok ? '[OK]  ' : '[FAIL]';
    console.log(`${status} ${row.label}`);
    if (row.detail) {
      console.log(`       ${row.detail}`);
    }
  }
}

function checkHermesCli(): DoctorRow {
  const cli = process.env.HERMES_CLI?.trim() || 'hermes';
  const result = spawnSync(cli, ['version'], { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();

  return {
    label: 'Hermes CLI',
    ok: result.status === 0,
    detail: result.status === 0 ? output.split('\n')[0] || cli : output || `failed to run ${cli} version`,
  };
}

async function main() {
  const health = collectBridgeHealth(process.env);
  const token = process.env.DISCORD_TOKEN?.trim() || '';
  const discordAuth = token
    ? await checkDiscordBotAuth(token)
    : { name: 'Discord bot auth', ok: false, detail: 'DISCORD_TOKEN is missing.' };
  const guildId = process.env.DISCORD_GUILD_ID?.trim() || '';
  const applicationId = token && discordAuth.ok
    ? await fetchDiscordApplicationId(token)
    : null;
  const discordGuild = token
    ? await checkDiscordGuildAccess(token, guildId)
    : { name: 'Discord guild access', ok: false, detail: 'DISCORD_TOKEN is missing.' };
  const discordCommands = token && applicationId
    ? await checkDiscordCommandRegistrationAccess(token, applicationId, guildId)
    : { name: 'Discord slash command access', ok: false, detail: 'bot auth failed or application id is unavailable.' };
  const envRows: DoctorRow[] = health.env.map((item) => ({
    label: item.name,
    ok: item.ok,
    detail: item.detail,
  }));
  const binaryRows: DoctorRow[] = health.binaries.map((item) => ({
    label: item.name,
    ok: item.ok,
    detail: item.detail,
  }));
  const assetRows: DoctorRow[] = [
    {
      label: health.whisperModel.name,
      ok: health.whisperModel.ok,
      detail: health.whisperModel.detail,
    },
  ];
  const discordRows: DoctorRow[] = [
    {
      label: 'Bot authentication',
      ok: discordAuth.ok,
      detail: discordAuth.ok ? 'succeeded' : discordAuth.detail,
    },
    {
      label: discordGuild.name,
      ok: discordGuild.ok,
      detail: discordGuild.detail,
    },
    {
      label: discordCommands.name,
      ok: discordCommands.ok,
      detail: discordCommands.detail,
    },
  ];
  const hermesApi = await collectHermesApiHealth(process.env);
  const hermesRows: DoctorRow[] = [
    {
      label: 'Transport',
      ok: true,
      detail: getHermesTransport(),
    },
    checkHermesCli(),
    ...(hermesApi ? [{
      label: hermesApi.name,
      ok: hermesApi.ok,
      detail: hermesApi.detail,
    }] : []),
  ];

  console.log('Hermes-Discord-Voice Doctor');
  console.log('==============================');
  printSection('Environment', envRows);
  printSection('Hermes', hermesRows);
  printSection('Binaries', binaryRows);
  printSection('Assets', assetRows);
  printSection('Discord', discordRows);

  const hasFailures =
    health.env.some((item) => !item.ok) ||
    health.binaries.some((item) => !item.ok) ||
    !health.whisperModel.ok ||
    hermesRows.some((item) => !item.ok) ||
    discordRows.some((item) => !item.ok);

  console.log(`\nSummary: ${hasFailures ? 'FAILURES DETECTED' : 'ALL CHECKS PASSED'}`);
  process.exitCode = hasFailures ? 1 : 0;
}

void main();

async function fetchDiscordApplicationId(token: string): Promise<string | null> {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` },
  }).catch(() => null);
  if (!response?.ok) return null;
  const data = await response.json().catch(() => null) as { id?: unknown } | null;
  return typeof data?.id === 'string' ? data.id : null;
}
