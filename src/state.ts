import { randomUUID } from 'node:crypto';
import type { TtsProvider } from './audio.js';

export type VoiceSessionState = {
  channelId: string;
  createdAt: number;
  createdByUserId: string;
  sessionKey: string;
  hermesResponseId: string | null;
  initializedAt: number | null;
  lastUsedAt: number | null;
  listenMode: 'slash' | 'auto';
  autoListenTextChannelId: string | null;
  botSpeaking: boolean;
  verboseEnabled: boolean;
  verboseThreadId: string | null;
  verboseStartedAt: number | null;
  ttsProvider: TtsProvider;
  speakerAllowlistUserIds: string[];
};

const activeSessionByGuild = new Map<string, VoiceSessionState>();
const activeListenByGuild = new Map<string, string>();
const activeJoinByGuild = new Map<string, string>();

function resolveHermesSessionPrefix(): string {
  return process.env.HERMES_VOICE_SESSION_PREFIX?.trim() || 'hermes-discord-voice';
}

function resolveDefaultTtsProvider(): TtsProvider {
  const provider = process.env.TTS_PROVIDER?.trim().toLowerCase();
  if (provider === 'hermes') return 'hermes';
  if (provider === 'elevenlabs') return 'elevenlabs';
  if (provider === 'piper') return 'piper';
  return 'say';
}

export function buildVoiceSessionKey(guildId: string, channelId: string): string {
  return `${resolveHermesSessionPrefix()}:guild:${guildId}:channel:${channelId}:join:${randomUUID()}`;
}

export function createVoiceSession(
  guildId: string,
  channelId: string,
  discordUserId: string,
  sessionRef: { sessionKey?: string | null; hermesResponseId?: string | null } = {},
): VoiceSessionState {
  const session: VoiceSessionState = {
    channelId,
    createdAt: Date.now(),
    createdByUserId: discordUserId,
    sessionKey: sessionRef.sessionKey?.trim() || buildVoiceSessionKey(guildId, channelId),
    hermesResponseId: sessionRef.hermesResponseId?.trim() || null,
    initializedAt: null,
    lastUsedAt: null,
    listenMode: 'slash',
    autoListenTextChannelId: null,
    botSpeaking: false,
    verboseEnabled: false,
    verboseThreadId: null,
    verboseStartedAt: null,
    ttsProvider: resolveDefaultTtsProvider(),
    speakerAllowlistUserIds: [discordUserId],
  };

  activeSessionByGuild.set(guildId, session);
  return session;
}

export function markVoiceSessionUsed(
  guildId: string,
  updates: { hermesResponseId?: string | null; sessionKey?: string | null; initialized?: boolean } = {},
): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return null;

  session.lastUsedAt = Date.now();

  if (typeof updates.sessionKey === 'string' && updates.sessionKey.trim()) {
    session.sessionKey = updates.sessionKey.trim();
  }

  if (typeof updates.hermesResponseId === 'string' && updates.hermesResponseId.trim()) {
    session.hermesResponseId = updates.hermesResponseId.trim();
  }

  if (updates.initialized && !session.initializedAt) {
    session.initializedAt = Date.now();
  }

  return session;
}

export function getVoiceSession(guildId: string): VoiceSessionState | null {
  return activeSessionByGuild.get(guildId) ?? null;
}

export function setVoiceSessionListenMode(
  guildId: string,
  mode: 'slash' | 'auto',
  options: { textChannelId?: string | null } = {},
): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return null;

  session.listenMode = mode;
  session.autoListenTextChannelId = mode === 'auto' ? options.textChannelId?.trim() || session.autoListenTextChannelId : null;
  return session;
}

export function setVoiceSessionBotSpeaking(guildId: string, speaking: boolean): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return null;

  session.botSpeaking = speaking;
  return session;
}

export function setVoiceSessionVerbose(
  guildId: string,
  enabled: boolean,
  options: { threadId?: string | null } = {},
): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return null;

  session.verboseEnabled = enabled;
  session.verboseThreadId = enabled ? options.threadId?.trim() || session.verboseThreadId : null;
  session.verboseStartedAt = enabled ? Date.now() : null;
  return session;
}

