/**
 * Curated parameter sets. Each preset is a complete look: a seed plus the
 * structural and lighting values that make that composition work.
 */

import {
  DEFAULT_PARAMETERS,
  PALETTES,
  type NebulaParameters,
  type PaletteId,
} from './Parameters';

export interface Preset {
  id: string;
  label: string;
  note: string;
  parameters: Partial<NebulaParameters>;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'orion-deep',
    label: 'Orion Deep',
    note: 'Wide blue clouds with a cold cyan veil',
    parameters: {
      seed: 7341,
      density: 0.96,
      scale: 1.45,
      warp: 0.82,
      octaves: 6,
      detail: 0.62,
      palette: 'orion',
      emission: 1.08,
      starDensity: 0.44,
      vignette: 0.52,
    },
  },
  {
    id: 'carina-core',
    label: 'Carina Core',
    note: 'Dense warm core wrapped in dust',
    parameters: {
      seed: 23117,
      density: 1.24,
      scale: 1.18,
      warp: 0.72,
      octaves: 7,
      detail: 0.8,
      palette: 'carina',
      emission: 1.3,
      starDensity: 0.3,
      vignette: 0.6,
      rotation: 0.03,
    },
  },
  {
    id: 'veil-filaments',
    label: 'Veil Filaments',
    note: 'Thin teal tendrils in negative space',
    parameters: {
      seed: 48029,
      density: 0.78,
      scale: 1.72,
      warp: 1.08,
      octaves: 7,
      detail: 0.95,
      palette: 'veil',
      emission: 1.22,
      starDensity: 0.5,
      vignette: 0.42,
      rotation: -0.05,
    },
  },
  {
    id: 'cold-drift',
    label: 'Cold Drift',
    note: 'Faint ice haze, very little light',
    parameters: {
      seed: 1187,
      density: 0.72,
      scale: 0.96,
      warp: 0.5,
      octaves: 5,
      detail: 0.38,
      palette: 'ice',
      emission: 0.72,
      starDensity: 0.62,
      vignette: 0.66,
    },
  },
  {
    id: 'ember-bloom',
    label: 'Ember Bloom',
    note: 'Hot ionized core inside dark dust',
    parameters: {
      seed: 65521,
      density: 1.34,
      scale: 1.36,
      warp: 0.94,
      octaves: 6,
      detail: 0.86,
      palette: 'ember',
      emission: 1.45,
      starDensity: 0.24,
      vignette: 0.58,
      rotation: 0.06,
    },
  },
  {
    id: 'violet-hollow',
    label: 'Violet Hollow',
    note: 'Sparse magenta shells around a void',
    parameters: {
      seed: 90210,
      density: 0.7,
      scale: 2.1,
      warp: 1.22,
      octaves: 8,
      detail: 0.74,
      palette: 'violet',
      emission: 1.05,
      starDensity: 0.55,
      vignette: 0.5,
      rotation: -0.08,
    },
  },
];

/** Pipeline settings that should survive a look change. */
const PIPELINE_KEYS = [
  'mode',
  'renderScale',
  'adaptiveQuality',
  'volumeSteps',
  'paused',
] as const;

export function applyPreset(
  current: NebulaParameters,
  preset: Preset,
): NebulaParameters {
  const next: NebulaParameters = { ...DEFAULT_PARAMETERS, ...preset.parameters };
  for (const key of PIPELINE_KEYS) {
    // Keep the chosen renderer/quality when swapping the artwork.
    (next as unknown as Record<string, unknown>)[key] = current[key];
  }
  return next;
}

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** Match the current parameters against presets for the dropdown label. */
export function detectPreset(parameters: NebulaParameters): string {
  for (const preset of PRESETS) {
    const candidate = { ...DEFAULT_PARAMETERS, ...preset.parameters };
    if (candidate.seed !== parameters.seed) continue;
    const keys = Object.keys(preset.parameters) as (keyof NebulaParameters)[];
    if (keys.every((key) => candidate[key] === parameters[key])) return preset.id;
  }
  return 'custom';
}

export function paletteLabel(id: PaletteId): string {
  return PALETTES[id].label;
}
