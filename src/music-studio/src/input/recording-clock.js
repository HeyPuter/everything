// Advance a musical recording clock through a tempo map and playback loops.
// Whole loop cycles are counted arithmetically, so a background tab can catch
// up without iterating once per missed pass.
export function advanceRecordingClock(map, tick, seconds, { start, end, outer = end }) {
  seconds = Math.max(0, seconds);
  const firstEnd = tick >= end && outer > end ? outer : end;
  const untilEnd = map.duration(tick, firstEnd);
  if (seconds < untilEnd) {
    const next = map.ticks(map.seconds(tick) + seconds);
    return { tick: next, elapsed: next - tick };
  }
  const duration = map.duration(start, end);
  const remaining = Math.max(0, seconds - untilEnd);
  const cycles = Math.floor(remaining / duration);
  const next = map.ticks(map.seconds(start) + remaining - cycles * duration);
  return { tick: next, elapsed: firstEnd - tick + cycles * (end - start) + next - start };
}
