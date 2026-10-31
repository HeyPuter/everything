import { expect } from '@playwright/test';

const LOCAL = new Set(['127.0.0.1', 'localhost']);
const WORKER = /\.puter\.work$/;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'if-none-match', 'access-control-expose-headers': 'etag, retry-after' };

/**
 * A signed-out visitor: the production entry (`index.html`, whose SDK script is blocked, so `puter` is undefined) in its
 * own context. Requests to `*.puter.work` are answered by `world`'s workers with no credentials, the way a deployed
 * worker answers a plain fetch. `served` records every worker response (`{url, status, type, body}`).
 */
export async function signedOutViewer(browser, testInfo, baseURL, world, hash) {
  const { colorScheme, viewport, isMobile, hasTouch } = testInfo.project.use;
  const context = await browser.newContext({ colorScheme, viewport, isMobile, hasTouch });
  // The fake runtime bills every call to someone; the worker still sees an anonymous request.
  const visitor = world.client({ uuid: 'public-visitor', username: 'public-visitor' });
  const served = [];
  const errors = [];
  await context.route((url) => !LOCAL.has(url.hostname), async (route) => {
    const request = route.request();
    if (!WORKER.test(new URL(request.url()).hostname)) { await route.abort('blockedbyclient'); return; }
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }
    const headers = { 'x-puter-no-auth': '1' };
    const tag = request.headers()['if-none-match'];
    if (tag) headers['if-none-match'] = tag;
    const response = await visitor.workers.exec(request.url(), { method: request.method(), headers });
    const body = Buffer.from(await response.arrayBuffer());
    served.push({ url: request.url(), status: response.status, type: response.headers.get('content-type') ?? '', body });
    await route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), ...CORS }, body: [204, 304].includes(response.status) ? undefined : body });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseURL}/index.html${hash}`);
  await expect(page.locator('.public-view')).toBeVisible();
  return { context, page, served, errors, json: () => served.filter((item) => item.type.includes('json')).map((item) => JSON.parse(item.body.toString('utf8'))) };
}

/** The `#/s/…` hash of a public link URL shown in the app. */
export const publicHash = (url) => new URL(url).hash;
