// Dev harness for email in mock.html: the app's real email worker (src/workers/email-worker.js) runs inside the
// page, reached through puter.workers.exec as in Puter, with the page's own origin allowed for links. Nothing
// leaves the page: each message the worker would send is kept in window.__mailbox (and this tab's
// sessionStorage) and logged. An address at bounce.test fails delivery; one at optout.test has opted out.
import WORKER_SOURCE from '/src/workers/email-worker.js?raw';
import { EMAIL_WORKER_URL } from '/src/lib/mail.js';

const puter = window.puter;
if (puter) {
  const STORE = 'spreadsheet-mock-outbox';
  const mailbox = (() => { try { return JSON.parse(sessionStorage.getItem(STORE)) || []; } catch { return []; } })();
  window.__mailbox = mailbox;
  const data = new Map();
  const kv = {
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async set(k, v) { data.set(k, v); return true; },
    async incr(k, n = 1) { const v = (Number(data.get(k)) || 0) + n; data.set(k, v); return v; },
    async expire() { return true; },
  };
  const deliver = (via) => async (message) => {
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250)); // a mail service's latency
    const to = String(message.to);
    if (to.endsWith('@bounce.test')) return { failed: [to], suppressed: [] };
    if (to.endsWith('@optout.test')) return { failed: [], suppressed: [to] };
    const kept = {
      at: new Date().toISOString(), via, to, subject: message.subject, text: message.text, replyTo: message.replyTo || null,
      attachments: (message.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, bytes: Math.floor(a.content.length * 3 / 4) })),
    };
    mailbox.push(kept);
    try { sessionStorage.setItem(STORE, JSON.stringify(mailbox.slice(-50))); } catch { /* kept in memory */ }
    console.log(`[email-mock] to ${to}: ${message.subject}`, kept);
    return { messageId: `mock-${mailbox.length}`, failed: [], suppressed: [] };
  };
  const me = { puter: { kv, authToken: 'mock-owner-token', email: { sendTransactional: deliver('owner') } } };
  const routes = [];
  const router = { get: (p, h) => routes.push(['GET', p, h]), post: (p, h) => routes.push(['POST', p, h]) };
  const source = WORKER_SOURCE.replace('const DEV_ORIGINS = [];', `const DEV_ORIGINS = [${JSON.stringify(location.origin)}];`);
  new Function('router', 'me', `'use strict';\n${source}`)(router, me);

  const caller = () => ({ puter: { authToken: 'mock-caller-token', email: { sendTransactional: deliver('caller') }, auth: { getUser: () => puter.auth.getUser() } } });
  puter.workers ??= {};
  const previous = puter.workers.exec?.bind(puter.workers);
  puter.workers.exec = async (url, options = {}) => {
    if (!String(url).startsWith(EMAIL_WORKER_URL)) return previous ? previous(url, options) : new Response('no worker', { status: 502 });
    const path = new URL(url).pathname;
    const route = routes.find(([m, p]) => m === (options.method || 'GET') && p === path);
    if (!route) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const request = new Request(url, { method: options.method || 'GET', headers: options.headers, body: options.body });
    const signedIn = puter.auth.isSignedIn();
    return route[2]({ request, me, ...(signedIn ? { user: caller() } : {}) });
  };
}
