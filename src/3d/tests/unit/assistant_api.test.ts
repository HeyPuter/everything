// @vitest-environment happy-dom
// The assistant with the newer parts of the scripting API: guides in api_help, change reports for
// grease pencil, animation and sequencer data, and handlers undone with failed or trial scripts.
// The model is played back from fixed replies (no network).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { output } from '../../src/scripting/runner';
import { handlers } from '../../src/scripting/handlers';
import { runTool, toolSpecs, type AssistantHost } from '../../src/assistant/tools';
import { createAgent } from '../../src/assistant/agent';
import type { ChatFn, StreamPart } from '../../src/assistant/ai';
import { SYSTEM_PROMPT, sceneSnapshot } from '../../src/assistant/prompt';
import { GUIDES } from '../../src/assistant/guides';

let host: AssistantHost;
const script = (code: string, extra: Record<string, unknown> = {}) => runTool(host, 'run_script', { code, description: 'Test', ...extra });
const help = (topic: string) => runTool(host, 'api_help', { topic });

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
}, 60000);

beforeEach(() => {
  setApp(new App(startupDocument()));
  host = { app };
  output.clear();
  for (const l of Object.values(handlers) as unknown[]) if (Array.isArray(l)) l.length = 0;
});

describe('api_help guides', () => {
  it('has a guide for each newer area, listing what exists now', async () => {
    const topics = await help('topics');
    for (const k of Object.keys(GUIDES)) expect(topics.content).toContain(`"${k}"`);
    expect((await help('animation')).content).toContain('driver_add');
    expect((await help('drivers')).content).toContain('variables.new()');
    expect((await help('grease pencil')).content).toMatch(/GREASE_PENCIL_THICKNESS.*\n.*FX_GLOW/s);
    expect((await help('handlers')).content).toContain('frame_change_post');
    expect((await help('mathutils')).content).toMatch(/intersect_ray_tri/);
    expect((await help('context')).content).toMatch(/active_pose_bone/);
    expect((await help('data')).content).toMatch(/grease_pencils/);
    const bm = await help('bmesh');
    expect(bm.content).toMatch(/extrude_face_region.*inset_individual|inset_individual.*extrude_face_region/s);
  });

  it("the guides' examples run", async () => {
    const r = await script(`
      const me = D.meshes.new('Box'); const bm = bmesh.new();
      bmesh.ops.create_cube(bm, {size: 1});
      const res = bmesh.ops.extrude_face_region(bm, {geom: [...bm.faces].filter((f) => f.normal.z > 0.5)});
      bmesh.ops.translate(bm, {vec: [0, 0, 1], verts: res.geom.filter((e) => e.co)});
      bm.to_mesh(me); bm.free();
      const ob = D.objects.new('Box', me); C.collection.objects.link(ob);
      const tree = mathutils.bvhtree.BVHTree.FromObject(ob, C.evaluated_depsgraph_get());
      const hit = tree.ray_cast([0, 0, 5], [0, 0, -1]);
      print(me.polygons.length, hit[0].z.toFixed(2));
      C.temp_override({active_object: ob, selected_objects: [ob]}, () => bpy.ops.object.shade_smooth());
    `);
    expect(r.ok).toBe(true);
    expect(r.content).toContain('11 1.50');
  });

  it('describes the API without naming any other application', () => {
    const all = [SYSTEM_PROMPT, ...Object.values(GUIDES).map((g) => g.text())].join('\n');
    expect(all).not.toMatch(/blender/i);
    expect(SYSTEM_PROMPT).toContain('bmesh');
    expect(SYSTEM_PROMPT).toContain('temp_override');
  });
});

