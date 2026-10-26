import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

let bundledClient;
export function bridgeBrowserSource() {
  bundledClient ??= build({ configFile: false, publicDir: false, logLevel: 'silent', build: { write: false, target: 'es2022', minify: false, lib: { entry: fileURLToPath(new URL('./bridge-browser-entry.js', import.meta.url)), formats: ['iife'], name: 'tripsFakeBridge' } } }).then(result => (Array.isArray(result) ? result[0] : result).output.find(output => output.type === 'chunk').code);
  return bundledClient;
}

/** Bindings are scoped by Playwright context and main frame, not wire identity. */
export async function attachFakePuterContext(host, context, { as, region = 0, appUid, maxBytes, source } = {}) {
  const binding = '__tripsFakeRpc_' + randomUUID().replaceAll('-', '');
  const delivery = '__tripsFakeDelivery_' + randomUUID().replaceAll('-', '');
  const bound = host.openContext({ as, region, appUid });
  const pages = new Map(); let closed = false;
  const pageEndpoint = page => {
    if (pages.has(page)) return pages.get(page);
    const endpoint = bound.connect(message => page.evaluate(({ delivery, message }) => globalThis[delivery]?.(message), { delivery, message }));
    pages.set(page, endpoint);
    page.on('close', () => { pages.delete(page); endpoint.close().catch(() => {}); });
    // A hash change keeps the document (and its bridge session); a reload or a new URL replaces it.
    let url = page.url();
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      const previous = url; url = frame.url();
      if (previous !== url && previous.split('#')[0] === url.split('#')[0]) return;
      endpoint.navigate().catch(() => {});
    });
    return endpoint;
  };
  await context.exposeBinding(binding, async (source, envelope) => {
    if (closed || source.context !== context || source.frame !== source.page.mainFrame()) return { ok: false, error: { code: 'bridge_context_denied', message: 'bridge_context_denied', status: 403 } };
    return pageEndpoint(source.page).request(envelope);
  });
  const clientSource = source ?? await bridgeBrowserSource();
  await context.addInitScript({ content: `globalThis.__tripsFakeBridgeOptions=${JSON.stringify({ binding, delivery, maxBytes })};\n${clientSource}` });
  const close = async () => { if (closed) return; closed = true; for (const endpoint of pages.values()) await endpoint.close(); pages.clear(); await bound.close(); };
  context.on('close', () => { close().catch(() => {}); });
  return { binding, delivery, close, pages: () => pages.size };
}
