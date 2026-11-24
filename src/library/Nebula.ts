/**
 * Public embeddable API.
 *
 * `Nebula` owns one WebGL2 renderer, one canvas and one configuration. It can
 * either run its own animation loop or be driven frame by frame with
 * `render(timeSeconds)`, which is what hosts with an existing render loop want.
 *
 *   const nebula = new Nebula({ container, config, autoStart: false });
 *   nebula.render(0);              // deterministic still frame
 *   nebula.setCamera({ zoom: 1.4 });
 *   nebula.dispose();
 */

import {
  CAMERA_PRESETS,
  cameraPreset,
  cloneCamera,
  normalizeCamera,
  type CameraParameters,
  type CameraPresetId,
} from '../core/Camera';
import {
  ConfigError,
  cloneConfig,
  defaultConfig,
  fromParameters,
  normalizeConfig,
  toParameters,
  type GenerationSettings,
  type NebulaConfig,
  type NebulaConfigInput,
  type RenderingSettings,
} from '../core/Config';
import {
  normalizeParameters,
  type NebulaParameters,
} from '../simulation/Parameters';
import {
  Renderer,
  type RendererCapabilities,
  type RendererStats,
} from '../renderer/Renderer';
import { EventBus } from './EventBus';

export type NebulaErrorCode =
  | 'no-target'
  | 'webgl2-unavailable'
  | 'unknown-camera-preset'
  | 'configuration';

export class NebulaError extends Error {
  readonly code: NebulaErrorCode;

  constructor(code: NebulaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NebulaError';
    this.code = code;
  }
}

export type NebulaConfigLike =
  | NebulaConfig
  | NebulaConfigInput
  | Partial<NebulaParameters>;

export interface NebulaOptions {
  /** Canvas to render into. Required unless `container` is given. */
  canvas?: HTMLCanvasElement;
  /** Element to fill. A canvas is created and appended when `canvas` is absent. */
  container?: HTMLElement;
  /** Initial artwork, rendering settings and camera. Legacy JSON is accepted. */
  config?: NebulaConfigLike;
  /** Start the built-in animation loop. Default `true`. */
  autoStart?: boolean;
  /** Initial playback state. Default `false` (time running). */
  paused?: boolean;
}

export interface NebulaEvents extends Record<string, unknown> {
  /** Renderer initialized. Emitted on a microtask so listeners can attach first. */
  ready: { stats: RendererStats; capabilities: RendererCapabilities };
  /** A recoverable problem (for example the volume shader failing to compile). */
  error: { message: string; error?: unknown };
  /** Configuration or parameters changed through the public API. */
  configurationchange: { config: NebulaConfig; parameters: NebulaParameters };
  /** One frame was drawn. */
  render: { time: number };
  /** Throttled frame statistics. */
  performance: RendererStats;
  contextlost: { time: number };
  contextrestored: { time: number };
}

export class Nebula {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement | null;

  private readonly events = new EventBus<NebulaEvents>();
  private readonly renderer: Renderer;
  private readonly ownsCanvas: boolean;
  private configValue: NebulaConfig;
  private cameraValue: CameraParameters;
  private parametersValue: NebulaParameters;
  private autoStartValue: boolean;
  private disposed = false;
  private readyScheduled = false;

  constructor(options: NebulaOptions = {}) {
    const canvas = options.canvas ?? null;
    const container = options.container ?? null;

    if (canvas) {
      this.canvas = canvas;
      this.container = container;
      this.ownsCanvas = false;
    } else if (container) {
      const created = document.createElement('canvas');
      created.style.display = 'block';
      created.style.width = '100%';
      created.style.height = '100%';
      container.append(created);
      this.canvas = created;
      this.container = container;
      this.ownsCanvas = true;
    } else {
      throw new NebulaError(
        'no-target',
        'Nebula needs a canvas or a container element to render into.',
      );
    }

    let config: NebulaConfig;
    try {
      config = options.config ? normalizeConfig(options.config) : defaultConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new NebulaError('configuration', error.message, { cause: error });
      }
      throw error;
    }

    this.configValue = cloneConfig(config);
    this.cameraValue = cloneCamera(config.camera);
    this.parametersValue = toParameters(config, options.paused ?? false);

    try {
      this.renderer = new Renderer(
        this.canvas,
        this.parametersValue,
        {
          onStats: (stats) => this.events.emit('performance', stats),
          onStatus: (status) => {
            if (status === 'context-lost') {
              this.events.emit('contextlost', { time: this.renderer.getTime() });
            } else if (status === 'restored') {
              this.events.emit('contextrestored', { time: this.renderer.getTime() });
            }
          },
          onError: (message) => this.events.emit('error', { message }),
          onRender: (time) => this.events.emit('render', { time }),
        },
        this.cameraValue,
      );
    } catch (error) {
      this.removeOwnedCanvas();
      throw new NebulaError(
        'webgl2-unavailable',
        error instanceof Error
          ? error.message
          : 'WebGL2 is not available in this browser.',
        { cause: error },
      );
    }

    this.autoStartValue = options.autoStart ?? true;
    if (this.autoStartValue) this.renderer.start();

