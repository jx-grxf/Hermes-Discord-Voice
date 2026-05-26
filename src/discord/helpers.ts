import { truncate, formatAge } from '../utils.js';
import { getActiveGuildJoinUser, getVoiceSession } from '../state.js';

export function formatPipelineError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim();
    const firstLine = message.split('\n').find((line) => line.trim())?.trim() ?? message;

    if (message.includes('missing scope: operator.write')) {
      return 'OpenClaw denied live verbose streaming for this session because the local gateway token does not have write scope.';
    }

    return firstLine;
  }
  return 'Unknown voice bridge error.';
}

export function formatCleanupError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim();

    if (message.includes('ETIMEDOUT') || message.includes('timed out')) {
      return 'OpenClaw cleanup timed out before it could confirm the session deletion.';
    }

    if (message.includes('gateway closed') || message.includes('gateway connect failed')) {
      return 'OpenClaw closed the cleanup connection before it could confirm the session deletion.';
    }

    if (message.includes('missing scope: operator.admin')) {
      return 'OpenClaw denied the cleanup request because this local gateway token does not have the needed admin scope.';
    }

    const firstLine = message.split('\n').find((line) => line.trim())?.trim();
    if (firstLine) return firstLine;
  }

  return 'OpenClaw cleanup failed for an unknown reason.';
}

export function fitEmbedFieldValue(value: string, maxLength = 1024): string {
  const trimmed = value.trim();
  if (!trimmed) return '—';
  return truncate(trimmed, maxLength);
}

export function summarizeSessionKey(sessionKey: string): string {
  return `\`${truncate(sessionKey, 72)}\``;
}

export function summarizeSessionId(sessionId: string | null): string {
  return sessionId ? `\`${truncate(sessionId, 48)}\`` : 'Not reported yet';
}

export function statusLabel(ok: boolean): string {
  return ok ? 'OK' : 'MISSING';
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getNoAudioTimeoutMs(): number {
  const raw = Number(process.env.VOICE_NO_AUDIO_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw >= 3_000 ? raw : 12_000;
}

export function getNoSpeechTimeoutMs(): number {
  const raw = Number(process.env.VOICE_NO_SPEECH_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw >= 2_000 ? raw : 5_000;
}

export function getMaxCaptureMs(): number {
  const raw = Number(process.env.VOICE_MAX_CAPTURE_MS ?? '');
  return Number.isFinite(raw) && raw >= 4_000 ? raw : 9_000;
}

export function getListenTimingConfig() {
  return {
    noAudioTimeoutMs: getNoAudioTimeoutMs(),
    noSpeechTimeoutMs: getNoSpeechTimeoutMs(),
    maxCaptureMs: getMaxCaptureMs(),
  };
}

export function redactSessionKey(sessionKey: string): string {
  return truncate(sessionKey, 24);
}

export function buildListenLogDetails(details: {
  guildId: string;
  channelId: string | null;
  speakingStarted: boolean;
  ssrcMapped: boolean;
  opusPackets?: number;
  opusBytes?: number;
  pcmBytes?: number;
  transcriptLength?: number;
  hasOpenClawSessionId?: boolean;
  sessionKey: string;
}) {
  return {
    guildId: details.guildId,
    channelId: details.channelId,
    speakingStarted: details.speakingStarted,
    ssrcMapped: details.ssrcMapped,
    opusPackets: details.opusPackets,
    opusBytes: details.opusBytes,
    pcmBytes: details.pcmBytes,
    transcriptLength: details.transcriptLength,
    hasOpenClawSessionId: details.hasOpenClawSessionId ?? false,
    sessionKeyPreview: redactSessionKey(details.sessionKey),
  };
}

export function formatSessionStatus(guildId: string | null, userId: string): string {
  if (!guildId) return `No voice session has been prepared for you (<@${userId}>) yet.`;
  const joinUserId = getActiveGuildJoinUser(guildId);
  if (joinUserId) {
    return `A voice session is currently being prepared by Discord user: \`${joinUserId}\``;
  }
  const session = getVoiceSession(guildId);
  if (!session) return `No voice session has been prepared for you (<@${userId}>) yet.`;

  const details = [`OpenClaw key: \`${redactSessionKey(session.sessionKey)}\``];
  if (session.openClawSessionId) {
    details.push(`OpenClaw session id: \`${truncate(session.openClawSessionId, 24)}\``);
  }
  details.push(`Created by Discord user: \`${session.createdByUserId}\``);
  details.push(`Created: ${formatAge(Date.now() - session.createdAt)}`);
  if (session.lastUsedAt) {
    details.push(`Last used: ${formatAge(Date.now() - session.lastUsedAt)}`);
  }
  return details.join('\n');
}
