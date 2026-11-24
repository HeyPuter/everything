// The time of each click on a slide as the presenter practises: for each
// click step, how long after the step before it ended (or the slide's
// opening effects ended) the click came. Kept with the rehearsed timings,
// the show plays each step at that time (see P.setSlideClickTimings).
//
// `clock()` is the practice time on the slide in ms, standing still while
// the practice is paused.
export function createClickTimes(clock) {
  let times = [];
  let since = null; // when the last step ended; null while it plays
  let token = 0;
  function settle(played) {
    const mine = ++token;
    since = null;
    const done = () => {
      if (mine === token) since = clock();
    };
    Promise.resolve(played).then(done, done);
  }
  return {
    /** The slide opened from its start; its opening effects end with
     * `played`. */
    opened(played) {
      times = [];
      settle(played);
    },
    /** Click step `at` (0 for the first) started, and ends with `played`.
     * A click while the step before still plays comes at once. */
    clicked(at, played) {
      times.length = Math.min(times.length, at);
      times[at] = since === null ? 0 : Math.max(0, clock() - since);
      settle(played);
    },
    /** Steps were taken back, leaving `at` played. */
    back(at) {
      times.length = Math.min(times.length, at);
      settle(null);
    },
    /** Practising this slide starts over at step `at`. */
    restart(at) {
      times.length = Math.min(times.length, at);
      for (let i = 0; i < at; i++) times[i] = undefined;
      settle(null);
    },
    /** Each step's time in ms (to 10 ms), null for a step not timed. */
    get times() {
      return Array.from(times, (ms) =>
        typeof ms === "number" ? Math.round(ms / 10) * 10 : null,
      );
    },
  };
}
