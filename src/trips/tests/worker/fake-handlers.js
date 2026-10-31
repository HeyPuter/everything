export function installHandlers({ router, me }) {
  router.get('/health', () => ({ ok: true }));
  router.get('/identity/:id', async ({ user, params }) => ({ caller: await user.puter.auth.getUser(), owner: await me.puter.auth.getUser(), param: params.id }));
  router.post('/write', async ({ request, user }) => {
    try {
      const caller = await user.puter.auth.getUser();
      const body = await request.json();
      await me.puter.kv.set('shared:last', { by: caller.uuid, body });
      return { ok: true };
    } catch (cause) { return Response.json({ code: cause.code }, { status: cause.status ?? 500 }); }
  });
  router.post('/proof', async ({ request, user }) => {
    try {
      const { path, signature, body } = await request.json();
      const file = await user.puter.fs.stat(path);
      const proof = JSON.parse(await (await user.puter.fs.read(file.uid)).text());
      const key = await crypto.subtle.importKey('jwk', proof.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from(signature), new TextEncoder().encode(JSON.stringify([new URL(request.url).origin, path, body])));
      if (!valid || file.is_shared !== false) return new Response(null, { status: 401 });
      await me.puter.kv.set('shared:proof', { by: file.owner.uuid, body });
      return { ok: true, caller: file.owner.uuid };
    } catch { return new Response(null, { status: 401 }); }
  });
  router.get('/defer', ({ event }) => { event.waitUntil(me.puter.kv.set('deferred', true)); return { ok: true }; });
  router.get('/throws', () => { throw new Error('handler error'); });
  router.custom('SEARCH')('/find/*rest', ({ params }) => params);
}
