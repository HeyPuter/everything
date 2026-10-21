/**
 * A model that runs on this device and is only fetched the first time a
 * feature needs it. create() builds it (once); ready() resolves to whether
 * it can be used, and state changes reach the listeners so panels and the
 * player can follow along.
 */
export function lazyModel(create, failMessage) {
  let instance = null;
  let loading = null;
  let failure = null;
  const listeners = new Set();
  const state = () => (instance ? 'ready' : failure ? 'failed' : loading ? 'loading' : 'idle');
  const emit = () => {
    for (const fn of listeners) fn(state());
  };
  return {
    get instance() {
      return instance;
    },
    state,
    error: () => failure,
    /** Subscribe to the model becoming ready (or failing); returns an unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * Load the model (once). Resolves to true when it can be used. A failed
     * load stays failed (frames ask on every draw) until { retry: true }.
     */
    ready({ retry = false } = {}) {
      if (instance) return Promise.resolve(true);
      if (failure && retry && !loading) failure = null;
      if (failure) return Promise.resolve(false);
      if (!loading) {
        loading = (async () => {
          try {
            instance = await create();
            return true;
          } catch (err) {
            console.error(err);
            failure = err?.message || failMessage;
            return false;
          } finally {
            loading = null;
            emit();
          }
        })();
        emit();
      }
      return loading;
    },
  };
}