describe('scripts with the newer data', () => {
  it('reports a grease pencil drawing with its layers and strokes', async () => {
    const r = await script(`
      const gp = D.grease_pencils.new('Doodle');
      const d = gp.layers.new('Ink').frames.new(1).drawing; d.add_strokes([3, 2]);
      const ob = D.objects.new('Doodle', gp); C.collection.objects.link(ob);
      ob.shader_effects.new('Glow', 'FX_GLOW');
    `);
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/Added 1 object: "Doodle" \(GREASEPENCIL\)/);
    expect(r.content).toContain('"Doodle" GREASEPENCIL (1 layer, 2 strokes)');
    expect((await runTool(host, 'get_object', { name: 'Doodle' })).content).toMatch(/Layer "Ink": keyframes 1 \(2 strokes\)[\s\S]*Effect "Glow" \(FX_GLOW\)/);
  });

  it('reports keyframes on data, drivers and sequencer strips', async () => {
    const r = await script(`
      const light = D.objects['Light'].data; light.energy = 800; light.keyframe_insert('energy', {frame: 1});
      const fc = D.objects['Cube'].driver_add('location', 2); fc.driver.expression = 'frame / 24';
      C.scene.sequence_editor_create().strips.new_effect('Black', 'COLOR', 1, 1, {frame_end: 48});
    `);
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/"Light" \([^)]*animation\)/);
    expect(r.content).toMatch(/"Cube" \([^)]*animation\)/);
    expect(r.content).toMatch(/Scene settings changed: .*video sequencer/);
    const ob = (await runTool(host, 'get_object', { name: 'Cube' })).content;
    expect(ob).toContain('Driver location[2]: SCRIPTED "frame / 24"');
    expect((await runTool(host, 'get_scene', {})).content).toMatch(/Video sequencer: 1 strips: "Black" COLOR ch1 1–48/);
  });

  it('removes handlers and timers registered by a script that fails or runs dry', async () => {
    const failed = await script(`bpy.app.handlers.frame_change_post.push(() => {}); bpy.app.timers.register(() => 1); throw new Error('oops')`);
    expect(failed.ok).toBe(false);
    expect(handlers.frame_change_post.length).toBe(0);
    const dry = await script(`bpy.app.handlers.depsgraph_update_post.push(() => {})`, { dry_run: true });
    expect(dry.ok).toBe(true);
    expect(handlers.depsgraph_update_post.length).toBe(0);
    const kept = await script(`bpy.app.handlers.frame_change_post.push(function spin(scene) { D.objects['Cube'].rotation_euler.z = scene.frame_current / 10 })`);
    expect(kept.ok).toBe(true);
    app.setFrame(10);
    expect(Object.values(app.doc.objects).find((o) => o.name === 'Cube')!.rotation_euler[2]).toBeCloseTo(1);
  });
});

describe('a scripted conversation', () => {
  function scripted(replies: StreamPart[][]) {
    const requests: unknown[][] = [];
    const chat: ChatFn = async function* (messages) {
      requests.push(structuredClone(messages));
      yield* replies[requests.length - 1] ?? [{ type: 'text', text: 'done' }];
    };
    return { chat, requests };
  }

  it('looks up a guide, rigs a bouncing ball with keys and NLA, and answers', async () => {
    const { chat, requests } = scripted([
      [{ type: 'tool', id: 't1', name: 'api_help', input: { topic: 'animation' } }],
      [
        {
          type: 'tool',
          id: 't2',
          name: 'run_script',
          input: {
            description: 'Bouncing ball',
            code: `
              bpy.ops.mesh.primitive_uv_sphere_add({radius: 0.25, location: [0, 0, 0.25]});
              const ball = C.object; ball.name = 'Ball';
              for (const [f, z] of [[1, 0.25], [12, 2], [24, 0.25]]) { ball.location.z = z; ball.keyframe_insert('location', {index: 2, frame: f}); }
              const act = ball.animation_data.action; ball.animation_data.action = null;
              const strip = ball.animation_data.nla_tracks.new().strips.new('Bounce', 1, act); strip.repeat = 3;
              print(strip.frame_end);
            `,
          },
        },
      ],
      [{ type: 'text', text: 'The ball bounces three times.' }],
    ]);
    const agent = createAgent({ chat, tools: () => toolSpecs(host), runTool: (n, a) => runTool(host, n, a), system: SYSTEM_PROMPT, snapshot: () => sceneSnapshot(host), model: () => 'test' });
    const res = await agent.send('make a ball that bounces three times', () => {});
    expect(res.error).toBeUndefined();
    expect(res.steps.map((s) => s.status)).toEqual(['done', 'done']);
    const toolResults = JSON.stringify(requests[2]);
    expect(toolResults).toContain('NLA: const t = ob.animation_data.nla_tracks.new()');
    expect(toolResults).toContain('Added 1 object: \\"Ball\\" (MESH)');
    const ball = Object.values(app.doc.objects).find((o) => o.name === 'Ball')!;
    expect(ball.animation_data!.nla_tracks[0].strips[0].repeat).toBe(3);
    app.setFrame(12 + 23);
    app.evaluate();
    expect(ball.location[2]).toBeCloseTo(2, 1);
  });
});
