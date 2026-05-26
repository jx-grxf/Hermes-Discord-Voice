import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export type HermesSessionRef = {
  sessionKey: string;
  responseId?: string | null;
};

export type HermesBootstrapResult = {
  sessionKey: string;
  responseId: string | null;
};

export type HermesTurnResult = {
  reply: string;
  sessionKey: string;
  responseId: string | null;
};

export type HermesStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_started'; name: string; arguments: string; callId: string | null }
  | { type: 'tool_completed'; name: string | null; output: string; callId: string | null }
  | { type: 'response_completed'; responseId: string | null; text: string | null }
  | { type: 'notice'; message: string };

export type HermesAskOptions = {
  onEvent?: (event: HermesStreamEvent) => void | Promise<void>;
};

type HermesRawResult = {
  body: string;
  responseId: string | null;
};

type HermesResponseApiPayload = {
  id?: string;
  response_id?: string;
  output_text?: string;
  outputText?: string;
  text?: string;
  content?: string;
  message?: {
    content?: unknown;
  };
  choices?: Array<{
    message?: {
      content?: unknown;
    };
    text?: string;
  }>;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function getHermesCli(): string {
  return process.env.HERMES_CLI?.trim() || 'hermes';
}

function getHermesTransport(): 'api' | 'cli' {
  const configured = process.env.HERMES_TRANSPORT?.trim().toLowerCase();
  if (configured === 'api') return 'api';
  if (configured === 'cli') return 'cli';
  return process.env.HERMES_API_KEY?.trim() ? 'api' : 'cli';
}

function getHermesTimeoutMs(): number {
  const raw = Number(process.env.HERMES_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw >= 10_000 ? Math.floor(raw) : 600_000;
}

function getHermesApiBase(): string {
  return (process.env.HERMES_API_BASE_URL?.trim() || 'http://127.0.0.1:8642/v1').replace(/\/+$/, '');
}

function getHermesModel(): string {
  return process.env.HERMES_MODEL?.trim() || 'hermes-agent';
}

function getHermesSource(): string {
  return process.env.HERMES_SOURCE?.trim() || 'discord-voice';
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function isHermesVerboseStreamingEnabled(): boolean {
  return isTruthy(process.env.HERMES_VERBOSE_STREAM);
}

function getHermesApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = process.env.HERMES_API_KEY?.trim();
  return {
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...extra,
  };
}

function commaList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseStructuredText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object') {
          const record = entry as { type?: unknown; text?: unknown };
          if ((record.type === 'text' || record.type === 'output_text') && typeof record.text === 'string') {
            return record.text.trim();
          }
        }
        return '';
      })
      .filter((entry) => entry.length > 0);
    return parts.join('\n\n') || null;
  }
  return null;
}

export function extractHermesReply(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let data: HermesResponseApiPayload;
  try {
    data = JSON.parse(trimmed) as HermesResponseApiPayload;
  } catch {
    return trimmed;
  }

  const outputText = data.output
    ?.flatMap((item) => item.content ?? [])
    .flatMap((item) => (typeof item.text === 'string' && item.text.trim() ? [item.text.trim()] : []))
    .join('\n\n')
    .trim();

  return firstNonEmpty([
    data.output_text,
    data.outputText,
    data.text,
    data.content,
    parseStructuredText(data.message?.content),
    parseStructuredText(data.choices?.[0]?.message?.content),
    data.choices?.[0]?.text,
    outputText,
  ]);
}

export function extractHermesResponseId(raw: string): string | null {
  try {
    const data = JSON.parse(raw.trim()) as HermesResponseApiPayload;
    return firstNonEmpty([data.id, data.response_id]);
  } catch {
    return null;
  }
}

export function extractHermesCliSessionId(raw: string): string | null {
  const match = raw.match(/(?:^|\n)\s*session_id:\s*([^\s]+)/i);
  return match?.[1]?.trim() || null;
}

export function stripHermesCliMetadata(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*session_id:\s*/i.test(line))
    .filter((line) => !/^\s*↻ Resumed session\s+/u.test(line))
    .join('\n')
    .trim();
}

