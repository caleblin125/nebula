/**
 * Bloom post-process.
 *
 * The scene is rendered into an offscreen colour texture, a bright-pass copy is
 * blurred at quarter resolution, and the result is added back on present. All
 * three stages share one shader program selected by `uPass`.
 *
 * If the framebuffer cannot be completed the pass disables itself and the
 * renderer falls back to drawing straight to the canvas.
 */

import vertexShaderSource from '../shaders/vertex.glsl?raw';
import postFragmentSource from '../shaders/post.frag?raw';

import { FullscreenTriangle } from './FullscreenTriangle';
import { ShaderProgram } from './ShaderProgram';

const BLOOM_DIVISOR = 4;
const THRESHOLD = 0.32;
const STRENGTH = 0.9;
// The volume already self-glows: front-to-back integration builds a broad
// bright core, and the 2D bloom profile would clip all of it to flat white.
// A higher threshold and lower gain leave the nucleus its colour and structure.
const VOLUME_THRESHOLD = 0.52;
const VOLUME_STRENGTH = 0.42;
const BLUR_ITERATIONS = 2;
const BLUR_STEP = 1.4;

interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): Target | null {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) {
    if (texture) gl.deleteTexture(texture);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    return null;
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  if (!complete) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    return null;
  }

  return { framebuffer, texture, width, height };
}

function deleteTarget(gl: WebGL2RenderingContext, target: Target | null): void {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

export class PostFx {
  private readonly gl: WebGL2RenderingContext;
  private readonly triangle: FullscreenTriangle;
  private readonly program: ShaderProgram;

  private scene: Target | null = null;
  private bloomA: Target | null = null;
  private bloomB: Target | null = null;

  private width = 0;
  private height = 0;
  private enabled = true;

  readonly compileReport;

  constructor(gl: WebGL2RenderingContext, triangle: FullscreenTriangle) {
    this.gl = gl;
    this.triangle = triangle;
    this.program = new ShaderProgram(gl, {
      name: 'post-bloom',
      vertex: vertexShaderSource,
      fragment: postFragmentSource,
      includes: {},
    });
    this.compileReport = this.program.report;
  }

  get available(): boolean {
    return this.enabled && this.scene !== null;
  }

  /** Bind the scene target. Returns false when bloom is unavailable. */
  begin(width: number, height: number): boolean {
    if (!this.enabled) return false;
    if (!this.resize(width, height)) return false;
    if (!this.scene) return false;

    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.framebuffer);
    gl.viewport(0, 0, this.scene.width, this.scene.height);
    return true;
  }

  /** Bright pass, blur and composite onto the default framebuffer. */
  present(displayWidth: number, displayHeight: number, volumetric = false): void {
    const { gl, scene, bloomA, bloomB } = this;
    if (!scene || !bloomA || !bloomB) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }

    this.program.use();
    const u = this.program.uniforms;
    u.int('uScene', 0);
    u.int('uBloom', 1);
    u.float('uThreshold', volumetric ? VOLUME_THRESHOLD : THRESHOLD);
    u.float('uStrength', volumetric ? VOLUME_STRENGTH : STRENGTH);

    // Bright extract, scene → bloomA (quarter resolution).
    // Unit 1 still holds the previous frame's bloom texture, which is also this
    // render target; point it at the scene first to avoid a feedback loop.
    this.bindTarget(bloomA);
    u.int('uPass', 0);
    u.vec2('uSceneTexel', 1 / scene.width, 1 / scene.height);
    u.vec2('uDirection', 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    this.draw();

    // Alternating horizontal/vertical blurs; the second iteration widens the
    // halo without the cost of a larger kernel.
    const stepX = BLUR_STEP / bloomA.width;
    const stepY = BLUR_STEP / bloomA.height;
    let source = bloomA;
    for (let i = 0; i < BLUR_ITERATIONS; i++) {
      this.bindTarget(bloomB);
      u.int('uPass', 1);
      u.vec2('uDirection', stepX, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      this.draw();

      this.bindTarget(bloomA);
      u.vec2('uDirection', 0, stepY);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloomB.texture);
      this.draw();

      source = bloomA;
    }

    // Composite to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, displayWidth, displayHeight);
    u.int('uPass', 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.texture);
    this.draw();
  }

  /** Fall back to direct rendering and stay off for this context. */
  disable(reason: string): void {
    if (!this.enabled) return;
    this.enabled = false;
    console.warn(`[nebula] bloom disabled: ${reason}`);
  }

  /** Drop references after context loss without issuing GL calls. */
  abandon(): void {
    this.scene = null;
    this.bloomA = null;
    this.bloomB = null;
    this.width = 0;
    this.height = 0;
  }

  dispose(): void {
    deleteTarget(this.gl, this.scene);
    deleteTarget(this.gl, this.bloomA);
    deleteTarget(this.gl, this.bloomB);
    this.scene = null;
    this.bloomA = null;
    this.bloomB = null;
    this.program.dispose();
  }

  private bindTarget(target: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private draw(): void {
    this.triangle.draw();
  }

  private resize(width: number, height: number): boolean {
    if (width === this.width && height === this.height) return true;

    const gl = this.gl;
    deleteTarget(gl, this.scene);
    deleteTarget(gl, this.bloomA);
    deleteTarget(gl, this.bloomB);
    this.scene = null;
    this.bloomA = null;
    this.bloomB = null;

    const bw = Math.max(1, Math.round(width / BLOOM_DIVISOR));
    const bh = Math.max(1, Math.round(height / BLOOM_DIVISOR));

    this.scene = createTarget(gl, width, height);
    this.bloomA = createTarget(gl, bw, bh);
    this.bloomB = createTarget(gl, bw, bh);

    if (!this.scene || !this.bloomA || !this.bloomB) {
      this.disable('framebuffer incomplete');
      deleteTarget(gl, this.scene);
      deleteTarget(gl, this.bloomA);
      deleteTarget(gl, this.bloomB);
      this.scene = null;
      this.bloomA = null;
      this.bloomB = null;
      return false;
    }

    this.width = width;
    this.height = height;
    return true;
  }
}
