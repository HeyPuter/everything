import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CopilotClient } from '@github/copilot-sdk';

const HOST = '127.0.0.1';
const PORT = Number(process.env.COPILOT_BRIDGE_PORT || 4174);
const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), '.copilot');
const MAX_BODY = 32 * 1024 * 1024;
const pendingTools = new Map();
const client = new CopilotClient({
  mode: 'empty',
  baseDirectory: COPILOT_HOME,
  logLevel: 'error',
  env: { ...process.env, COPILOT_GITHUB_TELEMETRY_DISABLED: 'true' },
});
let startupError = '';

function loopback(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function allowedOrigin(value) {
  if (typeof value !== 'string') return false;
  if (process.env.COPILOT_BRIDGE_ORIGINS) return process.env.COPILOT_BRIDGE_ORIGINS.split(',').map((x) => x.trim()).includes(value);
  try {
    const origin = new URL(value);
    return ['http:', 'https:'].includes(origin.protocol) && loopback(origin.hostname) && ['5173', '4173'].includes(origin.port || (origin.protocol === 'https:' ? '443' : '80'));
  } catch {
    return false;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!allowedOrigin(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  return true;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request exceeds the 32 MB limit.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

function sse(res, event, data) {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chatPayload(body) {
  if (!Array.isArray(body.messages) || body.messages.length > 256) throw Object.assign(new Error('Invalid chat messages.'), { status: 400 });
  if (!Array.isArray(body.tools) || body.tools.length > 64) throw Object.assign(new Error('Invalid tool definitions.'), { status: 400 });
  const system = body.messages.find((m) => m?.role === 'system')?.content;
  if (typeof system !== 'string') throw Object.assign(new Error('The assistant system prompt is missing.'), { status: 400 });

  const attachments = [];
  const lines = [];
  let attachmentIndex = 0;
  for (const message of body.messages.filter((m) => m?.role !== 'system')) {
    const role = String(message.role).toUpperCase();
    const content = message.content;
    const text = [];
    if (typeof content === 'string') text.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
        else if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string' && typeof part.source.media_type === 'string') {
          attachmentIndex++;
          attachments.push({ type: 'blob', data: part.source.data, mimeType: part.source.media_type, displayName: `image-${attachmentIndex}` });
          text.push(`[Image attachment ${attachmentIndex}]`);
        } else if (part?.type === 'document' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
          attachmentIndex++;
          attachments.push({ type: 'blob', data: part.source.data, mimeType: 'application/pdf', displayName: `document-${attachmentIndex}.pdf` });
          text.push(`[PDF attachment ${attachmentIndex}]`);
        }
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) text.push(`Requested tool ${call.function?.name}: ${call.function?.arguments}`);
    }
    if (message.role === 'tool') text.unshift(`Result for tool call ${message.tool_call_id}:`);
    if (text.length) lines.push(`${role}:\n${text.join('\n')}`);
  }

  const tools = body.tools.map((tool) => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || typeof fn?.name !== 'string' || !/^[\w.-]{1,80}$/.test(fn.name) || typeof fn.description !== 'string' || !fn.parameters || typeof fn.parameters !== 'object') {
      throw Object.assign(new Error('A tool definition is invalid.'), { status: 400 });
    }
    return { name: fn.name, description: fn.description, parameters: fn.parameters };
  });
  return {
    system,
    prompt: lines.join('\n\n') || '(No conversation messages.)',
    attachments,
    tools,
    model: typeof body.model === 'string' && body.model ? body.model : 'auto',
  };
}

