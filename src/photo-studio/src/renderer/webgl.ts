import { UNIFORM_FLOATS, type Backend, type Texture } from './backend';
import { glVertex, glFragment, glFloatFragment, glResampleFragment, glFloatResampleFragment } from './shaders';
import { needsRgbaResampling } from './sampling';
import { glColorFragment } from './color-shaders';
import { glLutFragment } from './lut-shaders';
import { glFilterFragment } from './filter-shaders';
export class WebGLBackend implements Backend {
  readonly name = 'WebGL2';
  readonly maxSize: number;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private floatProgram?: WebGLProgram;
  private colorProgram?: WebGLProgram;
  private resampleProgram?: WebGLProgram;
  private floatResampleProgram?: WebGLProgram;
  private lutProgram?: WebGLProgram;
  private filterProgram?: WebGLProgram;
  private framebuffer: WebGLFramebuffer;
  private compositeUniforms = new Float32Array(UNIFORM_FLOATS);
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl)
      throw new Error(
        'WebGPU and WebGL2 are unavailable. Enable hardware acceleration or use a supported browser.',
      );
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.program = this.createProgram(glFragment);
    this.framebuffer = gl.createFramebuffer()!;
    this.lost = new Promise((resolve) =>
      canvas.addEventListener(
        'webglcontextlost',
        (e) => {
          // Allows the browser to restore the context (webglcontextrestored).
          e.preventDefault();
          resolve();
        },
        { once: true },
      ),
    );
  }
  readonly lost: Promise<void>;
  private createProgram(fragment: string) {
    const gl = this.gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) ?? 'Shader compilation failed');
      return s;
    };
    const program = gl.createProgram()!;
    const vs = shader(gl.VERTEX_SHADER, glVertex),
      fs = shader(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'Shader linking failed');
    gl.useProgram(program);
    ['backTex', 'imageTex', 'maskTex', 'pixelMaskTex'].forEach((n, i) =>
      gl.uniform1i(gl.getUniformLocation(program, n), i),
    );
    return program;
  }
  texture(width: number, height: number, source?: ImageBitmap | Uint8Array): Texture {
    const g = this.gl,
      handle = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, handle);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    if (source && !(source instanceof Uint8Array))
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, source);
    else
      g.texImage2D(
        g.TEXTURE_2D,
        0,
        g.RGBA8,
        width,
        height,
        0,
        g.RGBA,
        g.UNSIGNED_BYTE,
        source ?? null,
      );
    return { width, height, handle, format: 'rgba8unorm' };
  }
  floatTexture(width: number, height: number, source?: Float32Array): Texture {
    const g = this.gl;
    const handle = g.createTexture()!;
    g.bindTexture(g.TEXTURE_2D, handle);
    // Float filtering is optional in WebGL. The shared shader does bilinear
    // sampling explicitly, so precision support does not depend on that extension.
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, width, height, 0, g.RGBA, g.FLOAT, source ?? null);
    return { width, height, handle, format: 'rgba32float' };
  }
  destroy(t: Texture) {
    this.gl.deleteTexture(t.handle as WebGLTexture);
  }
  coverageTexture(width:number,height:number,source:Float32Array):Texture {
    const g=this.gl,handle=g.createTexture()!;g.bindTexture(g.TEXTURE_2D,handle);
    g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,g.NEAREST);g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,g.NEAREST);
    g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE);g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE);
    g.texImage2D(g.TEXTURE_2D,0,g.R32F,width,height,0,g.RED,g.FLOAT,source);
    return {width,height,handle,format:'r32float'};
  }
  private target(t?: Texture) {
    const g = this.gl;
    if (t?.format === 'rgba32float' && !g.getExtension('EXT_color_buffer_float'))
      throw new Error('32-bit rendering requires floating-point render targets on this GPU.');
    g.bindFramebuffer(g.FRAMEBUFFER, t ? this.framebuffer : null);
    if (t)
      g.framebufferTexture2D(
        g.FRAMEBUFFER,
        g.COLOR_ATTACHMENT0,
        g.TEXTURE_2D,
        t.handle as WebGLTexture,
        0,
      );
    g.viewport(0, 0, t?.width ?? this.canvas.width, t?.height ?? this.canvas.height);
  }
  clear(t: Texture) {
    this.target(t);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }
  pass(back: Texture, source: Texture, mask: Texture, uniforms: Float32Array, target?: Texture, pixelMask?: Texture) {
    const g = this.gl;
    this.target(target);
    // Offscreen GL textures use top-down storage for parity with uploads and WebGPU.
    uniforms[30] = target ? 1 : 0;
    const floating = uniforms[45] > 0.5 || [back, source, mask, target, pixelMask].some((t) => t && t.format !== 'rgba8unorm');
    const resampling = uniforms[22] <= 0.5 && needsRgbaResampling(
      uniforms, back, source, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height,
    );
    const program =
      uniforms[22] > 0.5
        ? (this.colorProgram ??= this.createProgram(glColorFragment))
        : resampling
          ? floating
            ? (this.floatResampleProgram ??= this.createProgram(glFloatResampleFragment))
            : (this.resampleProgram ??= this.createProgram(glResampleFragment))
          : floating
            ? (this.floatProgram ??= this.createProgram(glFloatFragment))
            : this.program;
    g.useProgram(program);
    uniforms[26] = target?.width ?? this.canvas.width;
    uniforms[27] = target?.height ?? this.canvas.height;
    [back, source, mask, pixelMask ?? mask].forEach((t, i) => {
      g.activeTexture(g.TEXTURE0 + i);
      g.bindTexture(g.TEXTURE_2D, t.handle as WebGLTexture);
    });
    // Color conversion uses eight vectors; compositing also has a viewport.
    const data = uniforms[22] > 0.5
      ? uniforms.subarray(0, 32)
      : uniforms.length === UNIFORM_FLOATS ? uniforms : this.compositeUniforms;
    if (data === this.compositeUniforms) {
      data.fill(0);
      data.set(uniforms);
    }
    g.uniform4fv(g.getUniformLocation(program, 'u[0]'), data);
    g.drawArrays(g.TRIANGLES, 0, 3);
  }
  write(t: Texture, x: number, y: number, width: number, height: number, data: Uint8Array | Float32Array) {
    const g = this.gl;
    g.bindTexture(g.TEXTURE_2D, t.handle as WebGLTexture);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    const [format, type] =
      t.format === 'r32float' ? [g.RED, g.FLOAT] : t.format === 'rgba32float' ? [g.RGBA, g.FLOAT] : [g.RGBA, g.UNSIGNED_BYTE];
    g.texSubImage2D(g.TEXTURE_2D, 0, x, y, width, height, format, type, data);
  }
  lutPass(source: Texture, lut: Texture, uniforms: Float32Array, target: Texture) {
    const g = this.gl;
    this.target(target);
    const program = (this.lutProgram ??= (() => {
      const p = this.createProgram(glLutFragment);
      g.uniform1i(g.getUniformLocation(p, 'imageTex'), 0);
      g.uniform1i(g.getUniformLocation(p, 'lutTex'), 1);
      return p;
    })());
    g.useProgram(program);
    [source, lut].forEach((t, i) => {
      g.activeTexture(g.TEXTURE0 + i);
      g.bindTexture(g.TEXTURE_2D, t.handle as WebGLTexture);
    });
    g.uniform4fv(g.getUniformLocation(program, 'u[0]'), uniforms);
    g.drawArrays(g.TRIANGLES, 0, 3);
  }
  colorPass(source: Texture, transform: Texture, target?: Texture, clampRgb = false, tone?: readonly number[]) {
    const u = new Float32Array(32);
    if (tone) u.set(tone, 4);
    u[22] = 1;
    u[23] = clampRgb ? 1 : 0;
    this.pass(transform, source, transform, u, target);
  }
  filterPass(sources: Texture[], uniforms: Float32Array, target: Texture) {
    const g = this.gl;
    this.target(target);
    const program = (this.filterProgram ??= (() => {
      const p = this.createProgram(glFilterFragment);
      ['src0', 'src1', 'src2'].forEach((n, i) => g.uniform1i(g.getUniformLocation(p, n), i));
      return p;
    })());
    g.useProgram(program);
    for (let i = 0; i < 3; i++) {
      g.activeTexture(g.TEXTURE0 + i);
      g.bindTexture(g.TEXTURE_2D, (sources[i] ?? sources[0]).handle as WebGLTexture);
    }
    const data = new Float32Array(16);
    data.set(uniforms.subarray(0, 16));
    g.uniform4fv(g.getUniformLocation(program, 'u[0]'), data);
    g.drawArrays(g.TRIANGLES, 0, 3);
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
    const g = this.gl;
    this.target(t);
    const buffer = g.createBuffer();
    if (!buffer) throw new Error('Could not allocate readback buffer.');
    g.bindBuffer(g.PIXEL_PACK_BUFFER, buffer);
    g.bufferData(g.PIXEL_PACK_BUFFER, t.width * t.height * (floating ? 16 : 4), g.STREAM_READ);
    g.readPixels(0, 0, t.width, t.height, g.RGBA, floating ? g.FLOAT : g.UNSIGNED_BYTE, 0);
    const fence = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0);
    g.flush();
    g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
    try {
      if (!fence) throw new Error('GPU readback failed.');
      await new Promise<void>((resolve, reject) => {
        const started = performance.now();
        const poll = () => {
          const result = g.clientWaitSync(fence, 0, 0);
          if (result === g.WAIT_FAILED || performance.now() - started > 30000)
            reject(new Error('GPU readback timed out.'));
          else if (result === g.TIMEOUT_EXPIRED) setTimeout(poll, 4);
          else resolve();
        };
        poll();
      });
      const data = floating
        ? new Float32Array(t.width * t.height * 4)
        : new Uint8Array(t.width * t.height * 4);
      g.bindBuffer(g.PIXEL_PACK_BUFFER, buffer);
      g.getBufferSubData(g.PIXEL_PACK_BUFFER, 0, data);
      return data;
    } finally {
      g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
      if (fence) g.deleteSync(fence);
      g.deleteBuffer(buffer);
    }
  }
  dispose() {
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteProgram(this.program);
    if (this.floatProgram) this.gl.deleteProgram(this.floatProgram);
    if (this.colorProgram) this.gl.deleteProgram(this.colorProgram);
    if (this.resampleProgram) this.gl.deleteProgram(this.resampleProgram);
    if (this.floatResampleProgram) this.gl.deleteProgram(this.floatResampleProgram);
    if (this.lutProgram) this.gl.deleteProgram(this.lutProgram);
    if (this.filterProgram) this.gl.deleteProgram(this.filterProgram);
  }
}
