// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

// The app schedules redraws with requestAnimationFrame; provide a stub.
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import '../../src/eval/modifiers_extra';
import '../../src/nodes/shader/defs';
import { output } from '../../src/scripting/runner';
import { runTool, toolSpecs, type AssistantHost } from '../../src/assistant/tools';
import { createAgent } from '../../src/assistant/agent';
import type { ChatFn, StreamPart } from '../../src/assistant/ai';
import { SYSTEM_PROMPT, sceneSnapshot } from '../../src/assistant/prompt';
import { type Attachment, attachmentKind, attachmentMeta, attachmentsGone, attachmentsIntro, imageBlock, offerImages } from '../../src/assistant/attach';
import { clearScriptFiles } from '../../src/scripting/files';

let host: AssistantHost;
const objectNames = () => Object.values(app.doc.objects).map((o) => o.name).sort();
const script = (code: string, description = 'Test') => runTool(host, 'run_script', { code, description });

beforeEach(() => {
  setApp(new App(startupDocument()));
  host = { app };
  output.clear();
});

describe('run_script', () => {
  it('builds objects and reports what it added, with sizes', async () => {
    const r = await script(`
      bpy.ops.mesh.primitive_cube_add({size: 1, location: [0, 0, 0.375]});
      const top = C.object; top.name = 'Table Top'; top.scale = [1.2, 0.8, 0.05];
      const m = top.modifiers.new('Bevel', 'BEVEL'); m.width = 0.01;
      print('made', top.name);
    `);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.content).toContain('made Table Top');
    expect(r.content).toMatch(/Added 1 object: "Table Top" \(MESH\)/);
    expect(r.content).toMatch(/"Table Top" MESH: location \(0, 0, 0\.375\); scale \(1\.2, 0\.8, 0\.05\); size 1\.2 × 0\.8 × 0\.05/);
    expect(r.content).toContain('modifiers Bevel (BEVEL)');
    // printed lines go to the model, not into the user's Python Console
    expect(output.lines.some((l) => l.text.includes('made'))).toBe(false);
  });

  it('reports changes to existing objects and materials', async () => {
    const r = await script(`
      const cube = D.objects['Cube']; cube.location.z = 1;
      const mat = D.materials.new('Red'); mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = [1, 0, 0, 1];
      cube.data.materials.append(mat);
    `);
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/Changed: "Cube" \(transform, materials\)/);
    expect(r.content).toContain('New materials: "Red"');
  });

  it('rolls a failing script back and points at the line', async () => {
    const before = objectNames();
    const steps = app.undo.history.length;
    const r = await script(`bpy.ops.mesh.primitive_cube_add({location: [3, 0, 0]});\nC.object.name = 'Half';\nD.objects['Missing'].location.x = 1;`);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/Error at line 3/);
    expect(r.content).toContain("D.objects['Missing'].location.x = 1;");
    expect(r.content).toContain('rolled back');
    expect(objectNames()).toEqual(before);
    expect(app.undo.history.length).toBe(steps);
  });

  it('undoes a dry run after reporting what it printed and would change', async () => {
    const steps = app.undo.history.length;
    const r = await runTool(host, 'run_script', { description: 'Look at a Mix node', dry_run: true, code: "const n = D.materials.new('Probe').node_tree.nodes.new('ShaderNodeMix'); print(n.data_type)" });
    expect(r.ok).toBe(true);
    expect(r.changed).toBeFalsy();
    expect(r.content).toContain('dry run');
    expect(r.content).toContain('Printed:\nFLOAT');
    expect(r.content).toContain('New materials: "Probe"');
    expect(Object.values(app.doc.materials).some((m) => m.name === 'Probe')).toBe(false);
    expect(app.undo.history.length).toBe(steps);
  });

  it('says when nothing changed', async () => {
    const r = await script(`print(D.objects.length)`);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.content).toContain('Printed:\n3');
    expect(r.content).toContain('Nothing in the scene changed.');
  });
});

