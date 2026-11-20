import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import {
  connectionSummary,
  createSession,
  denyConsent,
  disableControl,
  enableControl,
  endSession,
  grantConsent,
  inviteGuest,
  mockScreenFrame,
} from './engine/session.js';

let session = createSession();
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('screen'));
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');
const audit = document.getElementById('audit');
const connections = document.getElementById('connections');
let t = 0;

function render() {
  const frame = mockScreenFrame(t);
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, `hsl(${frame.hue} 40% 28%)`);
  g.addColorStop(1, `hsl(${(frame.hue + 40) % 360} 35% 18%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,.88)';
  ctx.font = '600 16px DM Sans, sans-serif';
  ctx.fillText(session.viewEnabled ? frame.label : 'Waiting for guest consent…', 24, 40);
  ctx.font = '13px DM Sans, sans-serif';
  ctx.fillStyle = 'rgba(255,220,160,.95)';
  ctx.fillText(frame.documented, 24, canvas.height - 24);
  if (session.controlEnabled) {
    ctx.strokeStyle = '#5dff9a';
    ctx.lineWidth = 3;
    ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
    ctx.fillStyle = '#5dff9a';
    ctx.fillText('CONTROL ON (consented)', 24, 64);
  }
  status.textContent = `State: ${session.state} · view=${session.viewEnabled} · control=${session.controlEnabled}`;
  audit.textContent = session.audit
    .map((a) => `${new Date(a.at).toLocaleTimeString()}  [${a.kind}] ${a.detail}`)
    .join('\n') || '(empty)';
  const row = connectionSummary(session);
  connections.replaceChildren();
  const li = document.createElement('li');
  li.textContent = `${row.peer} · ${row.state}`;
  connections.append(li);
}

function safe(fn) {
  try {
    session = fn(session);
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  render();
}

document.getElementById('invite').addEventListener('click', () => safe((s) => inviteGuest(s)));
document.getElementById('grant').addEventListener('click', () => safe(grantConsent));
document.getElementById('deny').addEventListener('click', () => safe(denyConsent));
document.getElementById('control').addEventListener('click', () => {
  safe((s) => (s.controlEnabled ? disableControl(s) : enableControl(s)));
});
document.getElementById('end').addEventListener('click', () => safe(endSession));

setInterval(() => {
  t += 0.05;
  if (session.viewEnabled) render();
}, 200);
render();
