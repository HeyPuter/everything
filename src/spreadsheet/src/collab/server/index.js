/**
 * Entry point of the room worker bundle (npm run build:worker). Puter Workers provide `router` and `me`;
 * `user` on a request is the caller's Puter.
 */
/* global router, me, __WORKER_BUILD__ */
import { RoomService } from './service.js';
import { authenticate } from './auth.js';
import { PROTOCOL } from '../protocol.js';

async function readBody(request, limit = 40_000_000) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error('Request too large.'), { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { body.set(c, at); at += c.length; }
  return new TextDecoder().decode(body);
}

router.get('/health', () => Response.json({ ok: true, protocol: PROTOCOL, build: __WORKER_BUILD__ }));
router.post('/api', async ({ request, user }) => {
  try {
    if (!user?.puter) return Response.json({ message: 'Sign in with Puter to continue.' }, { status: 401 });
    const text = await readBody(request);
    if (text === null) return Response.json({ message: 'A JSON request body is required.' }, { status: 400 });
    const input = JSON.parse(text);
    const identity = await authenticate(request, user.puter, input);
    return Response.json(await new RoomService(me.puter).call(identity, input));
  } catch (error) {
    return Response.json(
      { message: error instanceof SyntaxError ? 'Invalid JSON request.' : error.status ? error.message : 'The shared workbook could not synchronize. Please retry.' },
      { status: error.status || (error instanceof SyntaxError ? 400 : 500) },
    );
  }
});
