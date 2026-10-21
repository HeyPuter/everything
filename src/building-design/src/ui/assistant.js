/**
 * The assistant: a side panel where you ask about the project or ask for
 * changes in plain words. It answers through Puter's AI and acts with the
 * functions in assistant/tools.js; every change it makes is an ordinary
 * undo step.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { toolSchemas, runTool } from '../assistant/tools.js';
import { puterAvailable, isSignedIn, whenPuter } from '../platform.js';

const SUGGESTIONS = ['What can you do for me?', 'Check the model for problems', 'Make a door schedule sorted by level', 'List the rooms on Level 1 with their areas'];
const MAX_ROUNDS = 8;

const SYSTEM = `You are the assistant inside Building Design, a browser BIM app. The user models buildings with walls, doors, windows, floors, roofs, rooms, levels, views, schedules and sheets.
Use the functions to look at the project before answering questions about it, and to make the changes the user asks for. Lengths are millimetres in function calls; in your answers use the project's units.
Be brief and concrete. Say what you changed. If a request is unclear or would delete or replace a lot, ask first. When you cannot do something with your functions, say which tool in the app does it (for example "Architecture tab > Roof").`;

function replyText(res) {
  if (typeof res === 'string') return res;
  const content = res?.message?.content ?? res?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : '')).join('');
  return '';
}

function toolCalls(res) {
  const msg = res?.message || {};
  const out = [];
  for (const c of msg.tool_calls || []) out.push({ id: c.id, name: c.function?.name, args: c.function?.arguments });
  if (Array.isArray(msg.content)) for (const c of msg.content) if (c?.type === 'tool_use') out.push({ id: c.id, name: c.name, args: c.input });
  return out.map((c) => {
    let input = c.args;
    if (typeof input === 'string') {
      try {
        input = input.trim() ? JSON.parse(input) : {};
      } catch {
        input = {};
      }
    }
    return { ...c, input: input || {} };
  });
}

export class Assistant {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.messages = [];
    this.busy = false;
    this.render();
  }

  render() {
    clear(this.root);
    this.log = h('div.as-log', { role: 'log', 'aria-live': 'polite' });
    this.input = h('textarea.input.as-input', { rows: 2, placeholder: 'Ask about the project, or ask for a change', 'aria-label': 'Message to the assistant' });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
    const sendBtn = h('button.icon-btn.as-send', { type: 'button', 'aria-label': 'Send', 'data-tip': 'Send (Enter)', onClick: () => this.send() }, icon('send', 16));
    this.root.append(
      h('div.pane-head', h('h2.pane-title', { id: 'assist-title' }, icon('sparkles', 15), ' Assistant'), h('span.grow'), h('button.icon-btn.sm', { type: 'button', 'aria-label': 'New conversation', 'data-tip': 'New conversation', onClick: () => this.reset() }, icon('plus', 15)), h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Hide the assistant', 'data-tip': 'Hide', onClick: () => this.app.toggleAssistant(false) }, icon('x', 15))),
      this.log,
      h('div.as-compose', this.input, sendBtn),
      h('p.as-note', 'Answers come from an AI model and can be wrong. Its changes can be undone.'),
    );
    this.welcome();
  }

  welcome() {
    this.log.append(
      h('div.as-msg.as-bot', 'I can answer questions about this project and make changes: schedules, levels, walls, parameters, finding and selecting elements, and checking the model.'),
      h('div.as-suggest', SUGGESTIONS.map((s) => h('button.as-chip', { type: 'button', onClick: () => this.send(s) }, icon('corner-down-right', 13), s))),
    );
  }

  reset() {
    this.messages = [];
    clear(this.log);
    this.welcome();
  }

  add(cls, ...children) {
    const el = h(`div.as-msg.${cls}`, ...children);
    this.log.append(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  async send(text = this.input.value) {
    const q = String(text || '').trim();
    if (!q || this.busy) return;
    this.input.value = '';
    this.log.querySelector('.as-suggest')?.remove();
    this.add('as-user', q);
    if (!puterAvailable() || !(await whenPuter(4000))) return this.add('as-bot.as-err', 'The assistant needs Puter, which could not be reached. Check your connection.');
    if (!(await isSignedIn())) {
      const m = this.add('as-bot', 'Sign in with Puter to use the assistant. ');
      m.append(h('button.btn.sm', { type: 'button', onClick: async () => (await this.app.signIn()) && this.send(q) }, 'Sign in'));
      return;
    }
    this.busy = true;
    const thinking = this.add('as-bot.as-wait', h('span.as-dots', h('span'), h('span'), h('span')));
    this.messages.push({ role: 'user', content: q });
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await puter.ai.chat([{ role: 'system', content: SYSTEM }, ...this.messages], { tools: toolSchemas() });
        if (res?.success === false) throw new Error(res.error?.message || 'The AI did not answer');
        const calls = toolCalls(res);
        const text = replyText(res);
        if (!calls.length) {
          this.messages.push({ role: 'assistant', content: text });
          thinking.remove();
          this.add('as-bot', ...formatAnswer(text || 'Done.'));
          break;
        }
        this.messages.push({ role: 'assistant', content: text || '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) });
        for (const c of calls) {
          const result = runTool(this.app, c.name, c.input);
          this.log.insertBefore(h('div.as-step', icon(result?.error ? 'warning' : 'check', 13), describeStep(c.name, c.input, result)), thinking);
          this.messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 12000) });
        }
      }
    } catch (err) {
      thinking.remove();
      this.add('as-bot.as-err', `Something went wrong: ${err?.message || err?.error?.message || err}`);
    } finally {
      thinking.remove();
      this.busy = false;
      this.input.focus();
    }
  }
}

function describeStep(name, input, result) {
  const label = {
    project_summary: 'Looked at the project',
    find_elements: `Searched ${input.kind || 'elements'}${input.level ? ` on ${input.level}` : ''}`,
    room_areas: 'Measured rooms',
    get_element: 'Read an element',
    set_parameters: `Changed ${result?.changed ?? 0} element${result?.changed === 1 ? '' : 's'}`,
    select_elements: `Selected ${result?.selected ?? 0} element${result?.selected === 1 ? '' : 's'}`,
    open_view: `Opened ${result?.opened || input.name}`,
    create_schedule: `Created ${result?.created || 'a schedule'}`,
    create_level: `Created ${result?.created || 'a level'}`,
    create_walls: `Drew ${result?.created ?? 0} wall${result?.created === 1 ? '' : 's'}`,
    model_warnings: 'Checked the model',
    run_command: `Ran ${result?.ran || input.command}`,
  }[name] || name;
  return result?.error ? `${label}: ${result.error}` : label;
}

/** Plain text with paragraphs and simple bullet lists. */
function formatAnswer(text) {
  const out = [];
  let list = null;
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) {
      if (!list) out.push((list = h('ul.as-list')));
      list.append(h('li', m[1].replace(/\*\*(.+?)\*\*/g, '$1')));
    } else {
      list = null;
      if (line.trim()) out.push(h('p', line.replace(/\*\*(.+?)\*\*/g, '$1')));
    }
  }
  return out;
}
