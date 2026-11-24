/**
 * Versioned configuration for an embedded nebula.
 *
 * Generation, rendering and camera are separate concerns: the same seed and
 * density field can be rendered in 2D or as a volume, at any quality, from any
 * camera. `paused` is deliberately not part of the configuration — it is host
 * playback state, not part of the artwork.
 *
 * Legacy exports from the application (`nebula-parameters` envelopes and bare
 * parameter objects) are accepted and upgraded on import.
 */

import {
  DEFAULT_CAMERA,
  cloneCamera,
  normalizeCamera,
  type CameraParameters,
} from './Camera';
import {
  DEFAULT_PARAMETERS,
  normalizeParameters,
  type NebulaParameters,
  type PaletteId,
  type RenderMode,
} from '../simulation/Parameters';

export const CONFIG_FORMAT = 'nebula-config';
export const CONFIG_VERSION = 1 as const;

/** Structural appearance of the field. */
export interface GenerationSettings {
  density: number;
  scale: number;
  warp: number;
  octaves: number;
  detail: number;
  lacunarity: number;
  persistence: number;
  rotation: number;
  palette: PaletteId;
}

/** How the field is lit, animated and rendered. */
export interface RenderingSettings {
  mode: RenderMode;
  renderScale: number;
  adaptiveQuality: boolean;
  volumeSteps: number;
  emission: number;
  exposure: number;
  starDensity: number;
  vignette: number;
  animationSpeed: number;
}

export interface NebulaConfig {
  format: typeof CONFIG_FORMAT;
  version: typeof CONFIG_VERSION;
  seed: number;
  generation: GenerationSettings;
  rendering: RenderingSettings;
  camera: CameraParameters;
}

/** Loose input shape accepted by {@link normalizeConfig}. */
export interface NebulaConfigInput {
  seed?: number;
  generation?: Partial<GenerationSettings>;
  rendering?: Partial<RenderingSettings>;
  camera?: Partial<CameraParameters> | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function fromParameters(
  parameters: NebulaParameters,
  camera: CameraParameters = DEFAULT_CAMERA,
): NebulaConfig {
  const p = normalizeParameters({ ...parameters, paused: false });
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    seed: p.seed,
    generation: {
      density: p.density,
      scale: p.scale,
      warp: p.warp,
      octaves: p.octaves,
      detail: p.detail,
      lacunarity: p.lacunarity,
      persistence: p.persistence,
      rotation: p.rotation,
      palette: p.palette,
    },
    rendering: {
      mode: p.mode,
      renderScale: p.renderScale,
      adaptiveQuality: p.adaptiveQuality,
      volumeSteps: p.volumeSteps,
      emission: p.emission,
      exposure: p.exposure,
      starDensity: p.starDensity,
      vignette: p.vignette,
      animationSpeed: p.animationSpeed,
    },
    camera: normalizeCamera(camera),
  };
}

export function defaultConfig(): NebulaConfig {
  return fromParameters(DEFAULT_PARAMETERS, DEFAULT_CAMERA);
}

/**
 * Flatten a configuration (of any supported version) into the renderer's
 * parameter model. The caller supplies playback state, which the configuration
 * does not own.
 */
export function toParameters(config: NebulaConfig, paused = false): NebulaParameters {
  const c = normalizeConfig(config);
  return normalizeParameters({
    seed: c.seed,
    ...c.generation,
    ...c.rendering,
    paused,
  });
}

/**
 * Fill missing fields, clamp ranges and upgrade legacy shapes.
 *
 * Accepts the versioned envelope, a legacy `nebula-parameters` envelope, or a
 * bare parameter object. A version newer than this build is rejected rather
 * than half-imported.
 */
export function normalizeConfig(input: unknown): NebulaConfig {
  if (input === undefined || input === null) return defaultConfig();
  if (!isRecord(input)) throw new ConfigError('Configuration must be a JSON object.');

  if (typeof input.version === 'number' && input.version > CONFIG_VERSION) {
    throw new ConfigError(
      `Unsupported configuration version ${input.version}; this build understands version ${CONFIG_VERSION} and earlier.`,
    );
  }

  const generation = record(input.generation);
  const rendering = record(input.rendering);
  const legacy = record(input.parameters);

  const structured = isRecord(input.generation) || isRecord(input.rendering);
  let flat: Record<string, unknown>;
  if (structured) {
    flat = { ...generation, ...rendering };
  } else if (isRecord(input.parameters)) {
    flat = { ...legacy };
  } else {
    // A bare parameter object from the original app, or a flat partial config.
    flat = { ...input };
  }

  // The top-level seed is authoritative; legacy envelopes kept it inside the
  // parameter bag, so fall back to that.
  const seed = input.seed ?? generation.seed ?? legacy.seed;
  if (seed !== undefined) flat.seed = seed;

  const parameters = normalizeParameters(flat);
  const camera = normalizeCamera(input.camera);
  return fromParameters(parameters, camera);
}

export function serializeConfig(config: NebulaConfig): string {
  return JSON.stringify(normalizeConfig(config), null, 2);
}

export function parseConfig(text: string): NebulaConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeConfig(parsed);
}

export function cloneConfig(config: NebulaConfig): NebulaConfig {
  return {
    ...config,
    generation: { ...config.generation },
    rendering: { ...config.rendering },
    camera: cloneCamera(config.camera),
  };
}
