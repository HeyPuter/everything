/**
 * One full request run: pre-request scripts, variable resolution, send,
 * post-response scripts and tests. Used by the Send button and the runner.
 *
 * ctx: {
 *   ws,                 Workspace (variables are read from and written back to it)
 *   environmentId,      active environment or null
 *   local,              Map of runtime variables (shared across a runner session)
 *   sandbox,            ScriptSandbox or null (scripts are skipped without one)
 *   sendOptions,        options for send(): { mode, relay, timeoutMs, ... }
 *   info,               { iteration, iterationCount } for scripts
 *   data,               runner data row (object) or null, readable like variables
 *   signal,             AbortSignal
 *   onLog(entry)        console sink
 *   onVariableChanges(changes)  called with each script's { environment, collection, globals } changes
 * }
 */
import { normalizeRequest, BODY_MODES } from './model.js';
import { createResolver } from './variables.js';
import { resolveRequest, scriptChain, signResolved, graphqlJson } from './prepare.js';
import { send, SendError, charsetOf } from './send.js';
import { decodeText } from './pretty.js';
import { hasScript } from './scripts/has-script.js';

/** Merges runner flow requests, keeping only what a script actually set. */
function mergeFlow(into, flow) {
  if (!flow) return into;
  const out = { ...(into || {}) };
  if (flow.next !== undefined) out.next = flow.next;
  if (flow.stop === true) out.stop = true;
  if (flow.skip === true) out.skip = true;
  return Object.keys(out).length ? out : into;
}

const enabledVars = (list) => {
  const out = {};
  for (const v of list || []) if (v.enabled !== false && v.key) out[v.key] = v.value ?? '';
  return out;
};

function diff(before, after) {
  const changes = {};
  for (const [k, v] of Object.entries(after || {})) if (before[k] !== v) changes[k] = v == null ? '' : String(v);
  for (const k of Object.keys(before)) if (!(k in (after || {}))) changes[k] = null;
  return changes;
}

export function scopesFor(ws, { environmentId, collection, local, data }) {
  const env = environmentId ? ws.getEnvironment(environmentId) : null;
  return [
    { name: 'local', vars: local || new Map() },
    data ? { name: 'data', vars: new Map(Object.entries(data).map(([k, v]) => [k, v == null ? '' : String(v)])) } : null,
    env ? { name: 'environment', vars: env.variables } : null,
    collection ? { name: 'collection', vars: collection.variables } : null,
    { name: 'globals', vars: ws.globals.variables },
  ];
}

async function runScripts(phase, { request, parents, collection, ctx, response, tests, logs }) {
  const chain = scriptChain(request, parents, phase).filter((s) => hasScript(s.code));
  if (!chain.length || !ctx.sandbox) return { request, flow: null };
  let current = request;
  let flow = null;
  for (const script of chain) {
    const env = ctx.environmentId ? ctx.ws.getEnvironment(ctx.environmentId) : null;
    const before = {
      environment: enabledVars(env?.variables),
      collection: enabledVars(ctx.ws.getCollection(collection?.id)?.variables),
      globals: enabledVars(ctx.ws.globals.variables),
      local: Object.fromEntries(ctx.local || []),
    };
    if (ctx.data) for (const [k, v] of Object.entries(ctx.data)) if (!(k in before.local)) before.local[k] = String(v ?? '');
    const result = await ctx.sandbox.run({
      phase,
      code: script.code,
      request: {
        method: current.method,
        url: current.url,
        headers: current.headers.map((h) => ({ key: h.key, value: h.value, enabled: h.enabled })),
        body: { mode: current.body.mode, raw: current.body.raw, rawType: current.body.rawType },
      },
      response,
      variables: before,
      info: {
        requestName: request.name,
        requestId: request.id,
        phase,
        source: script.source,
        iteration: ctx.info?.iteration ?? 0,
        iterationCount: ctx.info?.iterationCount ?? 1,
      },
    }, { signal: ctx.signal });
    for (const l of result.logs || []) {
      logs.push({ ...l, source: script.source });
      ctx.onLog?.({ kind: 'script', ...l, source: script.source, phase });
    }
    for (const t of result.tests || []) tests.push({ ...t, source: script.source });
    flow = mergeFlow(flow, result.flow);
    // Persist variable changes even when the script failed part way.
    if (result.variables) {
      const after = result.variables;
      const changes = {
        environment: diff(before.environment, after.environment),
        collection: diff(before.collection, after.collection),
        globals: diff(before.globals, after.globals),
      };
      ctx.onVariableChanges?.(changes);
      await ctx.ws.applyVariableChanges({ environmentId: ctx.environmentId, collectionId: collection?.id, changes });
      if (ctx.local) {
        ctx.local.clear();
        for (const [k, v] of Object.entries(after.local || {})) {
          // Data-file values were passed in for reading; keep them out unless a script changed them.
          if (ctx.data && k in ctx.data && String(ctx.data[k] ?? '') === String(v)) continue;
          ctx.local.set(k, String(v));
        }
      }
    }
    if (phase === 'pre' && result.request) current = applyScriptRequest(current, result.request);
    if (!result.ok) {
      const err = new Error(`${phase === 'pre' ? 'Pre-request' : 'Post-response'} script in "${script.source}" failed: ${result.error?.message || 'unknown error'}`);
      err.scriptError = true;
      err.phase = phase;
      err.flow = flow; // runner.stop() or runner.next() called before the error still count.
      throw err;
    }
  }
  return { request: current, flow };
}

