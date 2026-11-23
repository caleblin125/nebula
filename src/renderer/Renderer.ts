/**
 * Renderer — WebGL2 pipeline, sizing, timing, context recovery.
 *
 * Owns no UI and no animation policy beyond advancing a clock; everything
 * visual is a pure function of `parameters`, `time` and the shader source.
 */

import vertexShaderSource from '../shaders/vertex.glsl?raw';
import nebulaFragmentSource from '../shaders/nebula.frag?raw';
import volumeFragmentSource from '../shaders/volume.frag?raw';
import noiseSource from '../shaders/noise.glsl?raw';
import densitySource from '../shaders/density.glsl?raw';
import colorSource from '../shaders/color.glsl?raw';
import starsSource from '../shaders/stars.glsl?raw';

import { FullscreenTriangle } from './FullscreenTriangle';
import { ShaderProgram, type CompileReport, type ShaderSources } from './ShaderProgram';
import { PerformanceMonitor, type FrameStats } from './PerformanceMonitor';
import { PostFx } from './PostFx';
import {
  PALETTES,
  type NebulaParameters,
  type PaletteId,
  type RenderMode,
} from '../simulation/Parameters';

const INCLUDES: ShaderSources = {
  'noise.glsl': noiseSource,
  'density.glsl': densitySource,
  'color.glsl': colorSource,
  'stars.glsl': starsSource,
};

const MAX_DPR = 2;
const VOLUME_SCALE = 0.72;

export type RendererStatus = 'ready' | 'context-lost' | 'restored';

export interface RendererStats extends FrameStats {
  mode: RenderMode;
  bufferWidth: number;
  bufferHeight: number;
  displayWidth: number;
  displayHeight: number;
  effectiveScale: number;
  noisePerPixel: number;
  compileMs: number;
}

export interface RendererCallbacks {
  onStats?: (stats: RendererStats) => void;
  onStatus?: (status: RendererStatus) => void;
  onError?: (message: string) => void;
}

interface PaletteUniforms {
  stops: Array<readonly [number, number, number]>;
  background: readonly [number, number, number];
}

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function hexToLinear(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [
    srgbChannelToLinear(((value >> 16) & 255) / 255),
    srgbChannelToLinear(((value >> 8) & 255) / 255),
    srgbChannelToLinear((value & 255) / 255),
  ];
}

function buildPalette(id: PaletteId): PaletteUniforms {
  const definition = PALETTES[id];
  return {
    stops: definition.stops.map(hexToLinear),
    background: hexToLinear(definition.background),
  };
}

