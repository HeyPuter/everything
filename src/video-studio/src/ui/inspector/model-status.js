/**
 * Status line under a people tool: what its on-device model is doing
 * ("Finding faces...") or why it could not load, with Try again after a
 * failure (a dropped connection would otherwise disable the tool until
 * the page is reloaded).
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { ready, segmenterState, segmenterError } from '../../media/segmenter.js';
import { faceModelReady, faceModelState, faceModelError } from '../../media/face-landmarks.js';
import { hairModelReady, hairModelState, hairModelError } from '../../media/hair-segmenter.js';
import { poseModelReady, poseModelState, poseModelError } from '../../media/pose-landmarks.js';

const MODELS = [
  [segmenterState, segmenterError, ready],
  [faceModelState, faceModelError, faceModelReady],
  [hairModelState, hairModelError, hairModelReady],
  [poseModelState, poseModelError, poseModelReady],
];

/** Load again every people model whose load failed. */
export function retryPeopleModels() {
  for (const [state, , load] of MODELS) if (state() === 'failed') load({ retry: true });
}

/** { el, text, set(message) }: Try again shows while the message is a model's load error. */
export function modelStatusLine() {
  const text = h('p.asset-hint.cutout-status', { role: 'status' });
  const again = h('button.btn.small', { type: 'button', hidden: true }, icon('reset', 14), 'Try again');
  again.addEventListener('click', () => retryPeopleModels());
  const el = h('div.model-status', text, again);
  return {
    el,
    text,
    set(message) {
      text.textContent = message || '';
      text.hidden = !message;
      again.hidden = !message || !MODELS.some(([state, error]) => state() === 'failed' && error() === message);
      el.hidden = !message;
    },
  };
}
