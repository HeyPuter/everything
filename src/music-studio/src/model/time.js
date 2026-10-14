// Musical time. Positions and lengths are integer ticks at PPQ ticks per
// quarter note. A step is a sixteenth note (the step sequencer's grid cell).

export const PPQ = 96;
export const STEP = PPQ / 4;

/** Ticks in one beat of the time signature (a quarter note in 4/4, an eighth in 6/8). */
export function ticksPerBeat(sig = [4, 4]) {
  return (PPQ * 4) / sig[1];
}

export function ticksPerBar(sig = [4, 4]) {
  return ticksPerBeat(sig) * sig[0];
}

export function ticksToSeconds(ticks, bpm) {
  return (ticks / PPQ) * (60 / bpm);
}

export function secondsToTicks(sec, bpm) {
  return (sec * bpm * PPQ) / 60;
}

/** Rounds `ticks` up to a whole number of bars (at least one bar). */
export function ceilToBar(ticks, sig = [4, 4]) {
  const bar = ticksPerBar(sig);
  return Math.max(bar, Math.ceil(ticks / bar) * bar);
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Bar:Step:Tick, 1-based bar and step, as shown in the transport display:
 * tick 0 is "1:01:00". Steps are sixteenths; ticks are within the step.
 */
export function formatBST(ticks, sig = [4, 4]) {
  const t = Math.max(0, Math.floor(ticks));
  const bar = ticksPerBar(sig);
  const b = Math.floor(t / bar);
  const inBar = t - b * bar;
  const s = Math.floor(inBar / STEP);
  return `${b + 1}:${pad(s + 1)}:${pad(inBar - s * STEP)}`;
}

/**
 * Minutes:seconds:centiseconds for a position at `bpm`, or through a tempo
 * map (anything with seconds(tick), e.g. engine.tempo) so tempo automation
 * is followed.
 */
export function formatTime(ticks, bpm) {
  const sec = Math.max(0, typeof bpm === 'number' ? ticksToSeconds(ticks, bpm) : bpm.seconds(ticks));
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${m}:${pad(s)}:${pad(cs)}`;
}

/** "1.2.3" style short bar label for rulers (bar.beat, 1-based). */
export function barLabel(ticks, sig = [4, 4]) {
  const bar = ticksPerBar(sig);
  const beat = ticksPerBeat(sig);
  const b = Math.floor(ticks / bar);
  const bt = Math.floor((ticks - b * bar) / beat);
  return bt ? `${b + 1}.${bt + 1}` : String(b + 1);
}

/**
 * Snap choices for the editors. `ticks` null means the grid follows the zoom
 * ("Line": the finest grid line drawn), 0 means no snapping.
 */
export const SNAPS = [
  { id: 'line', label: 'Line', ticks: null },
  { id: 'none', label: 'None', ticks: 0 },
  { id: 'step6', label: '1/6 step', ticks: STEP / 6 },
  { id: 'step4', label: '1/4 step', ticks: STEP / 4 },
  { id: 'step3', label: '1/3 step', ticks: STEP / 3 },
  { id: 'step2', label: '1/2 step', ticks: STEP / 2 },
  { id: 'step', label: 'Step', ticks: STEP },
  { id: 'beat3', label: '1/3 beat', ticks: PPQ / 3 },
  { id: 'beat2', label: '1/2 beat', ticks: PPQ / 2 },
  { id: 'beat', label: 'Beat', ticks: PPQ },
  { id: 'bar', label: 'Bar', ticks: PPQ * 4 },
];

/**
 * Grid spacing in ticks for a zoom level (`pxPerTick`): the finest of step,
 * beat, bar, 2 bars... that keeps lines at least `minPx` apart.
 */
export function gridTicks(pxPerTick, sig = [4, 4], minPx = 10) {
  const candidates = [STEP / 4, STEP / 2, STEP, ticksPerBeat(sig), ticksPerBar(sig)];
  for (const c of candidates) if (c * pxPerTick >= minPx) return c;
  let t = ticksPerBar(sig);
  while (t * pxPerTick < minPx) t *= 2;
  return t;
}

/** Resolves a snap id to ticks for the current zoom (0 = free). */
export function snapTicks(snapId, pxPerTick, sig = [4, 4]) {
  const s = SNAPS.find((x) => x.id === snapId) || SNAPS[0];
  if (s.ticks === null) return gridTicks(pxPerTick, sig);
  if (s.id === 'bar') return ticksPerBar(sig);
  return s.ticks;
}

/** Snaps a tick position to the grid (floor so a click lands in the cell under the pointer). */
export function snapFloor(ticks, grid) {
  return grid > 0 ? Math.floor(ticks / grid) * grid : Math.round(ticks);
}

export function snapRound(ticks, grid) {
  return grid > 0 ? Math.round(ticks / grid) * grid : Math.round(ticks);
}
