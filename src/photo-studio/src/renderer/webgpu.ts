import { UNIFORM_FLOATS, type Backend, type Texture } from './backend';
import { wgsl, wgslFloat, wgslResample, wgslFloatResample } from './shaders';
import { needsRgbaResampling } from './sampling';
import { wgslColor } from './color-shaders';
import { wgslLut } from './lut-shaders';
import { wgslFilter } from './filter-shaders';
export class WebGPUBackend implements Backend {
  readonly name = 'WebGPU';
  readonly maxSize: number;
  private pipeline: GPURenderPipeline;
  private screenPipeline: GPURenderPipeline;
  private floatPipeline?: GPURenderPipeline;
  private floatBytePipeline?: GPURenderPipeline;
  private floatScreenPipeline?: GPURenderPipeline;
  private resamplePipelines?: { byte: GPURenderPipeline; screen: GPURenderPipeline };
  private floatResamplePipelines?: { byte: GPURenderPipeline; float: GPURenderPipeline; screen: GPURenderPipeline };
  private sampler: GPUSampler;
  private lutPipelines?: { layout: GPUBindGroupLayout; byte: GPURenderPipeline; float: GPURenderPipeline };
  private filterPipelines?: { layout: GPUBindGroupLayout; byte: GPURenderPipeline; float: GPURenderPipeline };
  private views = new WeakMap<Texture, GPUTextureView>();
  private layout: GPUBindGroupLayout;
  private floatLayout?: GPUBindGroupLayout;
  private floatSampler?: GPUSampler;
  private colorPipelines?: {
    byte: GPURenderPipeline;
    float: GPURenderPipeline;
    screen: GPURenderPipeline;
  };
  private constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
  ) {
    this.maxSize = device.limits.maxTextureDimension2D;
    this.lost = device.lost.then(() => {
      if (this.disposed) return new Promise<void>(() => {});
    });
    const format = navigator.gpu.getPreferredCanvasFormat();
    // SDR UNORM canvas output clips straight RGB before premultiplying; HDR
    // values stay unbounded in offscreen float textures and typed readbacks.
    context.configure({ device, format, alphaMode: 'premultiplied' });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const module = device.createShaderModule({ code: wgsl });
    this.layout = device.createBindGroupLayout({
      entries: [
        ...[0, 1, 2].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {},
        })),
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const create = (format: GPUTextureFormat) =>
      device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    this.pipeline = create('rgba8unorm');
    this.screenPipeline = create(format);
  }
  private ensureFloatPipeline() {
    if (this.floatPipeline) return;
    const device = this.device,
      module = device.createShaderModule({ code: wgslFloat });
    this.floatSampler = device.createSampler();
    // rgba32float is not filterable on all WebGPU adapters. A non-filtering
    // layout and explicit bilinear textureLoad sampling work on the core feature set.
    this.floatLayout = device.createBindGroupLayout({
      entries: [
        ...[0, 1, 2].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' as const },
        })),
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const floatLayout = device.createPipelineLayout({ bindGroupLayouts: [this.floatLayout] });
    const createFloat = (format: GPUTextureFormat) =>
      device.createRenderPipeline({
        layout: floatLayout,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    this.floatPipeline = createFloat('rgba32float');
    this.floatBytePipeline = createFloat('rgba8unorm');
    this.floatScreenPipeline = createFloat(navigator.gpu.getPreferredCanvasFormat());
  }
  private ensureResamplePipelines(floating: boolean) {
    if (floating ? this.floatResamplePipelines : this.resamplePipelines) return;
    const module = this.device.createShaderModule({ code: floating ? wgslFloatResample : wgslResample });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [floating ? this.floatLayout! : this.layout] });
    const create = (format: GPUTextureFormat) => this.device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const common = { byte: create('rgba8unorm'), screen: create(navigator.gpu.getPreferredCanvasFormat()) };
    if (floating) this.floatResamplePipelines = { ...common, float: create('rgba32float') };
    else this.resamplePipelines = common;
  }
  static async create(canvas: HTMLCanvasElement) {
    if (!navigator.gpu) throw new Error('WebGPU unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxTextureDimension2D: Math.min(8192, adapter.limits.maxTextureDimension2D),
      },
    });
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('WebGPU context unavailable');
    device.pushErrorScope('validation');
    const backend = new WebGPUBackend(device, context);
    const error = await device.popErrorScope();
    if (error) {
      backend.dispose();
      throw new Error(error.message);
    }
    return backend;
  }
  private ensureColorPipeline() {
    if (this.colorPipelines) return;
    this.ensureFloatPipeline();
    const module = this.device.createShaderModule({ code: wgslColor });
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.floatLayout!] });
    const create = (format: GPUTextureFormat) =>
      this.device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    this.colorPipelines = {
      byte: create('rgba8unorm'),
      float: create('rgba32float'),
      screen: create(navigator.gpu.getPreferredCanvasFormat()),
    };
  }
  texture(width: number, height: number, source?: ImageBitmap | Uint8Array): Texture {
    const handle = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    if (source instanceof Uint8Array)
      this.device.queue.writeTexture(
        { texture: handle },
        source as Uint8Array<ArrayBuffer>,
        { bytesPerRow: width * 4 },
        [width, height],
      );
    else if (source)
      this.device.queue.copyExternalImageToTexture(
        { source },
        { texture: handle, premultipliedAlpha: false },
        [width, height],
      );
    return { width, height, handle, format: 'rgba8unorm' };
  }
  floatTexture(width: number, height: number, source?: Float32Array): Texture {
    this.ensureFloatPipeline();
    const handle = this.device.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    if (source)
      this.device.queue.writeTexture(
        { texture: handle },
        source as Float32Array<ArrayBuffer>,
        { bytesPerRow: width * 16 },
        [width, height],
      );
    return { width, height, handle, format: 'rgba32float' };
  }
  private view(t: Texture) {
    let view = this.views.get(t);
    if (!view) {
      view = (t.handle as GPUTexture).createView();
      this.views.set(t, view);
    }
    return view;
  }
  destroy(t: Texture) {
    this.views.delete(t);
    (t.handle as GPUTexture).destroy();
  }
  coverageTexture(width:number,height:number,source:Float32Array):Texture {
    this.ensureFloatPipeline();
    const handle=this.device.createTexture({size:[width,height],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    this.device.queue.writeTexture({texture:handle},source as Float32Array<ArrayBuffer>,{bytesPerRow:width*4},[width,height]);
    return {width,height,handle,format:'r32float'};
  }
  clear(t: Texture) {
    const e = this.device.createCommandEncoder();
    const p = e.beginRenderPass({
      colorAttachments: [
        {
          view: this.view(t),
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    p.end();
    this.device.queue.submit([e.finish()]);
  }
  pass(back: Texture, source: Texture, mask: Texture, uniforms: Float32Array, target?: Texture, pixelMask?: Texture) {
    const floating = uniforms[45] > 0.5 || [back, source, mask, target, pixelMask].some((t) => t && t.format !== 'rgba8unorm');
    if (floating) this.ensureFloatPipeline();
    if (uniforms[22] > 0.5) this.ensureColorPipeline();
    const resampling = uniforms[22] <= 0.5 && needsRgbaResampling(
      uniforms, back, source, target?.width ?? this.context.canvas.width, target?.height ?? this.context.canvas.height,
    );
    if (resampling) this.ensureResamplePipelines(floating);
    // Copy passes retain straight alpha offscreen; only the canvas is premultiplied.
    uniforms[30] = target ? 1 : 0;
    uniforms[26] = target?.width ?? this.context.canvas.width;
    uniforms[27] = target?.height ?? this.context.canvas.height;
    const buffer = this.device.createBuffer({
      // Viewport, pixel-mask matrix and parameters, Blend If ranges and flags.
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, uniforms as Float32Array<ArrayBuffer>);
    const group = this.device.createBindGroup({
      layout: floating ? this.floatLayout! : this.layout,
      entries: [
        ...[back, source, mask].map((t, binding) => ({
          binding,
          resource: this.view(t),
        })),
        { binding: 3, resource: floating ? this.floatSampler! : this.sampler },
        { binding: 4, resource: { buffer } },
        { binding: 5, resource: this.view(pixelMask ?? mask) },
      ],
    });
    const e = this.device.createCommandEncoder();
    const p = e.beginRenderPass({
      colorAttachments: [
        {
          view: target
            ? this.view(target)
            : this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: [0, 0, 0, 0],
          storeOp: 'store',
        },
      ],
    });
    p.setPipeline(
      uniforms[22] > 0.5
        ? target
          ? target.format === 'rgba32float'
            ? this.colorPipelines!.float
            : this.colorPipelines!.byte
          : this.colorPipelines!.screen
        : resampling
          ? target
            ? target.format === 'rgba32float'
              ? this.floatResamplePipelines!.float
              : (floating ? this.floatResamplePipelines! : this.resamplePipelines!).byte
            : (floating ? this.floatResamplePipelines! : this.resamplePipelines!).screen
          : target
            ? target.format === 'rgba32float'
              ? this.floatPipeline!
              : floating
                ? this.floatBytePipeline!
                : this.pipeline
            : floating
              ? this.floatScreenPipeline!
              : this.screenPipeline,
    );
    p.setBindGroup(0, group);
    p.draw(3);
    p.end();
    this.device.queue.submit([e.finish()]);
    buffer.destroy();
  }
  write(t: Texture, x: number, y: number, width: number, height: number, data: Uint8Array | Float32Array) {
    const bytes = t.format === 'r32float' ? 4 : t.format === 'rgba32float' ? 16 : 4;
    this.device.queue.writeTexture(
      { texture: t.handle as GPUTexture, origin: [x, y] },
      data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: width * bytes },
      [width, height],
    );
  }
  lutPass(source: Texture, lut: Texture, uniforms: Float32Array, target: Texture) {
    if (!this.lutPipelines) {
      const module = this.device.createShaderModule({ code: wgslLut });
      const layout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const create = (format: GPUTextureFormat) =>
        this.device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        });
      this.lutPipelines = { layout, byte: create('rgba8unorm'), float: create('rgba32float') };
    }
    const buffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, uniforms as Float32Array<ArrayBuffer>);
    const group = this.device.createBindGroup({
      layout: this.lutPipelines.layout,
      entries: [
        { binding: 0, resource: this.view(source) },
        { binding: 1, resource: this.view(lut) },
        { binding: 2, resource: { buffer } },
      ],
    });
    const e = this.device.createCommandEncoder();
    const p = e.beginRenderPass({
      colorAttachments: [{ view: this.view(target), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
    });
    p.setPipeline(target.format === 'rgba32float' ? this.lutPipelines.float : this.lutPipelines.byte);
    p.setBindGroup(0, group);
    p.draw(3);
    p.end();
    this.device.queue.submit([e.finish()]);
    buffer.destroy();
  }
  colorPass(source: Texture, transform: Texture, target?: Texture, clampRgb = false, tone?: readonly number[]) {
    const u = new Float32Array(32);
    if (tone) u.set(tone, 4);
    u[22] = 1;
    u[23] = clampRgb ? 1 : 0;
    u[31] = target ? 0 : 1;
    this.pass(transform, source, transform, u, target);
  }
  filterPass(sources: Texture[], uniforms: Float32Array, target: Texture) {
    if (!this.filterPipelines) {
      const module = this.device.createShaderModule({ code: wgslFilter });
      const layout = this.device.createBindGroupLayout({
        entries: [
          ...[0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' as const } })),
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const create = (format: GPUTextureFormat) =>
        this.device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        });
      this.filterPipelines = { layout, byte: create('rgba8unorm'), float: create('rgba32float') };
    }
    const data = new Float32Array(16);
    data.set(uniforms.subarray(0, 16));
    const buffer = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, data);
    const group = this.device.createBindGroup({
      layout: this.filterPipelines.layout,
      entries: [
        ...[0, 1, 2].map((binding) => ({ binding, resource: this.view(sources[binding] ?? sources[0]) })),
        { binding: 3, resource: { buffer } },
      ],
    });
    const e = this.device.createCommandEncoder();
    const p = e.beginRenderPass({
      colorAttachments: [{ view: this.view(target), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
    });
    p.setPipeline(target.format === 'rgba32float' ? this.filterPipelines.float : this.filterPipelines.byte);
    p.setBindGroup(0, group);
    p.draw(3);
    p.end();
    this.device.queue.submit([e.finish()]);
    buffer.destroy();
  }
  read(t: Texture): Promise<Uint8Array> {
    if (t.format !== 'rgba8unorm')
      throw new Error('Use float readback for a floating-point texture.');
    return this.readPixels(t, false) as Promise<Uint8Array>;
  }
  readFloat(t: Texture): Promise<Float32Array> {
    if (t.format !== 'rgba32float')
      throw new Error('Float readback requires a floating-point texture.');
    return this.readPixels(t, true) as Promise<Float32Array>;
  }
  private async readPixels(t: Texture, floating: boolean) {
    const pixelBytes = floating ? 16 : 4;
    const row = Math.ceil((t.width * pixelBytes) / 256) * 256;
    const buffer = this.device.createBuffer({
      size: row * t.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const e = this.device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: t.handle as GPUTexture }, { buffer, bytesPerRow: row }, [
      t.width,
      t.height,
    ]);
    this.device.queue.submit([e.finish()]);
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const data = floating
        ? new Float32Array(t.width * t.height * 4)
        : new Uint8Array(t.width * t.height * 4);
      const bytes = new Uint8Array(data.buffer);
      for (let y = 0; y < t.height; y++)
        bytes.set(
          mapped.subarray(y * row, y * row + t.width * pixelBytes),
          y * t.width * pixelBytes,
        );
      buffer.unmap();
      return data;
    } finally {
      buffer.destroy();
    }
  }
  readonly lost: Promise<void>;
  private disposed = false;
  dispose() {
    this.disposed = true;
    this.context.unconfigure();
    this.device.destroy();
  }
}
