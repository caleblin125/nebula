/**
 * Parameter model for the nebula.
 *
 * The renderer only ever consumes `NebulaParameters`. The UI, presets and
 * import/export all speak the same object, which keeps the simulation model
 * decoupled from the rendering interface.
 */

import { normalizeSeed } from '../utils/Random';

export type PaletteId = 'orion' | 'carina' | 'veil' | 'ember' | 'violet' | 'ice';
export type RenderMode = '2d' | 'volume';

export interface PaletteDefinition {
  label: string;
  /** Five stops, from faint outer gas to bright ionized cores (sRGB hex). */
  stops: [string, string, string, string, string];
  /** Deep space background tint. */
  background: string;
  /** UI accent. */
  accent: string;
}

export const PALETTES: Record<PaletteId, PaletteDefinition> = {
  orion: {
    label: 'Orion',
    stops: ['#12325e', '#1f6ea8', '#54c3d4', '#9a73e8', '#ffd2e0'],
    background: '#04070f',
    accent: '#7cc7ff',
  },
  carina: {
    label: 'Carina',
    stops: ['#3a1220', '#7d2238', '#b9415c', '#f08a63', '#ffe3c4'],
    background: '#0a0406',
    accent: '#ff9a8a',
  },
  veil: {
    label: 'Veil',
    stops: ['#0c2c33', '#155b60', '#3aa89b', '#9fdcb7', '#f2ffe9'],
    background: '#03090a',
    accent: '#6fe3c4',
  },
  ember: {
    label: 'Ember',
    stops: ['#2a0d0a', '#6b2318', '#bd5228', '#e9a25e', '#fff0d2'],
    background: '#070403',
    accent: '#ffb070',
  },
  violet: {
    label: 'Violet',
    stops: ['#1b1040', '#402380', '#7048c8', '#bb78e2', '#ffd9f5'],
    background: '#060410',
    accent: '#c79bff',
  },
  ice: {
    label: 'Ice',
    stops: ['#16304a', '#285f83', '#4f9fc4', '#a7d7ea', '#ffffff'],
    background: '#02070d',
    accent: '#a9dcff',
  },
};

export interface NebulaParameters {
  // Structure
  seed: number;
  density: number;
  scale: number;
  warp: number;
  octaves: number;
  detail: number;
  lacunarity: number;
  persistence: number;
  rotation: number;

  // Light
  emission: number;
  exposure: number;
  palette: PaletteId;
  starDensity: number;
  vignette: number;

  // Motion
  animationSpeed: number;
  paused: boolean;

  // Pipeline
  mode: RenderMode;
  renderScale: number;
  adaptiveQuality: boolean;
  volumeSteps: number;
}

export const DEFAULT_PARAMETERS: NebulaParameters = {
  seed: 7341,
  density: 1.0,
  scale: 1.45,
  warp: 0.85,
  octaves: 6,
  detail: 0.65,
  lacunarity: 2.02,
  persistence: 0.5,
  rotation: 0,
  emission: 1.1,
  exposure: 1.0,
  palette: 'orion',
  starDensity: 0.42,
  vignette: 0.5,
  animationSpeed: 0.35,
  paused: false,
  mode: '2d',
  renderScale: 1,
  adaptiveQuality: true,
  volumeSteps: 56,
};

type NumberKeys<T> = {
  [K in keyof T]: T[K] extends number ? K : never;
}[keyof T];
type BooleanKeys<T> = {
  [K in keyof T]: T[K] extends boolean ? K : never;
}[keyof T];

export type NumericParameter = NumberKeys<NebulaParameters>;
export type BooleanParameter = BooleanKeys<NebulaParameters>;

export interface RangeControl {
  key: NumericParameter;
  label: string;
  min: number;
  max: number;
  step: number;
  digits?: number;
  suffix?: string;
}

/** Controls requested by the brief, in order of visual importance. */
export const PRIMARY_CONTROLS: readonly RangeControl[] = [
  { key: 'density', label: 'Density', min: 0.15, max: 1.8, step: 0.01, digits: 2 },
  { key: 'scale', label: 'Cloud scale', min: 0.55, max: 4.0, step: 0.01, digits: 2 },
  { key: 'warp', label: 'Warp strength', min: 0, max: 2.0, step: 0.01, digits: 2 },
  { key: 'octaves', label: 'Octaves', min: 3, max: 9, step: 1, digits: 0 },
  { key: 'emission', label: 'Emission', min: 0.2, max: 2.6, step: 0.01, digits: 2 },
  {
    key: 'animationSpeed',
    label: 'Animation speed',
    min: 0,
    max: 1.5,
    step: 0.01,
    digits: 2,
    suffix: '×',
  },
];

