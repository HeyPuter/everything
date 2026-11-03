export function install({ router, me }) {
  router.get('/identity', async ({ user }) => ({ caller: await user.puter.auth.getUser(), owner: await me.puter.auth.getUser() }));
  router.post('/edit', async ({ request, user }) => {
    const caller = await user.puter.auth.getUser();
    const body = await request.json();
    if (!['alice', 'bob'].includes(caller.uuid) || typeof body.title !== 'string' || body.title.length > 100) return new Response(null, { status: 403 });
    const record = await me.puter.kv.update('shared:record', { title: body.title, by: caller.uuid });
    return { ok: true, record };
  });
  router.post('/bytes', async ({ request, user }) => new Response(await request.arrayBuffer(), { status: 201, statusText: 'Created', headers: { 'Content-Type': 'application/octet-stream', 'X-Caller': (await user.puter.auth.getUser()).uuid } }));
  router.post('/proof', async ({ request, user }) => {
    try {
      const { path } = await request.json(); const file = await user.puter.fs.stat(path);
      return { owner: file.owner.uuid, content: await (await user.puter.fs.read(path)).text() };
    } catch (cause) { return Response.json({ code: cause.code }, { status: cause.status ?? 401 }); }
  });
  router.get('/empty', () => new Response(null, { status: 204 }));
  router.post('/slow', async ({ request, user }) => {
    const caller = await user.puter.auth.getUser();
    const value = await request.text(); await new Promise(resolve => setTimeout(resolve, 500));
    await me.puter.kv.set('shared:slow:' + value, caller.uuid);
    return new Response(value);
  });
}
