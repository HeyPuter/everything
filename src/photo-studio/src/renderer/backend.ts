export interface Texture {
  width: number;
  height: number;
  handle: GPUTexture | WebGLTexture;
  format: 'rgba8unorm' | 'rgba32float' | 'r32float';
}
// Composite pass uniforms (vec4 u[24] in the shaders); see shaders.ts and
// model/blending.ts for the layout of the upper half.
export const UNIFORM_FLOATS = 96;
export interface Backend {
  readonly name: string;
  readonly maxSize: number;
  // Settles when the context or device is lost (not when disposed); the
  // renderer then re-creates the backend.
  readonly lost?: Promise<void>;
  texture(width: number, height: number, source?: ImageBitmap | Uint8Array): Texture;
  floatTexture(width: number, height: number, source?: Float32Array): Texture;
  coverageTexture(width:number,height:number,source:Float32Array):Texture;
  destroy(t: Texture): void;
  clear(t: Texture): void;
  // `tone`: optional 32-bit preview tone mapping (see model/hdr-preview.ts).
  colorPass(source: Texture, transform: Texture, target?: Texture, clampRgb?: boolean, tone?: readonly number[]): void;
  pass(
    back: Texture,
    source: Texture,
    mask: Texture,
    uniforms: Float32Array,
    target?: Texture,
    pixelMask?: Texture,
  ): void;
  // Replace a sub-rectangle of a texture (RGBA8 bytes, or floats for coverage/float textures).
  write(t: Texture, x: number, y: number, width: number, height: number, data: Uint8Array | Float32Array): void;
  // Apply packed adjustment curves/3D table (see lut-shaders.ts) from source into target.
  lutPass(source: Texture, lut: Texture, uniforms: Float32Array, target: Texture): void;
  // Image filter pass for spatial adjustments (see filter-shaders.ts): reads up
  // to three sources (missing ones repeat the first) and writes the target.
  filterPass(sources: Texture[], uniforms: Float32Array, target: Texture): void;
  read(t: Texture): Promise<Uint8Array>;
  readFloat(t: Texture): Promise<Float32Array>;
  dispose(): void;
}
