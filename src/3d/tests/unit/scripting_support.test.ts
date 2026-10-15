// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app, registerOperators } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { keymaps, addKeys } from '../../src/app/keymap';
import { highlightLines, tokenizeLine } from '../../src/scripting/highlight';
import { toPropDef, registerScriptOperator, resultString } from '../../src/scripting/registry';
import { keyconfig, startKeyconfig } from '../../src/prefs/keyconfig';
import { bpy } from '../../src/scripting/api';
import { runJavaScript } from '../../src/scripting/runner';
import { pyLiteral } from '../../src/scripting/oplog';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => setApp(new App(startupDocument())));

describe('syntax highlighting', () => {
  it('tokenizes Python keywords, strings, numbers, comments and decorators', () => {
    const { tokens } = tokenizeLine('def f(x=1.5): return "a" # c', 'python', { kind: 'none' });
    const types = tokens.filter((t) => t.type !== 'plain').map((t) => `${t.type}:${t.text.trim()}`);
    expect(types).toContain('builtin:def');
    expect(types).toContain('numbers:1.5');
    expect(types).toContain('string:"a"');
    expect(types).toContain('comment:# c');
    expect(tokenizeLine('@property', 'python', { kind: 'none' }).tokens[0]).toEqual({ text: '@property', type: 'preprocessor' });
    expect(tokenizeLine('x = None', 'python', { kind: 'none' }).tokens.find((t) => t.text === 'None')?.type).toBe('numbers');
  });

  it('carries multi-line strings and comments across lines', () => {
    const html = highlightLines('s = """one\ntwo"""\nx = 1', 'python');
    expect(html[1]).toBe('<span class="sy-string">two"""</span>');
    const js = highlightLines('/* a\nb */ let y = `t\n${1}`;', 'javascript');
    expect(js[0]).toContain('sy-comment');
    expect(js[1]).toContain('<span class="sy-comment">b */</span>');
    expect(js[1]).toContain('<span class="sy-builtin">let</span>');
  });

  it('escapes HTML and can be disabled', () => {
    expect(highlightLines('a < b && c', 'text')[0]).toBe('a &lt; b &amp;&amp; c');
    expect(highlightLines('if x: pass', 'python', false)[0]).toBe('if x: pass');
  });
});

describe('script operator properties', () => {
  it('maps bpy.props declarations to operator PropDefs', () => {
    expect(toPropDef('size', { __kind: 'propdef', type: 'FLOAT', default: 2, subtype: 'DISTANCE', min: 0 })).toMatchObject({ id: 'size', label: 'Size', type: 'float', subtype: 'distance', default: 2, min: 0 });
    expect(toPropDef('mode', { __kind: 'propdef', type: 'ENUM', items: [['A', 'Alpha', ''], ['B', 'Beta', '']] })).toMatchObject({ type: 'enum', default: 'A' });
    expect(toPropDef('col', { __kind: 'propdef', type: 'FLOAT_VECTOR', subtype: 'COLOR', size: 4, default: [1, 0, 0, 1] })).toMatchObject({ type: 'color', default: [1, 0, 0, 1] });
    expect(toPropDef('rot', { __kind: 'propdef', type: 'FLOAT_VECTOR', subtype: 'EULER' })).toMatchObject({ type: 'vec3', subtype: 'angle' });
    expect(() => toPropDef('e', { __kind: 'propdef', type: 'ENUM', items: [] })).toThrow(/items/);
    expect(resultString(new Set(['FINISHED']))).toBe('FINISHED');
    expect(resultString(['CANCELLED'])).toBe('CANCELLED');
  });

  it('nested operator calls inside a script operator make one undo step', () => {
    registerOperators([{ idname: 'test.bump', label: 'Bump', exec: (ctx) => void (ctx.doc.scene.frame_end += 1) }]);
    registerScriptOperator({
      idname: 'test.double_bump',
      label: 'Double Bump',
      options: ['REGISTER', 'UNDO'],
      props: {},
      exec: () => {
        (bpy as Any).ops.test.bump();
        (bpy as Any).ops.test.bump();
        return 'FINISHED';
      },
      language: 'javascript',
    });
    const before = app.undo.history.length;
    app.run('test.double_bump');
    expect(app.doc.scene.frame_end).toBe(252);
    expect(app.undo.history.length).toBe(before + 1);
    expect(app.undo.topLabel).toBe('Double Bump');
  });

  it('JavaScript classes register through bpy.utils.register_class', () => {
    const res = runJavaScript(`
      class Hello extends bpy.types.Operator {
        static bl_idname = 'object.hello_js';
        static bl_label = 'Hello JS';
        static properties = { n: bpy.props.IntProperty({ default: 2 }) };
        execute(context) { context.scene.frame_start = this.n; return 'FINISHED'; }
      }
      bpy.utils.register_class(Hello);
      bpy.ops.object.hello_js({ n: 7 });
    `);
    expect(res.ok).toBe(true);
    expect(app.doc.scene.frame_start).toBe(7);
  });
});

describe('keymap overrides', () => {
  it('rebinds, disables and restores key items of the live keymaps', () => {
    addKeys('Test Map', [{ key: 'Q', op: 'test.op' }]);
    startKeyconfig();
    const k = keymaps['Test Map'][0];
    keyconfig.edit(k, { key: 'W', ctrl: true });
    expect(k.key).toBe('W');
    expect(k.ctrl).toBe(true);
    expect(keyconfig.isModified(k)).toBe(true);
    expect(keyconfig.baseFields(k)).toMatchObject({ key: 'Q', ctrl: false, shift: false, alt: false });
    keyconfig.edit(k, { active: false });
    expect(k.inactive).toBe(true);
    expect(k.key).toBe('W');
    keyconfig.restore(k);
    expect(k.key).toBe('Q');
    expect(k.ctrl).toBeFalsy();
    expect(k.inactive).toBeFalsy();
    expect(keyconfig.isModified(k)).toBe(false);
    // keys registered later still become restorable defaults
    addKeys('Test Map', [{ key: 'E', op: 'test.late' }]);
    const late = keymaps['Test Map'][1];
    keyconfig.edit(late, { shift: true });
    expect(late.shift).toBe(true);
    keyconfig.restore(late);
    expect(late.shift).toBeFalsy();
  });
});

describe('python literals for the Info log', () => {
  it('formats values like Python', () => {
    expect(pyLiteral([1, 0.5, true])).toBe('(1, 0.5, True)');
    expect(pyLiteral('it\'s')).toBe("'it\\'s'");
    expect(pyLiteral(null)).toBe('None');
    expect(pyLiteral([2])).toBe('(2,)');
    expect(pyLiteral(1 / 3)).toBe('0.333333');
  });
});
