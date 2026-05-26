import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

type OpenClawPayload = {
  text?: string | null;
  content?: string | null;
};

type OpenClawResult = {
  payloads?: OpenClawPayload[];
  outputText?: string;
  text?: string;
  sessionId?: string;
  sessionKey?: string;
  key?: string;
  meta?: {
    summaryText?: string;
    sessionId?: string;
    sessionKey?: string;
  };
};

type OpenClawResponse = {
  result?: OpenClawResult;
  summary?: string;
  text?: string;
  outputText?: string;
  sessionId?: string;
  sessionKey?: string;
  key?: string;
  meta?: {
    sessionId?: string;
    sessionKey?: string;
  };
};

type OpenClawGatewayResponse = {
  ok?: boolean;
  key?: string;
  deleted?: boolean;
  archived?: string[];
  entry?: {
    sessionId?: string;
  };
  result?: OpenClawResult;
  summary?: string;
  text?: string;
  outputText?: string;
  sessionId?: string;
  sessionKey?: string;
  meta?: {
    sessionId?: string;
    sessionKey?: string;
  };
  messages?: OpenClawChatHistoryMessage[];
  audioPath?: string;
  provider?: string;
  outputFormat?: string;
};

export type OpenClawTurnResult = {
  reply: string;
  sessionKey: string;
  sessionId: string | null;
};

export type OpenClawChatHistoryMessage = {
  role?: string;
  content?: Array<Record<string, unknown>>;
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
};

export type OpenClawVerboseEvent = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type OpenClawSessionRef = {
  sessionKey: string;
  sessionId?: string | null;
};

export type OpenClawBootstrapResult = {
  sessionKey: string;
  sessionId: string | null;
};

export type OpenClawDeleteResult = {
  deleted: boolean;
  archived: string[];
};

export type OpenClawTtsResult = {
  audioPath: string;
  provider: string | null;
  outputFormat: string | null;
};

type GatewayConnectEvent = {
  type?: string;
  event?: string;
};

type GatewayResponseFrame = {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: {
    message?: string;
    code?: string;
  };
};

type GatewayEventFrame = {
  type?: string;
  event?: string;
  payload?: unknown;
};

type OpenClawChatSendResponse = {
  runId?: string;
  status?: string;
};

type OpenClawChatMessageBlock = {
  type?: string;
  text?: string;
};

type OpenClawChatMessage = {
  role?: string;
  text?: string;
  content?: OpenClawChatMessageBlock[];
};

type OpenClawChatEvent = {
  runId?: string;
  sessionKey?: string;
  state?: 'delta' | 'final' | 'aborted' | 'error' | string;
  message?: OpenClawChatMessage;
  errorMessage?: string;
};

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function collectNonEmpty(values: Array<string | null | undefined>): string[] {
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
}

function isStatusPlaceholder(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'completed' || normalized === 'accepted' || normalized === 'in_progress' || normalized === 'ok';
}

function parseOpenClawResponse(raw: string): OpenClawResponse | null { 
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as OpenClawResponse;
  } catch {
    return null;
  }
}

function parseGatewayResponse(raw: string): OpenClawGatewayResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as OpenClawGatewayResponse;
  } catch {
    return null;
  }
}

function extractChatMessageText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;

  const record = message as OpenClawChatMessage;
  const directText = typeof record.text === 'string' ? record.text.trim() : '';
  if (directText) return directText;

  if (!Array.isArray(record.content)) return null;
  const text = record.content
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text.trim()] : []))
    .filter((part) => part.length > 0)
    .join('\n\n')
    .trim();

  return text || null;
}

function extractHistoryMessageText(message: OpenClawChatHistoryMessage): string | null {
  if (!Array.isArray(message.content)) return null;

  const text = message.content
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text.trim()] : []))
    .filter((part) => part.length > 0)
    .join('\n\n')
    .trim();

  return text || null;
}

function parseAssistantHistoryPhase(block: Record<string, unknown>): string | null {
  const raw = typeof block.textSignature === 'string' ? block.textSignature.trim() : '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { phase?: unknown };
    return typeof parsed.phase === 'string' ? parsed.phase : null;
  } catch {
    return null;
  }
}

