/**
 * Thin typed wrapper around uniform locations.
 *
 * Values are cached so a parameter panel that writes every frame does not
 * translate into redundant GL calls.
 */

type CachedValue = number | readonly number[];

export class Uniforms {
  private readonly gl: WebGL2RenderingContext;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();
  private readonly cache = new Map<string, CachedValue>();
  private readonly missing = new Set<string>();
  private readonly warned = new Set<string>();

  constructor(
    gl: WebGL2RenderingContext,
    readonly program: WebGLProgram,
  ) {
    this.gl = gl;
  }

  private location(name: string): WebGLUniformLocation | null {
    let location = this.locations.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.program, name);
      this.locations.set(name, location);
    }
    return location;
  }

  private warnOnce(name: string): void {
    if (this.warned.has(name)) return;
    this.warned.add(name);
    console.warn(`[nebula] uniform "${name}" was not found in the shader program.`);
  }

  private same(name: string, value: CachedValue): boolean {
    const previous = this.cache.get(name);
    if (previous === undefined) return false;
    if (typeof previous === 'number' && typeof value === 'number') return previous === value;
    if (Array.isArray(previous) && Array.isArray(value)) {
      if (previous.length !== value.length) return false;
      for (let i = 0; i < previous.length; i++) {
        if (previous[i] !== value[i]) return false;
      }
      return true;
    }
    return false;
  }

  float(name: string, value: number): this {
    const location = this.location(name);
    if (!location) {
      this.warnOnce(name);
      return this;
    }
    if (this.same(name, value)) return this;
    this.cache.set(name, value);
    this.gl.uniform1f(location, value);
    return this;
  }

  int(name: string, value: number): this {
    const location = this.location(name);
    if (!location) {
      this.warnOnce(name);
      return this;
    }
    if (this.same(name, value)) return this;
    this.cache.set(name, value);
    this.gl.uniform1i(location, value);
    return this;
  }

  uint(name: string, value: number): this {
    const location = this.location(name);
    if (!location) {
      this.warnOnce(name);
      return this;
    }
    const normalized = value >>> 0;
    if (this.same(name, normalized)) return this;
    this.cache.set(name, normalized);
    this.gl.uniform1ui(location, normalized);
    return this;
  }

  bool(name: string, value: boolean): this {
    return this.int(name, value ? 1 : 0);
  }

  vec2(name: string, x: number, y: number): this {
    const location = this.location(name);
    if (!location) {
      this.warnOnce(name);
      return this;
    }
    const value = [x, y];
    if (this.same(name, value)) return this;
    this.cache.set(name, value);
    this.gl.uniform2f(location, x, y);
    return this;
  }

  vec3(name: string, x: number, y: number, z: number): this {
    const location = this.location(name);
    if (!location) {
      this.warnOnce(name);
      return this;
    }
    const value = [x, y, z];
    if (this.same(name, value)) return this;
    this.cache.set(name, value);
    this.gl.uniform3f(location, x, y, z);
    return this;
  }

  vec3v(name: string, value: readonly [number, number, number]): this {
    return this.vec3(name, value[0], value[1], value[2]);
  }

  mat3(name: string, value: Float32Array): this {
    const location = this.location(name);
    if (!location) {
      this.warnOnce(name);
      return this;
    }
    this.gl.uniformMatrix3fv(location, false, value);
    return this;
  }

  /** Forget cached values, e.g. after a context restore. */
  invalidate(): void {
    this.cache.clear();
    this.locations.clear();
    this.missing.clear();
    this.warned.clear();
  }

  get missingUniforms(): readonly string[] {
    return [...this.missing];
  }
}
