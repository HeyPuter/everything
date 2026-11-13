/**
 * Text to speech through Puter AI. The call returns an audio element; its
 * source is fetched into a Blob so the speech can be imported like any
 * other audio file and saved with the project.
 */
import { errorMessage } from './transcribe.js';

export const TTS_MAX = 3000;

export const TTS_VOICES = [
  { id: 'polly', label: 'Joanna', hint: 'Standard', options: { provider: 'aws-polly', voice: 'Joanna', engine: 'neural' } },
  ...['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map((v) => ({
    id: `openai-${v}`,
    label: v[0].toUpperCase() + v.slice(1),
    hint: 'Natural',
    options: { provider: 'openai', voice: v },
  })),
];

/** Puter AI is present and the user is signed in (the project lives in Puter). */
export function aiAvailable(ctx) {
  return typeof puter !== 'undefined' && Boolean(puter.ai) && ctx.library?.backend?.kind === 'puter';
}

const cache = new Map(); // `${voice}|${text}` -> Blob

function checkSpeech(signal) {
  if (signal?.aborted) throw new DOMException('Speech cancelled.', 'AbortError');
}

/** Speech for text as an audio Blob (cached per voice and text). */
export async function synthesize(text, voiceId, { testMode = false, signal } = {}) {
  checkSpeech(signal);
  const t = String(text || '').trim().slice(0, TTS_MAX);
  if (!t) throw new Error('Type some text first.');
  const voice = TTS_VOICES.find((v) => v.id === voiceId) || TTS_VOICES[0];
  const key = `${voice.id}|${testMode ? 'test|' : ''}${t}`;
  if (cache.has(key)) return cache.get(key);
  let audio;
  try {
    audio = await puter.ai.txt2speech(t, { ...voice.options, ...(testMode ? { test_mode: true } : {}) });
  } catch (err) {
    checkSpeech(signal);
    throw new Error(errorMessage(err, "Couldn't create the speech."));
  }
  checkSpeech(signal);
  const src = audio?.src || audio?.currentSrc;
  if (!src) throw new Error("Couldn't create the speech.");
  try {
    const res = await fetch(src, { signal });
    if (!res.ok) throw new Error("Couldn't download the speech.");
    const blob = await res.blob();
    checkSpeech(signal);
    if (!blob.size) throw new Error('The speech came back empty.');
    cache.set(key, blob);
    // Keep the cache small; it only spares repeat requests while editing.
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return blob;
  } catch (err) {
    checkSpeech(signal);
    throw err;
  }
}

const EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'weba', 'audio/mp4': 'm4a' };

/** A named File for speech audio, e.g. "Speech - Hello and welcome.mp3". */
export function speechFile(blob, text) {
  const type = (blob.type || 'audio/mpeg').split(';')[0];
  const words = String(text).replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().split(/\s+/).slice(0, 5).join(' ');
  const name = `Speech - ${words.slice(0, 40) || 'voice'}.${EXT[type] || 'mp3'}`;
  return new File([blob], name, { type: type || 'audio/mpeg' });
}

/** Import speech audio and put it on an audio track at start (default: playhead). */
export async function addSpeechToTimeline(ctx, blob, text, { start, signal } = {}) {
  checkSpeech(signal);
  const context = () => JSON.stringify([ctx.store.project.id, ctx.store.project.timelineId, ...(ctx.store.nest || []).map((f) => f.id)]);
  const source = context(), controller = new AbortController();
  let off;
  const cancel = () => {
    controller.abort();
    off?.();
    off = null;
  };
  off = ctx.store.on('change', () => { if (context() !== source) cancel(); });
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const [asset] = await ctx.actions.importFiles([speechFile(blob, text)], { signal: controller.signal });
    checkSpeech(controller.signal);
    if (!asset) return null;
    return ctx.actions.addAsset(asset, start !== undefined ? { start } : {});
  } finally {
    off?.();
    signal?.removeEventListener('abort', cancel);
  }
}