function applyScriptRequest(request, changed) {
  const next = structuredClone(request);
  if (changed.method) next.method = String(changed.method).toUpperCase();
  if (changed.url != null) next.url = String(changed.url);
  if (Array.isArray(changed.headers)) {
    next.headers = changed.headers.map((h) => ({ id: h.id || crypto.randomUUID(), key: String(h.key), value: String(h.value ?? ''), enabled: h.enabled !== false, description: '' }));
  }
  if (changed.body) {
    // Setting request.body.raw on a request without a body switches it to raw, as the script API promises.
    if (BODY_MODES.includes(changed.body.mode)) next.body.mode = changed.body.mode;
    if (typeof changed.body.raw === 'string' && next.body.mode === 'raw') next.body.raw = changed.body.raw;
  }
  return normalizeRequest(next);
}

/**
 * Turns a script's send() request ({ method, url, headers, body: { mode, raw,
 * urlencoded, formdata, graphql } }) into a resolved request the transports accept.
 */
export function resolveScriptRequest(req) {
  const method = (req.method || 'GET').toUpperCase();
  const pairs = (list) => (Array.isArray(list) ? list : []).filter((p) => p && p.key && p.disabled !== true && p.enabled !== false).map((p) => ({ key: String(p.key), value: String(p.value ?? '') }));
  const b = req.body;
  let body = null;
  if (typeof b === 'string') body = b ? { mode: 'raw', text: b } : null;
  else if (b && b.mode === 'urlencoded') body = { mode: 'urlencoded', fields: pairs(b.urlencoded) };
  else if (b && (b.mode === 'formdata' || b.mode === 'form')) body = { mode: 'form', fields: pairs(b.formdata || b.form).map((f) => ({ ...f, kind: 'text' })) };
  else if (b && b.mode === 'graphql') {
    const g = b.graphql || {};
    const variables = typeof g.variables === 'string' ? g.variables : g.variables == null ? '' : JSON.stringify(g.variables);
    body = { mode: 'raw', text: graphqlJson({ query: String(g.query ?? ''), variables }), contentType: 'application/json' };
  } else if (b && (b.mode === 'file' || b.mode === 'binary')) throw new Error('send() cannot send a file body from a script. Use a raw, urlencoded, form or GraphQL body.');
  else if (b && b.mode !== 'none' && b.raw) body = { mode: 'raw', text: String(b.raw) };
  // Browsers refuse a body on GET and HEAD.
  if (method === 'GET' || method === 'HEAD') body = null;
  const headers = (req.headers || []).filter((x) => Array.isArray(x) || x.enabled !== false).map((x) => (Array.isArray(x) ? { key: x[0], value: x[1] } : { key: x.key, value: x.value }));
  if (body?.contentType && !headers.some((h) => String(h.key).toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: body.contentType });
  return { method, url: req.url, headers, body };
}