async function handleChat(req, res) {
  const body = await readJson(req);
  const input = chatPayload(body);
  if (startupError) throw Object.assign(new Error(`Copilot runtime could not start: ${startupError}`), { status: 503 });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let session;
  let closed = false;
  let streamedText = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      if (session) void session.abort().catch(() => {});
    }
  });

  try {
    const names = input.tools.map((tool) => `custom:${tool.name}`);
    session = await client.createSession({
      model: input.model,
      streaming: true,
      systemMessage: { mode: 'append', content: input.system },
      tools: input.tools,
      availableTools: names,
      enableSessionTelemetry: false,
    });
    session.on('assistant.message_delta', (event) => {
      if (!event.agentId && typeof event.data.deltaContent === 'string' && event.data.deltaContent) {
        streamedText = true;
        sse(res, 'text', { text: event.data.deltaContent });
      }
    });
    session.on('external_tool.requested', (event) => {
      const data = event.data;
      pendingTools.set(data.requestId, session);
      sse(res, 'tool', data);
    });

    const response = await session.sendAndWait({ prompt: input.prompt, attachments: input.attachments }, 180000);
    if (!streamedText && response?.data.content) sse(res, 'text', { text: response.data.content });
    if (!closed) sse(res, 'done', {});
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!closed) {
      sse(res, 'error', { message: error instanceof Error ? error.message : String(error) });
      res.end();
    }
  } finally {
    for (const [requestId, owner] of pendingTools) if (owner === session) pendingTools.delete(requestId);
    if (session) await session.disconnect().catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  let hostname = '';
  try {
    hostname = new URL(`http://${req.headers.host}`).hostname;
  } catch {
    sendJson(res, 400, { error: 'Invalid host header.' });
    return;
  }
  if (!loopback(hostname)) {
    sendJson(res, 403, { error: 'The Copilot bridge is local-only.' });
    return;
  }
  if (!setCors(req, res)) {
    sendJson(res, 403, { error: 'This browser origin is not allowed to use the local Copilot bridge.' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = new URL(req.url || '/', 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/health') {
    if (startupError) {
      sendJson(res, 503, { available: false, authenticated: false });
      return;
    }
    try {
      const auth = await client.getAuthStatus();
      sendJson(res, 200, { available: true, authenticated: auth.isAuthenticated === true });
    } catch {
      sendJson(res, 503, { available: false, authenticated: false });
    }
    return;
  }
  if (req.method === 'POST' && path === '/chat') {
    try {
      await handleChat(req, res);
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || 'The Copilot bridge failed.' });
    }
    return;
  }
  if (req.method === 'POST' && path === '/tool-result') {
    try {
      const body = await readJson(req);
      const session = pendingTools.get(body.requestId);
      if (!session) {
        sendJson(res, 404, { error: 'This tool request is no longer pending.' });
        return;
      }
      const result = body.result || {};
      const image = typeof result.image === 'string' ? /^data:(image\/[^;,]+);base64,(.*)$/.exec(result.image) : null;
      const payload = {
        textResultForLlm: String(result.content || ''),
        resultType: result.ok === false ? 'failure' : 'success',
        ...(result.ok === false ? { error: String(result.content || 'Tool failed.') } : {}),
        ...(image ? { binaryResultsForLlm: [{ type: 'image', data: image[2], mimeType: image[1], description: 'Scene viewport screenshot' }] } : {}),
      };
      const handled = await session.rpc.tools.handlePendingToolCall({ requestId: body.requestId, result: payload });
      pendingTools.delete(body.requestId);
      if (!handled.success) {
        sendJson(res, 409, { error: 'Copilot no longer accepts this tool result.' });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message || 'Could not submit the tool result.' });
    }
    return;
  }
  sendJson(res, 404, { error: 'Not found.' });
});

try {
  await client.start();
} catch (error) {
  startupError = error instanceof Error ? error.message : String(error);
  console.error(`Copilot bridge runtime failed to start: ${startupError}`);
}
server.listen(PORT, HOST, () => {
  console.log(`Local Copilot bridge listening on http://${HOST}:${PORT}`);
  if (!startupError) {
    void client.getAuthStatus().then((auth) => {
      console.log(auth.isAuthenticated ? 'Copilot CLI authentication is ready.' : 'Sign in with `copilot auth login` before using the assistant.');
    }).catch(() => console.log('Copilot CLI authentication status is unavailable.'));
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    void client.stop().finally(() => process.exit(0));
  });
}
