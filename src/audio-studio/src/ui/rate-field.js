// A sample rate field for the New Audio File and New Multitrack Session
// dialogs: a number box that suggests the common rates but takes any rate
// a browser audio context can run at.

import { h } from '../lib/dom.js';

export const NEW_FILE_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
export const MIN_NEW_RATE = 3000;
export const MAX_NEW_RATE = 384000;

let nextList = 0;

/** Whole-number rate in range, or null. */
export function parseRate(text) {
  const n = Number(String(text).trim().replace(/\s*hz$/i, ''));
  return Number.isInteger(n) && n >= MIN_NEW_RATE && n <= MAX_NEW_RATE ? n : null;
}

/**
 * Returns { el, input, value() }: `el` holds the box and its "Hz" unit, `value()` the
 * rate or null when the text is not a usable rate.
 */
export function rateField(initial, { rates = NEW_FILE_RATES } = {}) {
  const id = `new-rates-${++nextList}`;
  const input = h('input.input.num.rate-field', { type: 'number', min: MIN_NEW_RATE, max: MAX_NEW_RATE, step: 1, value: initial, list: id, 'aria-label': 'Sample rate (Hz)', style: { width: '110px' } });
  const list = h('datalist', { id }, rates.map((r) => h('option', { value: r })));
  const el = h('div.row', input, list, h('span.muted', 'Hz'));
  return { el, input, value: () => parseRate(input.value) };
}

/** The message shown when a rate field holds no usable rate. */
export const RATE_PROBLEM = `Enter a sample rate from ${MIN_NEW_RATE} to ${MAX_NEW_RATE} Hz.`;