/**
 * Returns {
 *   request (after pre-request scripts), resolved, response, tests, logs, warnings,
 *   error: null | { message, hint, code, phase, transport }, flow
 * }
 * response: { status, statusText, headers, body (Uint8Array), size, timings, transport, url, redirects, timeMs }
 */
export async function execute(request, parents, ctx) {
  const collection = parents[0]?.type === 'collection' ? parents[0] : null;
  const tests = [];
  const logs = [];
  const out = { request, resolved: null, response: null, tests, logs, warnings: [], error: null, flow: null };
  let req = normalizeRequest(structuredClone(request));
  try {
    const pre = await runScripts('pre', { request: req, parents, collection, ctx, tests, logs });
    req = pre.request;
    out.request = req;
    out.flow = mergeFlow(out.flow, pre.flow);
    if (pre.flow?.skip) return out;
  } catch (err) {
    // A script stopped by Cancel reads like a cancelled request.
    out.error = { message: err.message, code: ctx.signal?.aborted ? 'aborted' : 'script', phase: 'pre' };
    out.flow = mergeFlow(out.flow, err.flow);
    return out;
  }

  const resolver = createResolver(scopesFor(ctx.ws, { environmentId: ctx.environmentId, collection: ctx.ws.getCollection(collection?.id) || collection, local: ctx.local, data: ctx.data }));
  const { resolved, warnings } = resolveRequest(req, { parents, resolver });
  out.resolved = resolved;
  out.warnings.push(...warnings);
  if (!resolved.url) {
    out.error = { message: 'Enter a URL to send the request.', code: 'bad-url' };
    return out;
  }

  const files = await ctx.ws.filesFor(req);
  const started = performance.now();
  try {
    const signed = await signResolved(resolved, files);
    out.resolved = signed;
    const res = await send(signed, { ...ctx.sendOptions, files, signal: ctx.signal, timeoutMs: req.settings.timeoutMs || ctx.sendOptions?.timeoutMs || 0, followRedirects: req.settings.followRedirects && ctx.sendOptions?.followRedirects !== false, mode: req.settings.transport === 'auto' ? ctx.sendOptions?.mode || 'auto' : req.settings.transport });
    out.response = { ...res, timeMs: res.timings?.total ?? performance.now() - started };
    out.warnings.push(...(res.warnings || []));
  } catch (err) {
    // Transports report network failures as SendErrors; anything else, such as missing AWS keys while signing, happened before sending.
    const e = err instanceof SendError ? err : new SendError(err?.message || String(err), { code: 'prepare', transport: null });
    out.error = { message: e.message, hint: e.hint, code: e.code, transport: e.transport };
    ctx.onLog?.({ kind: 'request', level: 'error', method: resolved.method, url: resolved.url, error: e.message, at: Date.now() });
    return out;
  }
  ctx.onLog?.({
    kind: 'request',
    level: out.response.status >= 400 ? 'warn' : 'info',
    method: resolved.method,
    url: resolved.url,
    status: out.response.status,
    timeMs: out.response.timeMs,
    size: out.response.size?.body,
    transport: out.response.transport,
    requestHeaders: out.response.sentHeaders || resolved.headers.map((h) => [h.key, h.value]),
    responseHeaders: out.response.headers,
    at: Date.now(),
  });

  try {
    const r = out.response;
    const post = await runScripts('post', {
      request: req,
      parents,
      collection,
      ctx,
      tests,
      logs,
      response: {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
        bodyText: r.body.length > 20 * 1048576 ? '' : decodeText(r.body, charsetOf(r.headers)),
        timeMs: r.timeMs,
        sizeBytes: r.size?.body ?? r.body.length,
      },
    });
    out.flow = mergeFlow(out.flow, post.flow);
  } catch (err) {
    out.error = { message: err.message, code: ctx.signal?.aborted ? 'aborted' : 'script', phase: 'post' };
    out.flow = mergeFlow(out.flow, err.flow);
  }
  return out;
}