export function setVoiceSessionTtsProvider(guildId: string, provider: TtsProvider): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return null;

  session.ttsProvider = provider;
  return session;
}

function normalizeSpeakerAllowlist(session: VoiceSessionState): string[] {
  const ids = new Set<string>();
  ids.add(session.createdByUserId);
  for (const userId of session.speakerAllowlistUserIds) {
    const trimmed = userId.trim();
    if (trimmed) ids.add(trimmed);
  }
  session.speakerAllowlistUserIds = Array.from(ids);
  return session.speakerAllowlistUserIds;
}

export function listVoiceSessionSpeakers(guildId: string): string[] {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return [];
  return [...normalizeSpeakerAllowlist(session)];
}

export function isVoiceSessionSpeakerAllowed(guildId: string, discordUserId: string): boolean {
  const session = activeSessionByGuild.get(guildId);
  if (!session) return false;
  return normalizeSpeakerAllowlist(session).includes(discordUserId.trim());
}

export function addVoiceSessionSpeaker(guildId: string, discordUserId: string): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  const trimmed = discordUserId.trim();
  if (!session || !trimmed) return session ?? null;

  normalizeSpeakerAllowlist(session);
  if (!session.speakerAllowlistUserIds.includes(trimmed)) {
    session.speakerAllowlistUserIds.push(trimmed);
  }
  return session;
}

export function removeVoiceSessionSpeaker(guildId: string, discordUserId: string): VoiceSessionState | null {
  const session = activeSessionByGuild.get(guildId);
  const trimmed = discordUserId.trim();
  if (!session || !trimmed) return session ?? null;

  normalizeSpeakerAllowlist(session);
  if (trimmed === session.createdByUserId) return session;
  session.speakerAllowlistUserIds = session.speakerAllowlistUserIds.filter((userId) => userId !== trimmed);
  normalizeSpeakerAllowlist(session);
  return session;
}

export function beginGuildJoin(guildId: string, discordUserId: string): { ok: boolean; activeUserId: string | null } {
  const activeUserId = activeJoinByGuild.get(guildId) ?? null;
  if (activeUserId) {
    return { ok: false, activeUserId };
  }

  activeJoinByGuild.set(guildId, discordUserId);
  return { ok: true, activeUserId };
}

export function endGuildJoin(guildId: string, discordUserId: string): void {
  if (activeJoinByGuild.get(guildId) === discordUserId) {
    activeJoinByGuild.delete(guildId);
  }
}

export function getActiveGuildJoinUser(guildId: string): string | null {
  return activeJoinByGuild.get(guildId) ?? null;
}

export function clearVoiceSession(guildId: string): VoiceSessionState | null {
  const existing = activeSessionByGuild.get(guildId) ?? null;
  activeSessionByGuild.delete(guildId);
  return existing;
}

export function beginGuildListen(guildId: string, discordUserId: string): { ok: boolean; activeUserId: string | null } {
  const activeUserId = activeListenByGuild.get(guildId) ?? null;
  if (activeUserId) {
    return { ok: false, activeUserId };
  }

  activeListenByGuild.set(guildId, discordUserId);
  return { ok: true, activeUserId };
}

export function endGuildListen(guildId: string, discordUserId: string): void {
  if (activeListenByGuild.get(guildId) === discordUserId) {
    activeListenByGuild.delete(guildId);
  }
}

export function getActiveGuildListenUser(guildId: string): string | null {
  return activeListenByGuild.get(guildId) ?? null;
}

export function clearAllVoiceState(): void {
  activeSessionByGuild.clear();
  activeListenByGuild.clear();
  activeJoinByGuild.clear();
}

export function listVoiceSessions(): Array<{ guildId: string; session: VoiceSessionState }> {
  return Array.from(activeSessionByGuild.entries()).map(([guildId, session]) => ({ guildId, session }));
}