export function extractReplyFromChatHistory(messages: OpenClawChatHistoryMessage[]): string | null {
  const ordered = [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  let lastAssistantText: string | null = null;

  for (const message of ordered) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

    const finalParts: string[] = [];
    const commentaryParts: string[] = [];
    for (const block of message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const text = block.text.trim();
      if (!text) continue;

      const phase = parseAssistantHistoryPhase(block);
      if (phase === 'final_answer') {
        finalParts.push(text);
      } else {
        commentaryParts.push(text);
      }
    }

    if (finalParts.length > 0) {
      lastAssistantText = finalParts.join('\n\n').trim();
    } else if (commentaryParts.length > 0) {
      lastAssistantText = commentaryParts.join('\n\n').trim();
    }
  }

  return lastAssistantText;
}

function findReplyAfterPrompt(
  messages: OpenClawChatHistoryMessage[],
  transcript: string,
  startedAt: number,
): string | null {
  const ordered = [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const normalizedTranscript = transcript.trim();
  const minTimestamp = startedAt - 2_000;

  let promptIndex = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    if (message.role !== 'user') continue;
    const text = extractHistoryMessageText(message);
    if (!text) continue;
    if ((message.timestamp ?? 0) < minTimestamp) continue;
    if (text === normalizedTranscript) {
      promptIndex = index;
      break;
    }
  }

  const relevant = promptIndex >= 0
    ? ordered.slice(promptIndex + 1)
    : ordered.filter((message) => (message.timestamp ?? 0) >= minTimestamp);

  return extractReplyFromChatHistory(relevant);
}

async function recoverReplyFromChatHistory(
  sessionKey: string,
  transcript: string,
  startedAt: number,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<string | null> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const delayMs = Math.max(250, options.delayMs ?? 1_500);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const historyMessages = await getOpenClawChatHistory(sessionKey, { limit: 80, timeoutMs: 20_000 });
    const reply = findReplyAfterPrompt(historyMessages, transcript, startedAt);
    if (reply) return reply;
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return null;
}

export function extractOpenClawReply(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const data = parseOpenClawResponse(trimmed);
  if (!data) return trimmed;

  const payloadTexts = collectNonEmpty(
    (data.result?.payloads ?? []).flatMap((payload) => [payload.text, payload.content]),
  );
  const joinedPayloadReply = payloadTexts.join('\n\n').trim() || null;

  const structuredCandidates = [
    data.result?.outputText,
    data.outputText,
    data.result?.text,
    data.text,
    data.result?.meta?.summaryText,
    data.summary,
  ].filter((value) => !isStatusPlaceholder(value));

  const structuredReply = firstNonEmpty(structuredCandidates);

  return firstNonEmpty([structuredReply, joinedPayloadReply]);
}

export function extractOpenClawSessionId(raw: string): string | null {
  const data = parseOpenClawResponse(raw);
  if (!data) return null;

  return firstNonEmpty([
    data.result?.sessionId,
    data.sessionId,
    data.result?.meta?.sessionId,
  ]);
}

export function extractOpenClawSessionKey(raw: string): string | null {
  const data = parseOpenClawResponse(raw);
  if (!data) return null;

  return firstNonEmpty([
    data.result?.sessionKey,
    data.sessionKey,
    data.key,
    data.result?.key,
    data.result?.meta?.sessionKey,
  ]);
}

function formatCliError(stderr: string, code: number | null): string {
  const detail = stderr.trim() || 'no additional details';
  return `OpenClaw CLI failed (exit ${code ?? 'unknown'}): ${detail}`;
}

function isGatewayConnectFlake(message: string): boolean {
  return (
    message.includes('gateway connect failed')
    || message.includes('gateway closed (1000)')
    || message.includes('gateway closed (1000 normal closure)')
    || message.includes('normal closure')
  );
}

