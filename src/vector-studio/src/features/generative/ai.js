/**
 * Access to Puter AI for the generative features.
 *
 * aiClient(app) is { txt2img(prompt, options), chat(prompt, image?) }: the
 * client set on app.generativeAI (tests and embedders inject one there),
 * else the Puter SDK's puter.ai reached through app.puter. aiStatus(app)
 * says whether generative features can run now (online, Puter present,
 * signed in) and requireAI(app) asks the user to sign in when needed.
 *
 * Every request can be cancelled with an AbortSignal: the SDK calls cannot
 * be stopped, so their answer is ignored instead.
 */
import { UserError } from '../../lib/errors.js';

export class AIError extends UserError {
  constructor(message, reason = 'error') {
    super(message);
    this.reason = reason;
  }
}

/** Whether generative features can run: { ok } or { ok: false, reason, message }. */
export function aiStatus(app) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline', message: 'You are offline. Generative features need an internet connection.' };
  }
  if (app.generativeAI) return { ok: true };
  const ai = app.puter?.ai;
  if (!ai || typeof ai.chat !== 'function') {
    return { ok: false, reason: 'unavailable', message: 'Generative features run on Puter AI. Open Vector Studio from Puter to use them.' };
  }
  if (!app.user) return { ok: false, reason: 'signedOut', message: 'Sign in to Puter to use generative features.' };
  return { ok: true };
}

/** The AI client: { txt2img, chat }. */
export function aiClient(app) {
  if (app.generativeAI) return app.generativeAI;
  const ai = app.puter?.ai;
  if (!ai) return null;
  return {
    txt2img: (prompt, options) => ai.txt2img(prompt, options),
    chat: (prompt, image) => (image ? ai.chat(prompt, image) : ai.chat(prompt)),
  };
}

/**
 * The client when generative features can run. Signed out, offers to sign
 * in first (resolving to the client afterwards, or null when declined);
 * otherwise throws an AIError with a readable message.
 */
export async function requireAI(app, { ask = true } = {}) {
  let st = aiStatus(app);
  if (!st.ok && st.reason === 'signedOut' && ask && app.onSignIn) {
    const go = await app.dialogs.confirm({ title: 'Sign In to Generate', message: 'Generative features use Puter AI with your Puter account. Sign in to continue.', okLabel: 'Sign In' });
    if (go) {
      await app.onSignIn();
      st = aiStatus(app);
    } else return null;
  }
  if (!st.ok) throw new AIError(st.message, st.reason);
  return aiClient(app);
}

export function abortError(message = 'Cancelled.') {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export function isAbort(err) {
  return err?.name === 'AbortError';
}

/** Settle with `promise`, or reject with an AbortError as soon as `signal` aborts. */
export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** A readable message for a failed AI request. */
export function aiErrorMessage(err, fallback = 'The request did not go through. Try again.') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err instanceof AIError) return err.message;
  const code = String(err.code || err.error?.code || '');
  if (code === 'moderation_flagged' || /moderat|content policy|safety/i.test(err.message || '')) return 'The request was declined by the content filter. Try a different description.';
  if (code === 'insufficient_funds') return 'Your Puter AI balance is too low for this request.';
  if (code === 'network_error' || code === 'request_timeout' || err instanceof TypeError) return 'Puter AI could not be reached. Check your connection and try again.';
  if (code === 'unauthorized' || code === 'token_auth_failed') return 'Your Puter session expired. Sign in again and retry.';
  return err.error?.message || err.message || (typeof err.error === 'string' ? err.error : '') || fallback;
}

/** The text of a chat answer (the SDK returns objects of a few shapes). */
export function chatText(reply) {
  if (typeof reply === 'string') return reply;
  const c = reply?.message?.content;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  if (typeof c === 'string') return c;
  if (typeof reply?.text === 'string') return reply.text;
  if (typeof reply?.toString === 'function' && reply.toString !== Object.prototype.toString) return String(reply);
  return '';
}

/** Parse the first JSON array or object in a chat answer. kind: 'array' | 'object'. */
export function parseJsonReply(reply, kind = 'array') {
  const text = chatText(reply).replace(/```(?:json)?/gi, '');
  const [open, close] = kind === 'object' ? ['{', '}'] : ['[', ']'];
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) throw new AIError('The answer came back in an unexpected form. Try again.');
  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AIError('The answer came back in an unexpected form. Try again.');
  }
  if (kind === 'array' ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIError('The answer came back in an unexpected form. Try again.');
  }
  return value;
}

/** Plain text from a chat answer: trimmed, without code fences or wrapping quotes. */
export function plainReply(reply) {
  let t = chatText(reply).trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (t.length > 1 && /^["“]/.test(t) && /["”]$/.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t;
}

/** Ask the chat model, honoring a cancel signal, with readable errors. */
export async function askChat(client, prompt, { signal, image } = {}) {
  try {
    return await abortable(Promise.resolve().then(() => client.chat(prompt, image)), signal);
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new AIError(aiErrorMessage(err));
  }
}
