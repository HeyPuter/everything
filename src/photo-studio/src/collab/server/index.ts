// Entry point of the room worker bundle (npm run build:worker). Puter Workers
// provide `router` and `me`; `user` on a request is the caller's Puter.
import { RoomService } from './service';
import { authenticate } from './auth';

declare const router: {
  get(path: string, handler: (ctx: { request: Request }) => Response | Promise<Response>): void;
  post(path: string, handler: (ctx: { request: Request; user?: { puter?: unknown } }) => Response | Promise<Response>): void;
};
declare const me: { puter: ConstructorParameters<typeof RoomService>[0] };
declare const __WORKER_BUILD__: string;

async function readBody(request: Request, limit = 17_000_000) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
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
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(body);
}

router.get('/health', () => Response.json({ ok: true, protocol: 1, build: __WORKER_BUILD__ }));
router.post('/api', async ({ request, user }) => {
  try {
    if (!user?.puter) return Response.json({ message: 'Sign in with Puter to continue.' }, { status: 401 });
    const text = await readBody(request);
    if (text === null) return Response.json({ message: 'A JSON request body is required.' }, { status: 400 });
    const input = JSON.parse(text);
    const identity = await authenticate(request, user.puter as Parameters<typeof authenticate>[1], input);
    return Response.json(await new RoomService(me.puter).call(identity, input));
  } catch (error) {
    const e = error as Error & { status?: number };
    return Response.json(
      { message: error instanceof SyntaxError ? 'Invalid JSON request.' : e.status ? e.message : 'The shared document could not synchronize. Please retry.' },
      { status: e.status || (error instanceof SyntaxError ? 400 : 500) },
    );
  }
});
