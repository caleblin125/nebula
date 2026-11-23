/**
 * Frame statistics and GPU timer queries.
 *
 * The timer extension is optional; when it is unavailable the renderer falls
 * back to CPU frame time and says so in the HUD.
 */

export interface FrameStats {
  fps: number;
  frameMs: number;
  gpuMs: number | null;
  gpuTimerAvailable: boolean;
}

interface DisjointTimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: DisjointTimerQueryExtension | null;
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private pending: WebGLQuery[] = [];
  private lastMs = 0;

  readonly available: boolean;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerQueryExtension | null;
    this.available = this.ext !== null;
  }

  begin(): void {
    if (!this.ext || this.active) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Returns the most recent completed timing, or null if none yet. */
  poll(): number | null {
    if (!this.ext) return null;

    // A disjoint event invalidates the timings, but the query objects are still
    // owned by us: pull their results and recycle them instead of deleting them
    // (a deleted query cannot be reused, which spams GL_INVALID_OPERATION).
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;

    while (this.pending.length > 0) {
      const query = this.pending[0];
      const ready = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!ready) break;
      const nanoseconds = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(query);
      if (!disjoint) this.lastMs = nanoseconds / 1e6;
    }

    return disjoint || this.lastMs <= 0 ? null : this.lastMs;
  }

  /** Release query objects on a live context. */
  dispose(): void {
    if (!this.ext) return;
    if (this.active) this.gl.deleteQuery(this.active);
    for (const query of this.pending) this.gl.deleteQuery(query);
    for (const query of this.free) this.gl.deleteQuery(query);
    this.active = null;
    this.pending = [];
    this.free.length = 0;
  }

  /** Drop query handles without touching GL (used after context loss). */
  abandon(): void {
    this.active = null;
    this.pending = [];
    this.free.length = 0;
  }
}

export class PerformanceMonitor {
  private frameEma = 1 / 60;
  private fpsEma = 60;
  private lastFrameStart = 0;
  readonly timer: GpuTimer;
  private lastGpu: number | null = null;
  private pollCounter = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.timer = new GpuTimer(gl);
  }

  markFrameStart(nowMs: number): void {
    if (this.lastFrameStart > 0) {
      const deltaSeconds = Math.min(0.25, Math.max(0.0005, (nowMs - this.lastFrameStart) / 1000));
      const alpha = 0.08;
      this.frameEma += (deltaSeconds - this.frameEma) * alpha;
      this.fpsEma = 1 / Math.max(0.001, this.frameEma);
    }
    this.lastFrameStart = nowMs;
  }

  /** Call after a frame was actually drawn. */
  markFrameRendered(): void {
    this.pollCounter++;
    if (this.pollCounter % 10 === 0) {
      const sample = this.timer.poll();
      if (sample !== null) this.lastGpu = sample;
    }
  }

  reset(): void {
    this.frameEma = 1 / 60;
    this.fpsEma = 60;
    this.lastFrameStart = 0;
    this.lastGpu = null;
  }

  get stats(): FrameStats {
    return {
      fps: this.fpsEma,
      frameMs: this.frameEma * 1000,
      gpuMs: this.lastGpu,
      gpuTimerAvailable: this.timer.available,
    };
  }

  /** Best available frame cost in ms, used by the adaptive controller. */
  get costMs(): number {
    return this.lastGpu ?? this.frameEma * 1000;
  }
}