export function buildHermesSessionKey(guildId: string, channelId: string): string {
  const prefix = process.env.HERMES_VOICE_SESSION_PREFIX?.trim() || 'hermes-discord-voice';
  return `${prefix}:guild:${guildId}:channel:${channelId}:join:${randomUUID()}`;
}

export function createHermesSession(sessionKey: string): HermesBootstrapResult {
  return {
    sessionKey: sessionKey.trim(),
    responseId: null,
  };
}

export function buildHermesCliArgs(message: string, session: HermesSessionRef): string[] {
  const args = ['chat', '-q', message, '-Q', '--source', getHermesSource()];
  const provider = process.env.HERMES_PROVIDER?.trim();
  const model = process.env.HERMES_MODEL?.trim();
  const toolsets = commaList(process.env.HERMES_TOOLSETS);
  const skills = commaList(process.env.HERMES_SKILLS);

  if (session.responseId) args.push('--resume', session.responseId);
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  if (toolsets.length > 0) args.push('--toolsets', toolsets.join(','));
  for (const skill of skills) args.push('--skills', skill);

  return args;
}

function runHermesCli(message: string, session: HermesSessionRef): Promise<HermesRawResult> {
  return new Promise<HermesRawResult>((resolve, reject) => {
    const proc = spawn(getHermesCli(), buildHermesCliArgs(message, session), {
      cwd: process.cwd(),
      env: process.env,
    });
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Hermes CLI timed out after ${getHermesTimeoutMs()}ms.`));
    }, getHermesTimeoutMs());

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start Hermes CLI: ${error.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Hermes CLI failed (exit ${code ?? 'unknown'}): ${(stderr || stdout).trim() || 'no additional details'}`));
        return;
      }
      resolve({
        body: stripHermesCliMetadata(stdout),
        responseId: extractHermesCliSessionId(`${stderr}\n${stdout}`) ?? session.responseId ?? null,
      });
    });
  });
}

