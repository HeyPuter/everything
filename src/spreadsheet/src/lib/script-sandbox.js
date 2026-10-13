/**
 * Where scripts run in the app: a worker started inside a hidden, sandboxed frame. The frame is sandboxed without
 * allow-same-origin, so it and its worker have an opaque origin of their own: none of the app's storage, cookies,
 * Puter session or page is theirs to reach, and the frame's content security policy refuses them the network. The
 * worker runs the script off the page's thread, so a script stuck in a loop never freezes the app; taking the frame
 * away stops it at once.
 *
 * The frame relays messages between the app and the worker over a MessageChannel the app hands it; it is the only
 * door, and the app checks everything that comes through it (core/script-host.js).
 */

/** The frame's policy: its own inline boot script and blob workers, nothing else; no network at all. */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; form-action 'none'; base-uri 'none'";
export const SANDBOX_FLAGS = 'allow-scripts';

/** The frame's boot script, run inside it (serialized: it may refer to nothing outside itself). */
function sandboxBoot() {
  let port = null;
  let worker = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || port || !e.data || e.data.type !== 'boot' || !e.ports[0]) return;
    port = e.ports[0];
    const fail = (message, line) => port.postMessage({ type: 'load-error', message: String(message || 'The script could not start'), line: line || 0 });
    try {
      const url = URL.createObjectURL(new Blob([e.data.source], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (m) => port.postMessage(m.data);
      worker.onmessageerror = () => fail('A message from the script could not be read');
      // The runtime reports its own errors; what reaches here is code that could not even be read.
      worker.onerror = (ev) => { ev.preventDefault(); fail(ev.message, ev.lineno); };
      port.onmessage = (m) => worker.postMessage(m.data);
    } catch (err) {
      fail(err && err.message);
    }
  });
  window.parent.postMessage({ type: 'script-sandbox-ready' }, '*');
}

export const SANDBOX_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"></head><body><script>(${sandboxBoot.toString()})();</script></body></html>`;

/**
 * A transport for runScript (core/script-run.js): each run gets a frame of its own, removed when the run ends.
 * `host` is where the frame goes (document.body by default).
 */
export function sandboxTransport({ host = null } = {}) {
  return (source, onMessage) => {
    if (typeof Worker !== 'function' || typeof MessageChannel !== 'function') throw new Error('Scripts cannot run in this browser: it has no web workers.');
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX_FLAGS);
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.title = 'Script sandbox';
    frame.className = 'script-sandbox';
    frame.srcdoc = SANDBOX_HTML;
    const channel = new MessageChannel();
    let ended = false;
    const onWindowMessage = (e) => {
      if (e.source !== frame.contentWindow || e.data?.type !== 'script-sandbox-ready') return;
      window.removeEventListener('message', onWindowMessage);
      frame.contentWindow.postMessage({ type: 'boot', source }, '*', [channel.port2]);
    };
    window.addEventListener('message', onWindowMessage);
    channel.port1.onmessage = (e) => { if (!ended) onMessage(e.data); };
    (host || document.body).append(frame);
    return {
      post: (m) => { if (!ended) channel.port1.postMessage(m); },
      terminate: () => {
        ended = true;
        window.removeEventListener('message', onWindowMessage);
        channel.port1.close();
        frame.remove();
      },
    };
  };
}