    this.scheduleReady();
  }

  /** Whether this browser can create a WebGL2 context at all. */
  static isSupported(): boolean {
    if (typeof document === 'undefined') return false;
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  on<K extends keyof NebulaEvents>(
    type: K,
    listener: (payload: NebulaEvents[K]) => void,
  ): () => void {
    return this.events.on(type, listener);
  }

  once<K extends keyof NebulaEvents>(
    type: K,
    listener: (payload: NebulaEvents[K]) => void,
  ): () => void {
    return this.events.once(type, listener);
  }

  off<K extends keyof NebulaEvents>(
    type: K,
    listener: (payload: NebulaEvents[K]) => void,
  ): void {
    this.events.off(type, listener);
  }

  // -------------------------------------------------------------------------
  // configuration
  // -------------------------------------------------------------------------

  /** Replace the configuration. Missing fields reset to their defaults. */
  setConfig(input: NebulaConfigLike): void {
    this.assertLive();
    let config: NebulaConfig;
    try {
      config = normalizeConfig(input);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new NebulaError('configuration', error.message, { cause: error });
      }
      throw error;
    }
    this.applyConfig(config, this.parametersValue.paused);
  }

  getConfig(): NebulaConfig {
    return cloneConfig(this.configValue);
  }

  /**
   * Apply a complete renderer parameter object (the legacy model). The camera
   * is kept as-is, so changing the mode or quality does not reset the view.
   */
  setParameters(parameters: NebulaParameters): void {
    this.assertLive();
    this.parametersValue = normalizeParameters(parameters);
    this.configValue = fromParameters(this.parametersValue, this.cameraValue);
    this.renderer.setParameters(this.parametersValue);
    this.emitConfigurationChange();
  }

  /** Merge fields into the current parameter object. */
  updateParameters(patch: Partial<NebulaParameters>): void {
    this.setParameters({ ...this.parametersValue, ...patch });
  }

  setGeneration(patch: Partial<GenerationSettings>): void {
    this.updateParameters(patch);
  }

  setRendering(patch: Partial<RenderingSettings>): void {
    this.updateParameters(patch);
  }

  getParameters(): NebulaParameters {
    return { ...this.parametersValue };
  }

  // -------------------------------------------------------------------------
  // camera
  // -------------------------------------------------------------------------

  /**
   * Update camera fields. `position: null` selects the built-in slow orbit;
   * omitted fields keep their current value.
   */
  setCamera(patch: Partial<CameraParameters>): void {
    this.assertLive();
    const input: Record<string, unknown> = { ...this.cameraValue };
    if (patch.position !== undefined) input.position = patch.position;
    if (patch.target !== undefined) input.target = patch.target;
    if (patch.fov !== undefined) input.fov = patch.fov;
    if (patch.zoom !== undefined) input.zoom = patch.zoom;

    this.cameraValue = normalizeCamera(input);
    this.renderer.setCamera(this.cameraValue);
    this.configValue = { ...this.configValue, camera: cloneCamera(this.cameraValue) };
    this.emitConfigurationChange();
  }

  getCamera(): CameraParameters {
    return cloneCamera(this.cameraValue);
  }

  /** Return to the framing the demo has always used. */
  resetCamera(): void {
    this.setCamera({ ...CAMERA_PRESETS.default });
  }

  setCameraPreset(id: CameraPresetId): void {
    this.assertLive();
    const preset = cameraPreset(id);
    if (!preset) {
      throw new NebulaError(
        'unknown-camera-preset',
        `Unknown camera preset "${String(id)}". Known presets: ${Object.keys(CAMERA_PRESETS).join(', ')}.`,
      );
    }
    this.setCamera(preset);
  }

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------

  /** Draw one frame for the given shader-time, or redraw at the current time. */
  render(timeSeconds?: number): void {
    this.assertLive();
    if (timeSeconds === undefined) {
      this.renderer.requestRender();
      this.renderer.renderOnce();
    } else {
      this.renderer.renderAt(timeSeconds);
    }
  }

  /** Start the built-in animation loop. */
  start(): void {
    this.assertLive();
    this.autoStartValue = true;
    this.renderer.start();
  }

  /** Stop the built-in animation loop; rendering stays manual. */
  stop(): void {
    this.autoStartValue = false;
    this.renderer.stop();
  }

  get isRunning(): boolean {
    return this.renderer.isRunning;
  }

  /** Whether the internal animation loop is allowed to run. */
  get autoStart(): boolean {
    return this.autoStartValue;
  }

  getTime(): number {
    return this.renderer.getTime();
  }

  /** Development aid: 1 density, 2 cloud, 3 filaments, 4 shape, 5 mask. */
  setDebugView(view: number): void {
    this.assertLive();
    this.renderer.setDebugView(view);
  }

  getStats(): RendererStats {
    return this.renderer.getStats();
  }

  getCapabilities(): RendererCapabilities {
    return this.renderer.getCapabilities();
  }

  get volumeAvailable(): boolean {
    return this.renderer.volumeAvailable;
  }

  // -------------------------------------------------------------------------
  // teardown
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.dispose();
    this.events.clear();
    this.removeOwnedCanvas();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private applyConfig(config: NebulaConfig, paused: boolean): void {
    this.configValue = cloneConfig(config);
    this.cameraValue = cloneCamera(config.camera);
    this.parametersValue = toParameters(config, paused);
    this.renderer.setParameters(this.parametersValue);
    this.renderer.setCamera(this.cameraValue);
    this.emitConfigurationChange();
  }

  private emitConfigurationChange(): void {
    this.events.emit('configurationchange', {
      config: cloneConfig(this.configValue),
      parameters: { ...this.parametersValue },
    });
  }

  private scheduleReady(): void {
    if (this.readyScheduled) return;
    this.readyScheduled = true;
    // Listeners attached synchronously after `new Nebula(...)` still see it.
    queueMicrotask(() => {
      if (this.disposed) return;
      this.events.emit('ready', {
        stats: this.renderer.getStats(),
        capabilities: this.renderer.getCapabilities(),
      });
    });
  }

  private removeOwnedCanvas(): void {
    if (this.ownsCanvas) this.canvas.remove();
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new NebulaError('configuration', 'This Nebula instance has been disposed.');
    }
  }
}