describe('reading the scene', () => {
  it('snapshots objects with type, location and size', () => {
    const s = sceneSnapshot(host);
    expect(s).toContain('Mode: OBJECT.');
    expect(s).toMatch(/- "Cube" MESH: location \(0, 0, 0\); size 2 × 2 × 2; bounds x -1…1, y -1…1, z -1…1/);
    expect(s).toMatch(/- "Camera" CAMERA \(50 mm, scene camera\)/);
    expect(s).toMatch(/- "Light" LIGHT \(POINT/);
  });

  it('describes an object, a material and the scene', async () => {
    await script(`const m = D.materials.new('Steel'); const b = m.node_tree.nodes.get('Principled BSDF'); b.inputs['Metallic'].default_value = 1; D.objects.Cube.data.materials.append(m); D.objects.Cube.modifiers.new('Sub', 'SUBSURF').levels = 2;`);
    const ob = await runTool(host, 'get_object', { name: 'Cube' });
    expect(ob.content).toContain('Mesh: 8 vertices, 6 faces');
    expect(ob.content).toMatch(/Modifier "Sub" \(SUBSURF\): .*levels=2/);
    expect(ob.content).toContain('Material slots: 0: "Material", 1: "Steel"');
    const mat = await runTool(host, 'get_material', { name: 'steel' });
    expect(mat.content).toContain('Used by: "Cube"');
    expect(mat.content).toMatch(/"Principled BSDF" ShaderNodeBsdfPrincipled: .*Metallic=1/);
    expect(mat.content).toMatch(/Links:\n- "Principled BSDF"\.BSDF → "Material Output"\.Surface/);
    const missing = await runTool(host, 'get_object', { name: 'Nope' });
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain('No object named "Nope"');
    const scene = await runTool(host, 'get_scene', {});
    expect(scene.content).toContain('Render: engine');
  });

  it('looks up the API', async () => {
    const op = await runTool(host, 'api_help', { topic: 'bpy.ops.mesh.primitive_cylinder_add' });
    expect(op.content).toMatch(/- radius \(float.*\) = 1/);
    expect(op.content).toMatch(/- depth/);
    expect((await runTool(host, 'api_help', { topic: 'modifiers' })).content).toContain('- BEVEL: Bevel');
    expect((await runTool(host, 'api_help', { topic: 'modifier bevel' })).content).toMatch(/- width = /);
    expect((await runTool(host, 'api_help', { topic: 'constraints' })).content).toContain('TRACK_TO');
    expect((await runTool(host, 'api_help', { topic: 'node ShaderNodeBsdfPrincipled' })).content).toContain('"Base Color" RGBA');
    expect((await runTool(host, 'api_help', { topic: 'nodes noise texture' })).content).toContain('ShaderNodeTexNoise');
    const expr = await runTool(host, 'api_help', { topic: "D.objects['Cube']" });
    expect(expr.content).toMatch(/- location = /);
    expect(expr.content).toMatch(/Methods: .*keyframe_insert/);
    expect((await runTool(host, 'api_help', { topic: 'bpy.ops.mesh.nope' })).ok).toBe(false);
  });

  it('offers the viewport tools only with a viewport', () => {
    const names = toolSpecs(host).map((t) => t.function.name);
    expect(names).toContain('run_script');
    expect(names).not.toContain('capture_view');
    const ui = { capture: async () => 'data:image/jpeg;base64,AAAA', setView: () => 'ok' };
    expect(toolSpecs({ app, ui }).map((t) => t.function.name)).toContain('capture_view');
  });
});

describe('the conversation', () => {
  /** A model that plays back fixed replies, one per request, and records what it was sent. */
  function scripted(replies: StreamPart[][]) {
    const requests: unknown[][] = [];
    const chat: ChatFn = async function* (messages) {
      requests.push(structuredClone(messages));
      yield* replies[requests.length - 1] ?? [{ type: 'text', text: 'done' }];
    };
    return { chat, requests };
  }

  it('runs the tools the model calls and answers, as one undo step', async () => {
    const { chat, requests } = scripted([
      [{ type: 'tool', id: 't1', name: 'run_script', input: { description: 'Add a sphere', code: "bpy.ops.mesh.primitive_uv_sphere_add({radius: 0.5, location: [0, 0, 0.5]}); C.object.name = 'Ball';" } }],
      [{ type: 'tool', id: 't2', name: 'run_script', input: { description: 'Move it', code: "D.objects.Ball.location.x = 2;" } }],
      [{ type: 'text', text: 'Added a ball.' }],
    ]);
    const agent = createAgent({ chat, tools: () => toolSpecs(host), runTool: (n, a) => runTool(host, n, a), system: SYSTEM_PROMPT, snapshot: () => sceneSnapshot(host), model: () => 'test' });
    const mark = app.undo.mark();
    const texts: string[] = [];
    const res = await agent.send('make a ball', (e) => e.type === 'text' && texts.push(e.text));
    expect(res.error).toBeUndefined();
    expect(res.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(texts.join('')).toBe('Added a ball.');
    expect(objectNames()).toContain('Ball');
    // the first request carries the scene snapshot and the instructions
    const first = requests[0] as { role: string; content: string }[];
    expect(first[0].content).toBe(SYSTEM_PROMPT);
    expect(first[1].content).toMatch(/^<scene_state>\n[\s\S]*"Cube" MESH[\s\S]*<\/scene_state>\n\nmake a ball$/);
    // the second request has the first tool's result
    const second = requests[1] as { role: string; content: string }[];
    expect(second.at(-1)!.content).toContain('Added 1 object: "Ball" (MESH)');
    // both scripts become one undo step that restores the scene
    expect(app.undo.squash(mark, 'Assistant: make a ball')).toBe(true);
    expect(app.undo.topLabel).toBe('Assistant: make a ball');
    app.undoStep();
    expect(objectNames()).not.toContain('Ball');
  });

  it('runs bridge-requested tools and records their results in the transcript', async () => {
    const requests: unknown[][] = [];
    const chat: ChatFn = async function* (messages, options) {
      requests.push(structuredClone(messages));
      const result = await options.onToolCall!({
        id: 'bridge-call',
        name: 'run_script',
        input: { description: 'Add a bridge object', code: "bpy.ops.mesh.primitive_cube_add(); C.object.name = 'Bridge Cube';" },
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain('"Bridge Cube"');
      yield { type: 'text', text: 'Added it.' };
    };
    const agent = createAgent({ chat, tools: () => toolSpecs(host), runTool: (n, a) => runTool(host, n, a), system: SYSTEM_PROMPT, snapshot: () => sceneSnapshot(host), model: () => 'test' });
    const texts: string[] = [];
    const res = await agent.send('add a cube', (e) => e.type === 'text' && texts.push(e.text));

    expect(res.error).toBeUndefined();
    expect(res.steps.map((s) => s.status)).toEqual(['done']);
    expect(texts.join('')).toBe('Added it.');
    expect(objectNames()).toContain('Bridge Cube');
    expect(requests).toHaveLength(1);
    expect(agent.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'bridge-call')).toBe(true);
  });
});

describe('undo marks', () => {
  it('reverts to a mark and squashes the steps after it', () => {
    const mark = app.undo.mark();
    expect(app.undo.isCurrent(mark)).toBe(true);
    const id = Object.keys(app.doc.objects)[0];
    const x = app.doc.objects[id].location[0];
    app.doc.objects[id].location = [x + 1, 0, 0];
    app.pushUndo('One');
    app.pushUndo('Two');
    expect(app.undo.isCurrent(mark)).toBe(false);
    const steps = app.undo.history.length;
    expect(app.undo.squash(mark, 'Both')).toBe(true);
    expect(app.undo.history.length).toBe(steps - 1);
    expect(app.undo.topLabel).toBe('Both');
    expect(app.revertUndo(mark)).toBe(true);
    expect(app.undo.isCurrent(mark)).toBe(true);
    expect(app.doc.objects[id].location[0]).toBe(x);
  });
});

describe('attachments', () => {
  it('takes images, PDFs and text but sends 3D files to File › Import', () => {
    expect(attachmentKind({ name: 'ref.png', type: 'image/png', size: 1 })).toBe('image');
    expect(attachmentKind({ name: 'brief.pdf', type: 'application/pdf', size: 1 })).toBe('pdf');
    expect(attachmentKind({ name: 'make.py', type: '', size: 1 })).toBe('text');
    expect(attachmentKind({ name: 'chair.obj', type: 'text/plain', size: 1 })).toBeNull();
    expect(attachmentKind({ name: 'chair.glb', type: 'model/gltf-binary', size: 1 })).toBeNull();
  });

  it('lets scripts load an attached image into the scene, and tells the model how', async () => {
    clearScriptFiles();
    const photo = (bytes: Uint8Array): Attachment => ({ name: 'photo.jpg', kind: 'image', size: bytes.length, blocks: [imageBlock('image/jpeg', 'AAAA')], source: { name: 'photo.jpg', bytes, mime: 'image/jpeg', width: 300, height: 400 } });
    const first = photo(new Uint8Array([1]));
    offerImages([first]);
    expect(attachmentsIntro([first])).toContain('D.images.load("photo.jpg")');
    expect(attachmentsGone([attachmentMeta(first)])).toContain('D.images.load("photo.jpg")');
    // Another photo of the same name later in the chat gets a number.
    const second = photo(new Uint8Array([2]));
    offerImages([second]);
    expect(second.name).toBe('photo 2.jpg');
    const r = await script(`const img = D.images.load('photo 2.jpg'); const mat = D.materials.new('Photo'); mat.use_nodes = true;
      const tex = mat.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = img;
      mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color']);
      D.objects['Cube'].data.materials.append(mat); print(img.size[0], img.size[1])`);
    expect(r.ok).toBe(true);
    expect(r.content).toContain('300 400');
    expect(Object.values(app.doc.images).find((im) => im.name === 'photo 2.jpg')!.bytes).toEqual(new Uint8Array([2]));
    expect(attachmentsIntro([{ name: 'notes.txt', kind: 'text' }])).not.toContain('D.images.load');
  });
});

describe('docking beside the workspace', () => {
  it('keeps side editors at their width and resizes the main one', async () => {
    const { fitLayoutWidth } = await import('../../src/ui/screen');
    // a 3D view with a 300 px column at the right, over a timeline
    const layout = { split: 'v' as const, ratio: 0.8, a: { split: 'h' as const, ratio: 0.7, a: { area: { id: 'a', type: 'VIEW_3D' } }, b: { area: { id: 'b', type: 'PROPERTIES' } } }, b: { area: { id: 'c', type: 'TIMELINE' } } };
    const top = layout.a;
    const side = (w: number) => (w - 2) * (1 - top.ratio);
    const before = side(1002);
    fitLayoutWidth(layout, 1002, 622);
    expect(side(622)).toBeCloseTo(before, 6);
    fitLayoutWidth(layout, 622, 1002);
    expect(top.ratio).toBeCloseTo(0.7, 6);
    // too little room left for the main editor: both sides scale instead
    fitLayoutWidth(layout, 1002, 400);
    expect(top.ratio).toBeCloseTo(0.7, 6);
  });
});
