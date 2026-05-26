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
  const key = process.env.HERMES_API_KEY?.trim();
  if (!key) {
    throw new Error('HERMES_API_KEY is required when HERMES_TRANSPORT=api.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getHermesTimeoutMs());
  let response: Response;
  try {
    response = await fetch(`${getHermesApiBase()}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
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

export async function askHermes(transcript: string, session: HermesSessionRef): Promise<HermesTurnResult> {
  const message = transcript.trim();
  if (!message) {
    return {
      reply: 'I could not understand anything yet. Please try again.',
      sessionKey: session.sessionKey,
      responseId: session.responseId ?? null,
    };
  }

  const raw = getHermesTransport() === 'api'
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
  const key = process.env.HERMES_API_KEY?.trim();
  if (!key) return { ok: false, detail: 'HERMES_API_KEY is not set' };

  try {
    const response = await fetch(`${getHermesApiBase().replace(/\/v1$/, '')}/health`, {
      headers: { Authorization: `Bearer ${key}` },
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