function runOpenClawGatewayCall(
  method: string,
  params: Record<string, unknown>,
  options: { expectFinal?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = ['gateway', 'call', method, '--json', '--params', JSON.stringify(params)];
    if (options.expectFinal) args.push('--expect-final');
    if (typeof options.timeoutMs === 'number') args.push('--timeout', String(options.timeoutMs));

    const proc = spawn('openclaw', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => reject(new Error(`Could not start OpenClaw: ${error.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(formatCliError(stderr || stdout, code)));
        return;
      }
      resolve(stdout);
    });
  });
}

async function runOpenClawGatewayCallWithRetry(
  method: string,
  params: Record<string, unknown>,
  options: { expectFinal?: boolean; timeoutMs?: number; attempts?: number } = {},
): Promise<string> {
  const attempts = Math.max(1, options.attempts ?? 4);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runOpenClawGatewayCall(method, params, options);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !isGatewayConnectFlake(message)) {
        throw error;
      }
      await sleep(600 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`OpenClaw ${method} failed.`);
}

export function buildOpenClawAgentParams(transcript: string, session: OpenClawSessionRef): Record<string, unknown> {
  return {
    idempotencyKey: `openclaw-discord-voice-${randomUUID()}`,
    message: transcript.trim(),
    sessionKey: session.sessionKey.trim(),
    sessionId: session.sessionId?.trim() || undefined,
    thinking: 'off',
  };
}

export function buildOpenClawSessionResetParams(sessionKey: string): Record<string, unknown> {
  return {
    key: sessionKey.trim(),
    reason: 'new',
  };
}

export function buildOpenClawSessionDeleteParams(sessionKey: string): Record<string, unknown> {
  return {
    key: sessionKey.trim(),
    deleteTranscript: true,
  };
}

export function buildOpenClawSessionPatchParams(
  sessionKey: string,
  patch: { verboseLevel?: string | null },
): Record<string, unknown> {
  return {
    key: sessionKey.trim(),
    verboseLevel: typeof patch.verboseLevel === 'string' ? patch.verboseLevel.trim() : null,
  };
}

export async function createOpenClawSession(
  sessionKey: string,
  options: { timeoutMs?: number; attempts?: number } = {},
): Promise<OpenClawBootstrapResult> {
  const raw = await runOpenClawGatewayCallWithRetry('sessions.reset', buildOpenClawSessionResetParams(sessionKey), {
    timeoutMs: options.timeoutMs ?? 30_000,
    attempts: options.attempts ?? 5,
  });
  const data = parseGatewayResponse(raw);
  if (!data?.ok) {
    throw new Error('OpenClaw did not confirm session creation.');
  }

  return {
    sessionKey: firstNonEmpty([data.key, data.sessionKey, sessionKey]) ?? sessionKey,
    sessionId: firstNonEmpty([data.entry?.sessionId, data.sessionId, data.meta?.sessionId]),
  };
}

export async function setOpenClawSessionVerbose(sessionKey: string, verboseLevel: string | null): Promise<void> {
  const data = await callOpenClawGatewayWs(
    'sessions.patch',
    buildOpenClawSessionPatchParams(sessionKey, { verboseLevel }),
    { timeoutMs: 30_000, scopes: ['operator.admin', 'operator.read', 'operator.write'] },
  );
  const payload = data as OpenClawGatewayResponse | undefined;
  if (!payload?.ok) {
    throw new Error('OpenClaw did not confirm the verbose setting update.');
  }
}

export async function deleteOpenClawSession(
  sessionKey: string,
  options: { timeoutMs?: number } = {},
): Promise<OpenClawDeleteResult> {
  try {
    const payload = await callOpenClawGatewayWs(
      'sessions.delete',
      buildOpenClawSessionDeleteParams(sessionKey),
      {
        timeoutMs: options.timeoutMs ?? 30_000,
        scopes: ['operator.admin', 'operator.read', 'operator.write'],
      },
    ) as OpenClawGatewayResponse | undefined;

    if (!payload?.ok) {
      throw new Error('OpenClaw did not confirm session deletion.');
    }

    return {
      deleted: Boolean(payload.deleted),
      archived: payload.archived ?? [],
    };
  } catch (gatewayError) {
    try {
      const raw = await runOpenClawGatewayCallWithRetry('sessions.delete', buildOpenClawSessionDeleteParams(sessionKey), {
        timeoutMs: options.timeoutMs ?? 30_000,
        attempts: 2,
      });
      const data = parseGatewayResponse(raw);
      if (!data?.ok) {
        throw new Error('OpenClaw did not confirm session deletion.');
      }

      return {
        deleted: Boolean(data.deleted),
        archived: data.archived ?? [],
      };
    } catch (cliError) {
      const gatewayMessage = gatewayError instanceof Error ? gatewayError.message : String(gatewayError);
      const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
      throw new Error(
        `OpenClaw session deletion failed via gateway and CLI. Gateway: ${gatewayMessage}. CLI: ${cliMessage}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deleteOpenClawSessionWithRetry(
  sessionKey: string,
  options: { attempts?: number; timeoutMs?: number; backoffMs?: number } = {},
): Promise<OpenClawDeleteResult> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const backoffMs = options.backoffMs ?? 1_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await deleteOpenClawSession(sessionKey, { timeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(backoffMs * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('OpenClaw session deletion failed.');
}

export async function askOpenClaw(transcript: string, session: OpenClawSessionRef): Promise<OpenClawTurnResult> {
  const message = transcript.trim();
  if (!message) {
    return {
      reply: 'I could not understand anything yet. Please try again.',
      sessionKey: session.sessionKey,
      sessionId: session.sessionId ?? null,
    };
  }

  const startedAt = Date.now();
  let raw: string;
  try {
    raw = await runOpenClawGatewayCallWithRetry('agent', buildOpenClawAgentParams(message, session), {
      expectFinal: true,
      timeoutMs: 600_000,
      attempts: 5,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isGatewayConnectFlake(detail)) {
      const recoveredReply = await recoverReplyFromChatHistory(session.sessionKey, message, startedAt);
      if (recoveredReply) {
        return {
          reply: recoveredReply,
          sessionKey: session.sessionKey,
          sessionId: session.sessionId ?? null,
        };
      }
    }
    throw error;
  }

  const reply = extractOpenClawReply(raw);
  let finalReply = reply;
  if (!finalReply) {
    finalReply = await recoverReplyFromChatHistory(session.sessionKey, message, startedAt, {
      attempts: 4,
      delayMs: 1_000,
    });
  }

  if (!finalReply) {
    throw new Error('OpenClaw returned no usable reply.');
  }

  return {
    reply: finalReply,
    sessionKey: extractOpenClawSessionKey(raw) ?? session.sessionKey,
    sessionId: extractOpenClawSessionId(raw) ?? session.sessionId ?? null,
  };
}

export async function getOpenClawChatHistory(
  sessionKey: string,
  options: { limit?: number; timeoutMs?: number } = {},
): Promise<OpenClawChatHistoryMessage[]> {
  const raw = await runOpenClawGatewayCallWithRetry(
    'chat.history',
    {
      sessionKey: sessionKey.trim(),
      limit: Math.max(1, options.limit ?? 200),
    },
    {
      timeoutMs: options.timeoutMs ?? 30_000,
      attempts: 5,
    },
  );

  const data = parseGatewayResponse(raw);
  return Array.isArray(data?.messages) ? data.messages : [];
}

export async function synthesizeOpenClawSpeech(text: string, options: { timeoutMs?: number } = {}): Promise<OpenClawTtsResult> {
  const message = text.trim();
  if (!message) {
    throw new Error('OpenClaw TTS requires non-empty text.');
  }

  const payload = await callOpenClawGatewayWs(
    'tts.convert',
    { text: message, channel: 'discord' },
    {
      timeoutMs: options.timeoutMs ?? 120_000,
      scopes: ['operator.read', 'operator.write'],
    },
  ) as OpenClawGatewayResponse | undefined;

  if (!payload?.audioPath?.trim()) {
    throw new Error('OpenClaw TTS returned no audio file.');
  }

  return {
    audioPath: payload.audioPath.trim(),
    provider: payload.provider?.trim() || null,
    outputFormat: payload.outputFormat?.trim() || null,
  };
}

function resolveGatewayUrl(): string {
  const explicit = process.env.OPENCLAW_GATEWAY_URL?.trim();
  if (explicit) return explicit;

  const port = process.env.OPENCLAW_GATEWAY_PORT?.trim() || '18789';
  return `ws://127.0.0.1:${port}`;
}

function buildGatewayConnectRequest(
  id: string,
  options: { scopes?: string[]; caps?: string[] } = {},
) {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
  const scopes = options.scopes ?? ['operator.read', 'operator.write'];
  const caps = options.caps ?? [];

  return {
    type: 'req',
    id,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        version: '1.0.0',
        platform: 'OpenClaw-Discord-Voice',
        mode: 'backend',
      },
      role: 'operator',
      scopes,
      caps,
      auth: token ? { token } : password ? { password } : undefined,
    },
  };
}

async function connectGatewaySocket(
  timeoutMs = 10_000,
  options: { scopes?: string[]; caps?: string[] } = {},
): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(resolveGatewayUrl());
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`OpenClaw gateway connect timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };

    const fail = (error: Error) => {
      cleanup();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      reject(error);
    };

    const onError = () => {
      fail(new Error('Could not open a WebSocket connection to the OpenClaw gateway.'));
    };

    const onClose = (code: number, reason: Buffer) => {
      fail(new Error(`OpenClaw gateway closed during connect (${code}): ${reason.toString() || 'no reason'}`));
    };

    const onMessage = (rawData: Buffer) => {
      let frame: GatewayConnectEvent | GatewayResponseFrame;
      try {
        frame = JSON.parse(rawData.toString()) as GatewayConnectEvent | GatewayResponseFrame;
      } catch {
        return;
      }

      if (frame.type === 'event' && 'event' in frame && frame.event === 'connect.challenge') {
        ws.send(JSON.stringify(buildGatewayConnectRequest('gw-connect', options)));
        return;
      }

      if (frame.type === 'res' && 'id' in frame && frame.id === 'gw-connect') {
        if (!frame.ok) {
          fail(new Error(`OpenClaw gateway connect failed: ${frame.error?.message || 'unknown error'}`));
          return;
        }

        cleanup();
        resolve(ws);
      }
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

async function connectGatewaySocketWithRetry(
  timeoutMs = 10_000,
  attempts = 2,
  options: { scopes?: string[]; caps?: string[] } = {},
): Promise<WebSocket> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await connectGatewaySocket(timeoutMs, options);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !isGatewayConnectFlake(message)) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Could not connect to the OpenClaw gateway.');
}

async function callOpenClawGatewayWs(
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; scopes?: string[]; caps?: string[] } = {},
): Promise<unknown> {
  const ws = await connectGatewaySocketWithRetry(options.timeoutMs ?? 10_000, 2, {
    scopes: options.scopes,
    caps: options.caps,
  });

  try {
    return await new Promise<unknown>((resolve, reject) => {
      const requestId = `${method}-${randomUUID()}`;
      const timer = setTimeout(() => {
        cleanup();
        ws.close();
        reject(new Error(`OpenClaw gateway ${method} timed out after ${(options.timeoutMs ?? 10_000)}ms.`));
      }, options.timeoutMs ?? 10_000);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
      };

      const fail = (error: Error) => {
        cleanup();
        ws.close();
        reject(error);
      };

      const onError = () => {
        fail(new Error(`The OpenClaw gateway disconnected during ${method}.`));
      };

      const onClose = (code: number, reason: Buffer) => {
        fail(new Error(`OpenClaw gateway closed during ${method} (${code}): ${reason.toString() || 'no reason'}`));
      };

      const onMessage = (rawData: Buffer) => {
        let frame: GatewayResponseFrame;
        try {
          frame = JSON.parse(rawData.toString()) as GatewayResponseFrame;
        } catch {
          return;
        }

        if (frame.type !== 'res' || frame.id !== requestId) {
          return;
        }

        if (!frame.ok) {
          fail(new Error(frame.error?.message || `OpenClaw gateway ${method} failed.`));
          return;
        }

        cleanup();
        ws.close();
        resolve(frame.payload);
      };

      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.send(JSON.stringify({
        type: 'req',
        id: requestId,
        method,
        params,
      }));
    });
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

export async function askOpenClawWithVerbose(
  transcript: string,
  session: OpenClawSessionRef,
  options: { onVerboseEvent?: (event: OpenClawVerboseEvent) => Promise<void> | void } = {},
): Promise<OpenClawTurnResult> {
  const message = transcript.trim();
  if (!message) {
    return {
      reply: 'I could not understand anything yet. Please try again.',
      sessionKey: session.sessionKey,
      sessionId: session.sessionId ?? null,
    };
  }

  const requestId = `chat-send-${randomUUID()}`;
  const runId = `openclaw-discord-voice-${randomUUID()}`;
  const ws = await connectGatewaySocketWithRetry(10_000, 2, {
    scopes: ['operator.read', 'operator.write'],
    caps: ['tool-events'],
  });

  try {
    return await new Promise<OpenClawTurnResult>((resolve, reject) => {
      let activeRunId: string | null = null;
      const timer = setTimeout(() => {
        cleanup();
        ws.close();
        reject(new Error('OpenClaw verbose run timed out before a final response arrived.'));
      }, 600_000);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
      };

      const fail = (error: Error) => {
        cleanup();
        ws.close();
        reject(error);
      };

      const onError = () => {
        fail(new Error('The OpenClaw verbose WebSocket disconnected during the chat run.'));
      };

      const onClose = (code: number, reason: Buffer) => {
        fail(new Error(`OpenClaw verbose WebSocket closed (${code}): ${reason.toString() || 'no reason'}`));
      };

      const onMessage = (rawData: Buffer) => {
        let frame: GatewayResponseFrame | GatewayEventFrame;
        try {
          frame = JSON.parse(rawData.toString()) as GatewayResponseFrame | GatewayEventFrame;
        } catch {
          return;
        }

        if (frame.type === 'event' && 'event' in frame && frame.event === 'agent') {
          const payload = frame.payload as OpenClawVerboseEvent | undefined;
          if (
            payload &&
            payload.sessionKey === session.sessionKey &&
            (!activeRunId || payload.runId === activeRunId) &&
            options.onVerboseEvent
          ) {
            void Promise.resolve(options.onVerboseEvent(payload)).catch(() => {});
          }
          return;
        }

        if (frame.type === 'event' && 'event' in frame && frame.event === 'chat') {
          const payload = frame.payload as OpenClawChatEvent | undefined;
          if (!payload || payload.sessionKey !== session.sessionKey) return;
          if (activeRunId && payload.runId !== activeRunId) return;

          if (payload.state === 'error') {
            fail(new Error(payload.errorMessage?.trim() || 'OpenClaw chat run failed.'));
            return;
          }

          if (payload.state !== 'final') {
            return;
          }

          const reply = extractChatMessageText(payload.message);
          if (!reply) {
            fail(new Error('OpenClaw returned no usable final chat reply.'));
            return;
          }

          cleanup();
          ws.close();
          resolve({
            reply,
            sessionKey: payload.sessionKey ?? session.sessionKey,
            sessionId: session.sessionId ?? null,
          });
          return;
        }

        if (frame.type !== 'res' || !('id' in frame) || frame.id !== requestId) {
          return;
        }

        if (!frame.ok) {
          fail(new Error(frame.error?.message || 'OpenClaw chat.send request failed.'));
          return;
        }

        const payload = frame.payload as OpenClawChatSendResponse | undefined;
        if (payload?.runId) {
          activeRunId = payload.runId;
        }
        if (!activeRunId) {
          fail(new Error('OpenClaw did not return a chat run id for the verbose request.'));
          return;
        }
      };

      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.send(JSON.stringify({
        type: 'req',
        id: requestId,
        method: 'chat.send',
        params: {
          sessionKey: session.sessionKey,
          message,
          deliver: false,
          idempotencyKey: runId,
        },
      }));
    });
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}
