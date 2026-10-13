import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { toolSettings } from '../src/features/tool-props/index.js';

let app;
let props;
beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument();
  app.openPanel('properties');
  props = app.dock.panels.get('properties');
});

const section = () => props.el.querySelector('.tool-settings')?.closest('section');
const field = (label) => [...props.el.querySelectorAll('.tool-settings input')].find((i) => i.getAttribute('aria-label') === label || i.labels?.[0]?.textContent === label);

function commit(input, value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.blur();
}

describe('Properties panel tool settings', () => {
  it('shows the document settings with the Selection tool and tool settings with a drawing tool', () => {
    app.setTool('selection');
    props.update();
    expect(props.docSection.hidden).toBe(false);
    expect(section().hidden).toBe(true);
    expect(props.toolOptions.hidden).toBe(true);
    app.setTool('paintbrush');
    props.update();
    expect(props.docSection.hidden).toBe(true);
    expect(props.appearance.hidden).toBe(false);
    expect(props.toolOptions.hidden).toBe(false);
    expect(section().hidden).toBe(false);
    expect(section().querySelector('.section-title').textContent).toBe('Paintbrush Tool');
    expect(section().querySelector('.tool-brush').hidden).toBe(false);
  });

  it('hides the tool settings once something is selected', () => {
    const doc = app.editor.doc;
    const node = createPath(rectangle(0, 0, 10, 10), true, {});
    doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
    app.setTool('pencil');
    app.editor.select([node.id]);
    props.update();
    expect(section().hidden).toBe(true);
    expect(props.toolOptions.hidden).toBe(true);
  });

  it('edits Blob Brush size, polygon sides and rounded rectangle radius in place', () => {
    app.setTool('blob-brush');
    props.update();
    commit(field('Size'), '24');
    expect(app.tool.size).toBe(24);
    app.setTool('polygon');
    props.update();
    commit(field('Sides'), '9');
    expect(app.tool.sides).toBe(9);
    app.setTool('rounded-rectangle');
    props.update();
    commit(field('Corner Radius'), '7');
    expect(app.prefs.get('cornerRadius')).toBe(7);
  });

  it('edits pencil fidelity and the options of option tools', () => {
    app.setTool('pencil');
    props.update();
    const range = props.el.querySelector('.tool-settings input[type=range]');
    range.value = '80';
    range.dispatchEvent(new Event('change'));
    expect(app.tool.fidelity).toBe(80);
    app.setTool('spiral');
    props.update();
    commit(field('Segments'), '14');
    expect(app.tool.options.segments).toBe(14);
    app.setTool('line');
    props.update();
    const fill = [...props.el.querySelectorAll('.tool-settings input[type=checkbox]')].find((i) => i.labels[0].textContent === 'Fill Line');
    fill.click();
    expect(app.tool.options.fill).toBe(true);
  });

  it('the appearance edits the style for new artwork', () => {
    app.setTool('rectangle');
    props.update();
    expect(toolSettings(app).fields.map((f) => f.key)).toEqual(['w', 'h']);
    commit(props.opacity.input, '40');
    expect(app.editor.style.opacity).toBeCloseTo(0.4);
  });
});
