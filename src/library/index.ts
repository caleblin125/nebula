/**
 * Public entry point of the Nebula library.
 *
 * Everything an embedder needs is exported here: the `Nebula` class, the
 * versioned configuration helpers, the camera model and the parameter schema.
 * The demo application is a consumer of this module, not a special case.
 */

export { Nebula, NebulaError } from './Nebula';
export type {
  NebulaConfigLike,
  NebulaErrorCode,
  NebulaEvents,
  NebulaOptions,
} from './Nebula';

export {
  CONFIG_FORMAT,
  CONFIG_VERSION,
  ConfigError,
  cloneConfig,
  defaultConfig,
  fromParameters,
  normalizeConfig,
  parseConfig,
  serializeConfig,
  toParameters,
} from '../core/Config';
export type {
  GenerationSettings,
  NebulaConfig,
  NebulaConfigInput,
  RenderingSettings,
} from '../core/Config';

export {
  CAMERA_PRESETS,
  DEFAULT_CAMERA,
  ORBIT_CAMERA,
  cameraPreset,
  cloneCamera,
  normalizeCamera,
  orbitPosition,
  resolveCamera,
} from '../core/Camera';
export type {
  CameraParameters,
  CameraPresetId,
  ResolvedCamera,
  Vec3,
} from '../core/Camera';

export {
  DEFAULT_PARAMETERS,
  PALETTES,
  cloneParameters,
  formatParameter,
  modeLabel,
  normalizeParameters,
  parseParameters,
  serializeParameters,
} from '../simulation/Parameters';
export type {
  NebulaParameters,
  PaletteDefinition,
  PaletteId,
  RenderMode,
} from '../simulation/Parameters';

export { PRESETS, applyPreset, detectPreset, paletteLabel, presetById } from '../simulation/Presets';
export type { Preset } from '../simulation/Presets';

export type { RendererCapabilities, RendererStats } from '../renderer/Renderer';

export { MAX_SEED, normalizeSeed, randomSeed } from '../utils/Random';
