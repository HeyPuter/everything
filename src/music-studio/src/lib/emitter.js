// Minimal synchronous event emitter. `on` returns an unsubscribe function.
export class Emitter {
  #handlers = new Map();

  on(type, fn) {
    let set = this.#handlers.get(type);
    if (!set) this.#handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  emit(type, ...args) {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) fn(...args);
  }
}