/** Rough count of gradient-noise evaluations per pixel for the HUD. */
export function estimateNoisePerPixel(parameters: NebulaParameters, mode: RenderMode): number {
  const octaves = Math.max(3, Math.min(9, parameters.octaves));
  if (mode === 'volume') {
    // Warp (1) + base (≤5) + medium (≤3) + conditional ridge (2, ~half).
    const sampleCost = 1 + Math.min(octaves, 5) + Math.min(octaves, 3) + 1;
    // Empty-space stepping means many rays take fewer than uStepCount samples.
    const effectiveSteps = parameters.volumeSteps * 0.55;
    return Math.round(sampleCost * effectiveSteps);
  }
  // Warp (10 octaves) + large (≤5), medium, fine, micro, detail, grain, mask,
  // envelope, clumps, erosion, ridge, second ridge, lace.
  const warp = 10;
  const fields =
    5 + octaves + 3 + 2 + 2 + 2 + 3 + 3 + 3 + 2 + 4 + 3 + 2;
  return warp + fields;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly callbacks: RendererCallbacks;

  private triangle: FullscreenTriangle | null = null;
  private nebulaProgram: ShaderProgram | null = null;
  private volumeProgram: ShaderProgram | null = null;
  private post: PostFx | null = null;
  private monitor: PerformanceMonitor;

  private parameters: NebulaParameters;
  private paletteCacheId: PaletteId | null = null;
  private paletteCache: PaletteUniforms | null = null;

  private time = 0;
  private lastTimestamp = 0;
  private rafId = 0;
  private disposed = false;
  private dirty = true;
  private contextLost = false;

  private displayWidth = 1;
  private displayHeight = 1;
  private bufferWidth = 1;
  private bufferHeight = 1;
  private adaptiveScale = 1;
  private adaptiveCooldown = 0;

  private lastStatsAt = 0;
  private compileReports: CompileReport[] = [];
  private volumeError: string | null = null;
  private debugView = 0;

  private resizeObserver: ResizeObserver | null = null;
  private readonly handleContextLost: (event: Event) => void;
  private readonly handleContextRestored: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    parameters: NebulaParameters,
    callbacks: RendererCallbacks = {},
  ) {
    this.canvas = canvas;
    this.parameters = parameters;
    this.callbacks = callbacks;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      throw new Error(
        'WebGL2 is not available in this browser. The nebula renderer requires WebGL2 and GLSL ES 3.00.',
      );
    }
    this.gl = gl;
    this.monitor = new PerformanceMonitor(gl);

    this.handleContextLost = (event: Event) => {
      event.preventDefault();
      this.contextLost = true;
      this.callbacks.onStatus?.('context-lost');
    };
    this.handleContextRestored = () => {
      this.contextLost = false;
      this.rebuildGL();
      this.callbacks.onStatus?.('restored');
      this.requestRender();
    };

    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);

    this.buildGL();
    this.observeResize();
    this.resize();

    this.rafId = requestAnimationFrame(this.frame);
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  setParameters(next: NebulaParameters): void {
    const modeChanged = next.mode !== this.parameters.mode;
    const scaleChanged = next.renderScale !== this.parameters.renderScale;
    const costChanged =
      next.octaves !== this.parameters.octaves ||
      next.volumeSteps !== this.parameters.volumeSteps ||
      next.adaptiveQuality !== this.parameters.adaptiveQuality;
    this.parameters = next;
    this.dirty = true;

    if (modeChanged || scaleChanged || costChanged) {
      // A new look or quality budget starts from full resolution and adapts
      // down again if it cannot hold the frame budget.
      this.adaptiveScale = 1;
      this.adaptiveCooldown = 24;
      this.resize();
    }
  }

  getParameters(): NebulaParameters {
    return this.parameters;
  }

  getStats(): RendererStats {
    const stats = this.monitor.stats;
    return {
      ...stats,
      mode: this.activeMode(),
      bufferWidth: this.bufferWidth,
      bufferHeight: this.bufferHeight,
      displayWidth: this.displayWidth,
      displayHeight: this.displayHeight,
      effectiveScale: this.effectiveScale(),
      noisePerPixel: estimateNoisePerPixel(this.parameters, this.activeMode()),
      compileMs: this.compileReports.reduce((total, report) => total + report.totalMs, 0),
    };
  }

  getCompileReports(): readonly CompileReport[] {
    return this.compileReports;
  }

  /** Redraw even if the field is paused or static. */
  requestRender(): void {
    this.dirty = true;
  }

  /**
   * Profiling hook: draw exactly one frame synchronously, outside the rAF
   * cadence. The benchmark harness uses it to measure draw cost without a
   * display-refresh cap.
   */
  renderOnce(): void {
    if (this.contextLost || this.disposed) return;
    this.dirty = false;
    this.draw();
    this.monitor.markFrameRendered();
  }

  /** Development aid: 1 density, 2 cloud, 3 filaments, 4 shape, 5 mask. */
  setDebugView(view: number): void {
    this.debugView = Math.max(0, Math.round(view));
    this.dirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.monitor.timer.dispose();
    this.disposeGPUResources();
  }

  // -------------------------------------------------------------------------
  // GL lifecycle
  // -------------------------------------------------------------------------

  private buildGL(): void {
    this.compileReports = [];
    this.volumeError = null;

    this.nebulaProgram = new ShaderProgram(this.gl, {
      name: 'nebula-2d',
      vertex: vertexShaderSource,
      fragment: nebulaFragmentSource,
      includes: INCLUDES,
    });
    this.compileReports.push(this.nebulaProgram.report);

    try {
      this.volumeProgram = new ShaderProgram(this.gl, {
        name: 'nebula-volume',
        vertex: vertexShaderSource,
        fragment: volumeFragmentSource,
        includes: INCLUDES,
      });
      this.compileReports.push(this.volumeProgram.report);
    } catch (error) {
      this.volumeProgram = null;
      this.volumeError = (error as Error).message;
      console.error(this.volumeError);
      this.callbacks.onError?.('Volume shader unavailable — continuing with the 2D renderer.');
    }

    this.triangle = new FullscreenTriangle(this.gl);

    try {
      this.post = new PostFx(this.gl, this.triangle);
      this.compileReports.push(this.post.compileReport);
    } catch (error) {
      this.post = null;
      console.warn('[nebula] bloom unavailable', error);
    }

    this.observeResize();
    this.monitor.reset();
    this.lastStatsAt = 0;

    console.info(
      '[nebula] shaders compiled',
      this.compileReports.map(
        (report) => `${report.name}: ${report.totalMs.toFixed(1)} ms`,
      ),
    );
  }

  private rebuildGL(): void {
    // The old context is gone; every handle is invalid, so drop references
    // without issuing GL calls against them.
    this.monitor.timer.abandon();
    this.monitor = new PerformanceMonitor(this.gl);
    this.post?.abandon();
    this.post = null;
    this.nebulaProgram = null;
    this.volumeProgram = null;
    this.triangle = null;
    this.paletteCacheId = null;
    this.paletteCache = null;
    this.buildGL();
    this.resize();
  }

  private disposeGPUResources(): void {
    this.post?.dispose();
    this.triangle?.dispose();
    this.nebulaProgram?.dispose();
    this.volumeProgram?.dispose();
    this.post = null;
    this.triangle = null;
    this.nebulaProgram = null;
    this.volumeProgram = null;
  }

  // -------------------------------------------------------------------------
  // sizing
  // -------------------------------------------------------------------------

  private observeResize(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  private effectiveScale(): number {
    const pipelineScale = this.parameters.mode === 'volume' ? VOLUME_SCALE : 1;
    return this.parameters.renderScale * pipelineScale * this.adaptiveScale;
  }

  private resize(): void {
    if (this.contextLost) return;

    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width || this.canvas.clientWidth);
    const cssHeight = Math.max(1, rect.height || this.canvas.clientHeight);
    this.displayWidth = cssWidth;
    this.displayHeight = cssHeight;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const scale = this.effectiveScale();
    const width = Math.max(1, Math.round(cssWidth * dpr * scale));
    const height = Math.max(1, Math.round(cssHeight * dpr * scale));

    if (width === this.bufferWidth && height === this.bufferHeight) {
      this.dirty = true;
      return;
    }

    this.bufferWidth = width;
    this.bufferHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // frame loop
  // -------------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.frame);
    this.monitor.markFrameStart(now);

    if (this.contextLost) return;

    const delta = this.lastTimestamp > 0 ? (now - this.lastTimestamp) / 1000 : 0;
    this.lastTimestamp = now;
    const animated = !this.parameters.paused && this.parameters.animationSpeed > 0.0001;
    if (animated) {
      this.time += Math.min(0.1, Math.max(0, delta));
    }

    const shouldDraw = animated || this.dirty;
    if (!shouldDraw) return;

    this.dirty = false;
    this.draw();
    this.monitor.markFrameRendered();
    this.maybeAdaptQuality();
    this.maybeDispatchStats(now);
  };

  private activeMode(): RenderMode {
    return this.parameters.mode === 'volume' && this.volumeProgram ? 'volume' : '2d';
  }

  private draw(): void {
    const gl = this.gl;
    const mode = this.activeMode();
    const program = mode === 'volume' ? this.volumeProgram : this.nebulaProgram;
    if (!program) return;

    this.monitor.timer.begin();

    // Debug views stay unbloomed so they remain readable as data.
    const bloomed = this.debugView === 0 && (this.post?.begin(this.bufferWidth, this.bufferHeight) ?? false);
    if (!bloomed) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.bufferWidth, this.bufferHeight);
    }

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    program.use();
    this.applyUniforms(program);
    this.triangle?.draw();

    if (bloomed) this.post?.present(this.bufferWidth, this.bufferHeight, mode === 'volume');
    this.monitor.timer.end();
  }

  private paletteFor(id: PaletteId): PaletteUniforms {
    if (this.paletteCacheId !== id || !this.paletteCache) {
      this.paletteCache = buildPalette(id);
      this.paletteCacheId = id;
    }
    return this.paletteCache;
  }

  private applyUniforms(program: ShaderProgram): void {
    const p = this.parameters;
    const u = program.uniforms;
    const palette = this.paletteFor(p.palette);

    u.uint('uSeed', p.seed);
    u.float('uDensity', p.density);
    u.float('uScale', p.scale);
    u.float('uWarp', p.warp);
    u.int('uOctaves', Math.round(p.octaves));
    u.float('uDetail', p.detail);
    u.float('uLacunarity', p.lacunarity);
    u.float('uPersistence', p.persistence);
    u.float('uRotation', p.rotation);
    u.float('uAnimationSpeed', p.animationSpeed);
    u.float('uTime', this.time);

    u.float('uEmission', p.emission);
    u.float('uExposure', p.exposure);
    u.float('uVignette', p.vignette);
    u.float('uStarDensity', p.starDensity);
    if (this.activeMode() === 'volume') {
      u.int('uStepCount', Math.round(p.volumeSteps));
    } else {
      u.int('uDebugView', this.debugView);
    }

    u.vec2('uResolution', this.bufferWidth, this.bufferHeight);

    const [c0, c1, c2, c3, c4] = palette.stops;
    u.vec3v('uColor0', c0);
    u.vec3v('uColor1', c1);
    u.vec3v('uColor2', c2);
    u.vec3v('uColor3', c3);
    u.vec3v('uColor4', c4);
    u.vec3v('uBackground', palette.background);
  }

  // -------------------------------------------------------------------------
  // adaptive quality & reporting
  // -------------------------------------------------------------------------

  private maybeAdaptQuality(): void {
    if (!this.parameters.adaptiveQuality) {
      if (this.adaptiveScale !== 1) {
        this.adaptiveScale = 1;
        this.resize();
      }
      return;
    }
    if (this.adaptiveCooldown > 0) {
      this.adaptiveCooldown--;
      return;
    }

    const stats = this.monitor.stats;
    const gpuMs = stats.gpuTimerAvailable ? stats.gpuMs : null;

    // With a GPU timer the controller has a true cost signal and can recover
    // resolution when there is headroom. Without one, frame time is vsync
    // capped, so upscaling would oscillate; it only scales down and waits for
    // a parameter change to reset.
    const cost = gpuMs ?? stats.frameMs;
    const downAt = gpuMs !== null ? 21 : 22;
    const upAt = gpuMs !== null ? 11 : 0;

    let changed = false;
    if (cost > downAt && this.adaptiveScale > 0.55) {
      // Solve for the scale that would land on the target cost, so a heavy
      // frame converges in one or two steps instead of crawling down by 7%.
      const target = this.adaptiveScale * Math.sqrt(downAt / cost);
      this.adaptiveScale = Math.max(0.55, Math.min(this.adaptiveScale - 0.02, target));
      changed = true;
      this.adaptiveCooldown = 30;
    } else if (upAt > 0 && cost < upAt && this.adaptiveScale < 1) {
      this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.035);
      changed = true;
      this.adaptiveCooldown = 40;
    }

    if (changed) this.resize();
  }

  private maybeDispatchStats(now: number): void {
    if (!this.callbacks.onStats) return;
    if (now - this.lastStatsAt < 200) return;
    this.lastStatsAt = now;
    this.callbacks.onStats(this.getStats());
  }

  get volumeAvailable(): boolean {
    return this.volumeProgram !== null;
  }

  get volumeFailure(): string | null {
    return this.volumeError;
  }
}