async function callHermesResponsesApi(message: string, session: HermesSessionRef): Promise<HermesRawResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getHermesTimeoutMs());
  let response: Response;
  try {
    response = await fetch(`${getHermesApiBase()}/responses`, {
      method: 'POST',
      headers: {
        ...getHermesApiHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getHermesModel(),
        input: message,
        conversation: session.sessionKey,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Hermes API timed out after ${getHermesTimeoutMs()}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Hermes API failed with status ${response.status}: ${text || 'no response body'}`);
  }
  return {
    body: text,
    responseId: extractHermesResponseId(text) ?? session.responseId ?? null,
  };
}

type SseMessage = {
  event: string;
  data: string;
};

function parseSseMessages(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    const lines = part.split('\n');
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    if (dataLines.length > 0) {
      messages.push({ event, data: dataLines.join('\n') });
    }
  }

  return { messages, rest };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringifyCompact(value: unknown, maxLength = 900): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function extractCompletedResponseText(response: Record<string, unknown>): string | null {
  const output = response.output;
  if (!Array.isArray(output)) return null;

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) parts.push(text);
    }
  }

  return parts.join('\n\n').trim() || null;
}

async function emitHermesStreamEvent(
  callback: HermesAskOptions['onEvent'],
  event: HermesStreamEvent,
): Promise<void> {
  if (!callback) return;
  await callback(event);
}

async function handleResponsesSseMessage(
  message: SseMessage,
  options: {
    onEvent?: HermesAskOptions['onEvent'];
    textParts: string[];
    toolNames: Map<string, string>;
    completed: { responseId: string | null; text: string | null };
  },
): Promise<void> {
  const data = parseJsonObject(message.data);
  if (!data) return;

  if (message.event === 'response.output_text.delta') {
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (!delta) return;
    options.textParts.push(delta);
    await emitHermesStreamEvent(options.onEvent, { type: 'text_delta', text: delta });
    return;
  }

  if (message.event === 'response.output_item.added') {
    const item = data.item && typeof data.item === 'object' ? data.item as Record<string, unknown> : null;
    if (!item) return;

    if (item.type === 'function_call') {
      const name = typeof item.name === 'string' ? item.name : 'tool';
      const callId = typeof item.call_id === 'string' ? item.call_id : null;
      if (callId) options.toolNames.set(callId, name);
      await emitHermesStreamEvent(options.onEvent, {
        type: 'tool_started',
        name,
        arguments: stringifyCompact(item.arguments ?? ''),
        callId,
      });
      return;
    }

    if (item.type === 'function_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : null;
      await emitHermesStreamEvent(options.onEvent, {
        type: 'tool_completed',
        name: callId ? options.toolNames.get(callId) ?? null : null,
        output: stringifyCompact(item.output ?? ''),
        callId,
      });
    }
    return;
  }

  if (message.event === 'response.completed') {
    const response = data.response && typeof data.response === 'object' ? data.response as Record<string, unknown> : null;
    if (!response) return;
    options.completed.responseId = typeof response.id === 'string' ? response.id : null;
    options.completed.text = extractCompletedResponseText(response);
    await emitHermesStreamEvent(options.onEvent, {
      type: 'response_completed',
      responseId: options.completed.responseId,
      text: options.completed.text,
    });
  }
}

async function callHermesResponsesApiStream(
  message: string,
  session: HermesSessionRef,
  options: HermesAskOptions,
): Promise<HermesRawResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getHermesTimeoutMs());
  let response: Response;
  try {
    response = await fetch(`${getHermesApiBase()}/responses`, {
      method: 'POST',
      headers: {
        ...getHermesApiHeaders({ Accept: 'text/event-stream' }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getHermesModel(),
        input: message,
        conversation: session.sessionKey,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Hermes API stream timed out after ${getHermesTimeoutMs()}ms.`);
    }
    throw error;
  }

  try {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hermes API stream failed with status ${response.status}: ${text || 'no response body'}`);
    }
    if (!response.body) {
      throw new Error('Hermes API stream returned no response body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const textParts: string[] = [];
    const toolNames = new Map<string, string>();
    const completed = { responseId: null as string | null, text: null as string | null };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseMessages(buffer);
      buffer = parsed.rest;

      for (const sseMessage of parsed.messages) {
        await handleResponsesSseMessage(sseMessage, {
          onEvent: options.onEvent,
          textParts,
          toolNames,
          completed,
        });
      }
    }

    buffer += decoder.decode();
    const parsed = parseSseMessages(`${buffer}\n\n`);
    for (const sseMessage of parsed.messages) {
      await handleResponsesSseMessage(sseMessage, {
        onEvent: options.onEvent,
        textParts,
        toolNames,
        completed,
      });
    }

    const body = completed.text ?? textParts.join('').trim();
    return {
      body,
      responseId: completed.responseId ?? session.responseId ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function askHermes(
  transcript: string,
  session: HermesSessionRef,
  options: HermesAskOptions = {},
): Promise<HermesTurnResult> {
  const message = transcript.trim();
  if (!message) {
    return {
      reply: 'I could not understand anything yet. Please try again.',
      sessionKey: session.sessionKey,
      responseId: session.responseId ?? null,
    };
  }

  const raw = options.onEvent && isHermesVerboseStreamingEnabled()
    ? await callHermesResponsesApiStream(message, session, options)
    : getHermesTransport() === 'api'
      ? await callHermesResponsesApi(message, session)
      : await runHermesCli(message, session);
  const reply = extractHermesReply(raw.body);
  if (!reply) {
    throw new Error('Hermes returned no usable reply.');
  }

  return {
    reply,
    sessionKey: session.sessionKey,
    responseId: raw.responseId,
  };
}

export async function checkHermesApiHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(`${getHermesApiBase().replace(/\/v1$/, '')}/health`, {
      headers: getHermesApiHeaders(),
    });
    return {
      ok: response.ok,
      detail: response.ok ? 'healthy' : `status ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
