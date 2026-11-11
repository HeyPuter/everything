// The script sandbox. Each run gets a hidden iframe with `sandbox="allow-scripts"`
// (an opaque origin: no access to this page, its storage, cookies or Puter
// session) and a content security policy that allows no network, images or
// frames. The iframe starts a dedicated worker with the runtime and the
// script; the page talks to that worker over a MessageChannel with
// structured-clone messages only. A script that stops answering is stopped,
// and removing the iframe ends its worker.
import runtime from './runtime.js?raw';

export type SandboxOutcome =
  | { status: 'done' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; line: number }
  | { status: 'timeout'; seconds: number };
export type SandboxHandlers = {
  call(method: string, args: unknown[]): Promise<unknown>;
  log(level: string, text: string): void;
};
export type SandboxInfo = { script: { id: string; name: string }; event: Record<string, unknown> | null };

/** The policy of the sandbox document (and, inherited, of its worker). */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:";
// Forwards the script to a worker and reports load errors (syntax errors) to the page.
const bootstrap = `let started = false;
addEventListener('message', (ev) => {
  if (started || ev.source !== parent || !ev.data || ev.data.type !== 'start' || !ev.ports[0]) return;
  started = true;
  const url = URL.createObjectURL(new Blob([ev.data.code], { type: 'text/javascript' }));
  const worker = new Worker(url, { name: 'script' });
  worker.onerror = (e) => {
    e.preventDefault();
    parent.postMessage({ type: 'worker-error', message: String(e.message || 'The script could not run.'), line: e.lineno || 0 }, '*');
  };
  worker.postMessage({ type: 'start', info: ev.data.info }, [ev.ports[0]]);
});`;
export function sandboxDocument() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>${bootstrap}</script></head><body></body></html>`;
}
/** Runtime plus the script, with the line where the script's first line lands. */
export function sandboxCode(source: string) {
  const head = `${runtime}\n__studioRegister(async function (studio, console) {\n`;
  return { code: `${head}${source}\n});\n`, lineOffset: head.split('\n').length - 1 };
}

// Watchdog: the worker answers pings between script statements that await;
// a script busy for longer than its timeout without awaiting is stopped. Only
// answers count: a busy loop can still send output and calls without awaiting.
const PING_MS = 1000;

export class ScriptSandbox {
  private frame?: HTMLIFrameElement;
  private port?: MessagePort;
  private finish?: (o: SandboxOutcome) => void;
  private watchdog = 0;
  private heard = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = 0;
  // API calls in progress: the script is waiting on the editor, not stuck.
  private inCall = 0;
  private onWindowMessage = (ev: MessageEvent) => {
    if (!this.frame || ev.source !== this.frame.contentWindow) return;
    const m = ev.data as { type?: string; message?: string; line?: number };
    if (m?.type === 'worker-error') this.end({ status: 'failed', message: String(m.message ?? 'The script could not run.').replace(/^Uncaught /, ''), line: Math.max(0, Number(m.line) - this.lineOffset) });
  };
  private lineOffset = 0;
  constructor(
    private source: string,
    private info: SandboxInfo,
    private handlers: SandboxHandlers,
    private timeoutSeconds = 30,
  ) {}
  /** Run the script; resolves when it finishes, fails, is stopped or times out. */
  run(): Promise<SandboxOutcome> {
    return new Promise((resolve) => {
      this.finish = resolve;
      const { code, lineOffset } = sandboxCode(this.source);
      this.lineOffset = lineOffset;
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.className = 'script-sandbox';
      frame.title = 'Script sandbox';
      frame.srcdoc = sandboxDocument();
      this.frame = frame;
      window.addEventListener('message', this.onWindowMessage);
      frame.addEventListener(
        'load',
        () => {
          const channel = new MessageChannel();
          this.port = channel.port1;
          this.port.onmessage = (ev) => this.receive(ev.data);
          this.heard = performance.now();
          frame.contentWindow!.postMessage({ type: 'start', code, info: { ...this.info, lineOffset } }, '*', [channel.port2]);
          this.watchdog = window.setInterval(() => this.tick(), PING_MS);
        },
        { once: true },
      );
      document.body.append(frame);
    });
  }
  /** Ask the script to stop; it is ended if it does not within two seconds. */
  cancel() {
    if (!this.finish || this.stopping) return;
    this.port?.postMessage({ type: 'cancel' });
    this.stopping = window.setTimeout(() => this.end({ status: 'cancelled' }), 2000);
  }
  private tick() {
    this.port?.postMessage({ type: 'ping' });
    if (this.inCall) this.heard = performance.now();
    const silent = (performance.now() - this.heard) / 1000;
    if (silent > this.timeoutSeconds) this.end({ status: 'timeout', seconds: this.timeoutSeconds });
  }
  private receive(m: { type?: string; id?: number; method?: string; args?: unknown[]; level?: string; text?: string; message?: string; line?: number; cancelled?: boolean }) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'pong') this.heard = performance.now();
    else if (m.type === 'call' && typeof m.id === 'number' && typeof m.method === 'string') {
      const { id, method } = m;
      const args = Array.isArray(m.args) ? m.args : [];
      // Calls run one at a time, in order, even when a script does not await them.
      this.queue = this.queue.then(async () => {
        if (!this.finish) return;
        this.inCall++;
        try {
          const value = await this.handlers.call(method, args);
          this.port?.postMessage({ type: 'result', id, value }, transferables(value));
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.port?.postMessage({ type: 'error', id, name: err.name === 'ScriptError' ? 'Error' : err.name, message: err.message });
        } finally {
          this.inCall--;
          this.heard = performance.now();
        }
      });
    } else if (m.type === 'log') this.handlers.log(String(m.level ?? 'log'), String(m.text ?? ''));
    else if (m.type === 'done') this.end({ status: m.cancelled ? 'cancelled' : 'done' });
    else if (m.type === 'failed') this.end({ status: 'failed', message: String(m.message ?? 'The script failed.'), line: Number(m.line) || 0 });
  }
  private end(outcome: SandboxOutcome) {
    const finish = this.finish;
    if (!finish) return;
    this.finish = undefined;
    // Wait for host calls already running (a dialog, an edit) before reporting.
    void this.queue.then(() => {
      this.dispose();
      finish(this.stopping && outcome.status === 'done' ? { status: 'cancelled' } : outcome);
    });
  }
  dispose() {
    clearInterval(this.watchdog);
    clearTimeout(this.stopping);
    window.removeEventListener('message', this.onWindowMessage);
    this.port?.close();
    this.port = undefined;
    this.frame?.remove();
    this.frame = undefined;
  }
}

/** Buffers of a result that can move instead of being copied. */
function transferables(value: unknown): Transferable[] {
  const out = new Set<ArrayBuffer>();
  const add = (v: unknown) => {
    if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer && v.byteLength === v.buffer.byteLength) out.add(v.buffer);
  };
  if (value && typeof value === 'object') {
    add(value);
    for (const v of Object.values(value)) add(v);
  }
  return [...out];
}
