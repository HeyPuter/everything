/**
 * HTTP handling for the review worker, kept apart from the runtime globals
 * (router, me) so tests and the development harness run the same code.
 */
import { PROTOCOL, COMMENT_DELIVERY_PENDING } from '../src/review/protocol.js';
import { authenticate } from './auth.js';
import { ReviewService } from './service.js';

/** Largest request body: comments are small, so anything bigger is refused. */
export const MAX_BODY = 64 * 1024;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function readBody(request, limit = MAX_BODY) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('Request too large.'), { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(body);
}

export function health(build, builtAt) {
  return json({ ok: true, app: 'video-studio-review', protocol: PROTOCOL, build, builtAt });
}

const services = new WeakMap();
function serviceFor(mePuter) {
  let s = services.get(mePuter);
  if (!s) {
    s = new ReviewService(mePuter);
    services.set(mePuter, s);
  }
  return s;
}

/** POST /api: authenticate the caller, then run one operation. */
export async function handleApi({ request, user }, mePuter, { service } = {}) {
  try {
    const text = await readBody(request);
    if (text === null) return json({ message: 'A JSON request body is required.' }, 400);
    const identity = await authenticate(request, user?.puter, text);
    const input = JSON.parse(text);
    return json(await (service || serviceFor(mePuter)).call(identity, input));
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error.status || 500;
    const message = error instanceof SyntaxError ? 'Invalid request.' : error.status ? error.message : 'The review server had a problem. Try again.';
    return json({ message, ...(error.code === COMMENT_DELIVERY_PENDING ? { code: error.code } : {}) }, status);
  }
}