export const ADVANCED_CONTROLS: readonly RangeControl[] = [
  { key: 'detail', label: 'Filament detail', min: 0, max: 1, step: 0.01, digits: 2 },
  { key: 'rotation', label: 'Rotation', min: -0.6, max: 0.6, step: 0.01, digits: 2 },
  { key: 'lacunarity', label: 'Lacunarity', min: 1.7, max: 2.3, step: 0.01, digits: 2 },
  { key: 'persistence', label: 'Persistence', min: 0.32, max: 0.68, step: 0.005, digits: 3 },
  { key: 'exposure', label: 'Exposure', min: 0.35, max: 2.2, step: 0.01, digits: 2 },
  { key: 'starDensity', label: 'Stars', min: 0, max: 1, step: 0.01, digits: 2 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, digits: 2 },
  { key: 'renderScale', label: 'Render scale', min: 0.4, max: 1, step: 0.05, digits: 2 },
  { key: 'volumeSteps', label: 'Volume steps', min: 24, max: 96, step: 1, digits: 0 },
];

const NUMERIC_BOUNDS: Record<NumericParameter, [number, number]> = {
  seed: [1, 999999],
  density: [0.15, 1.8],
  scale: [0.55, 4],
  warp: [0, 2],
  octaves: [3, 9],
  detail: [0, 1],
  lacunarity: [1.7, 2.3],
  persistence: [0.32, 0.68],
  rotation: [-0.6, 0.6],
  emission: [0.2, 2.6],
  exposure: [0.35, 2.2],
  starDensity: [0, 1],
  vignette: [0, 1],
  animationSpeed: [0, 1.5],
  renderScale: [0.4, 1],
  volumeSteps: [24, 96],
};

const INTEGER_KEYS = new Set<NumericParameter>(['seed', 'octaves', 'volumeSteps']);

const PARAMETER_KEYS = Object.keys(DEFAULT_PARAMETERS) as (keyof NebulaParameters)[];

export function clampParameter<K extends NumericParameter>(
  key: K,
  value: number,
): NebulaParameters[K] {
  const [min, max] = NUMERIC_BOUNDS[key];
  let next = Number.isFinite(value) ? value : DEFAULT_PARAMETERS[key];
  if (INTEGER_KEYS.has(key)) next = Math.round(next);
  next = Math.min(max, Math.max(min, next));
  return next as NebulaParameters[K];
}

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && value in PALETTES;
}

/** Fill missing fields from defaults and clamp everything into range. */
export function normalizeParameters(input: unknown): NebulaParameters {
  const source = (input ?? {}) as Partial<Record<keyof NebulaParameters, unknown>>;
  const result = { ...DEFAULT_PARAMETERS };

  for (const key of PARAMETER_KEYS) {
    const value = source[key];
    if (value === undefined) continue;

    if (key === 'palette') {
      if (isPaletteId(value)) result.palette = value;
      continue;
    }
    if (key === 'mode') {
      if (value === '2d' || value === 'volume') result.mode = value;
      continue;
    }
    if (key === 'paused' || key === 'adaptiveQuality') {
      if (typeof value === 'boolean') {
        (result as unknown as Record<string, unknown>)[key] = value;
      } else if (value === 'true' || value === 'false') {
        (result as unknown as Record<string, unknown>)[key] = value === 'true';
      }
      continue;
    }
    if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        (result as unknown as Record<string, number>)[key] = clampParameter(
          key as NumericParameter,
          numeric,
        );
      }
    }
  }

  result.seed = normalizeSeed(result.seed);
  return result;
}

/** Always emit every known field, so imports are self-describing. */
export function serializeParameters(parameters: NebulaParameters): string {
  return JSON.stringify(
    {
      format: 'nebula-parameters',
      version: 1,
      parameters,
    },
    null,
    2,
  );
}

/** Accepts either the export envelope or a bare parameter object. */
export function parseParameters(text: string): NebulaParameters {
  const parsed: unknown = JSON.parse(text);
  if (parsed && typeof parsed === 'object' && 'parameters' in parsed) {
    return normalizeParameters((parsed as { parameters: unknown }).parameters);
  }
  return normalizeParameters(parsed);
}

export function cloneParameters(parameters: NebulaParameters): NebulaParameters {
  return { ...parameters };
}

export function formatParameter(control: RangeControl, value: number): string {
  const digits = control.digits ?? 2;
  const formatted = value.toFixed(digits);
  return control.suffix ? `${formatted}${control.suffix}` : formatted;
}

/** Human-readable name for a mode, used by the HUD. */
export function modeLabel(mode: RenderMode): string {
  return mode === 'volume' ? '3D volume' : '2D field';
}
