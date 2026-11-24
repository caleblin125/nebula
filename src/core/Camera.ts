/**
 * Camera state for the volumetric renderer.
 *
 * The camera is deliberately independent of the nebula generation parameters:
 * the same field can be viewed from any angle without changing its structure.
 * `position: null` selects the built-in slow orbit, which preserves the
 * demonstration's original framing.
 */

export type Vec3 = readonly [number, number, number];

export interface CameraParameters {
  /** Eye position. `null` keeps the built-in orbital camera. */
  position: Vec3 | null;
  /** Point the camera looks at. */
  target: Vec3;
  /** Field scale of the view; larger values widen the field of view. */
  fov: number;
  /** Magnification; values above 1 narrow the field of view. */
  zoom: number;
}

export type CameraPresetId = 'default' | 'wide' | 'close' | 'high' | 'side';

/**
 * Constants of the built-in orbit. They reproduce the framing the renderer
 * used before the camera became configurable, so `position: null` stays
 * pixel-stable with earlier versions.
 */
export const ORBIT_CAMERA = {
  baseYaw: 2.3,
  yawRate: 0.012,
  rotationYaw: 0.09,
  radius: 1.88,
  height: 0.18,
  bob: 0.1,
  bobRate: 0.021,
} as const;

export const DEFAULT_CAMERA: CameraParameters = {
  position: null,
  target: [0, 0, 0],
  fov: 0.66,
  zoom: 1,
};

export const CAMERA_PRESETS: Record<CameraPresetId, CameraParameters> = {
  default: { ...DEFAULT_CAMERA },
  wide: { position: [2.7, 0.7, 2.7], target: [0, 0.05, 0], fov: 0.8, zoom: 1 },
  close: { position: [1.35, 0.28, 1.35], target: [0, 0.05, 0], fov: 0.62, zoom: 1 },
  high: { position: [1.6, 2.4, 1.6], target: [0, 0.1, 0], fov: 0.72, zoom: 1 },
  side: { position: [2.8, 0.2, 0.2], target: [0, 0.05, 0], fov: 0.66, zoom: 1 },
};

const FOV_MIN = 0.15;
const FOV_MAX = 1.5;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function maybeVec3(input: unknown): Vec3 | null {
  if (!Array.isArray(input) || input.length !== 3) return null;
  const values = input.map((value) => (typeof value === 'number' ? value : Number.NaN));
  return values.every((value) => Number.isFinite(value)) ? (values as unknown as Vec3) : null;
}

function vec3(input: unknown, fallback: Vec3): Vec3 {
  return maybeVec3(input) ?? fallback;
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return a.every((value, index) => Math.abs(value - b[index]) < 1e-6);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Fill missing fields, clamp ranges and reject non-finite values. */
export function normalizeCamera(input: unknown): CameraParameters {
  const source = (input ?? {}) as Partial<Record<keyof CameraParameters, unknown>>;
  const target = vec3(source.target, DEFAULT_CAMERA.target);
  let position: Vec3 | null = null;
  if (source.position !== null && source.position !== undefined) {
    // A view with no direction (invalid numbers, or an eye on its own target)
    // cannot be rendered; the built-in orbit is the safe interpretation.
    position = maybeVec3(source.position);
    if (position && samePoint(position, target)) position = null;
  }
  return {
    position,
    target,
    fov: clamp(finite(source.fov, DEFAULT_CAMERA.fov), FOV_MIN, FOV_MAX),
    zoom: clamp(finite(source.zoom, DEFAULT_CAMERA.zoom), ZOOM_MIN, ZOOM_MAX),
  };
}

export function cloneCamera(camera: CameraParameters): CameraParameters {
  return {
    ...camera,
    target: [...camera.target] as Vec3,
    position: camera.position ? ([...camera.position] as Vec3) : null,
  };
}

export function cameraPreset(id: string): CameraParameters | undefined {
  if (!(id in CAMERA_PRESETS)) return undefined;
  return cloneCamera(CAMERA_PRESETS[id as CameraPresetId]);
}

/**
 * Eye position of the built-in orbit at a given shader time (seconds already
 * scaled by the animation speed). Rotation nudges the orbit speed, exactly as
 * the original hard-coded shader camera did.
 */
export function orbitPosition(t: number, rotation: number): Vec3 {
  const yaw = ORBIT_CAMERA.baseYaw + t * (ORBIT_CAMERA.yawRate + rotation * ORBIT_CAMERA.rotationYaw);
  return [
    Math.cos(yaw) * ORBIT_CAMERA.radius,
    ORBIT_CAMERA.height + ORBIT_CAMERA.bob * Math.sin(t * ORBIT_CAMERA.bobRate),
    Math.sin(yaw) * ORBIT_CAMERA.radius,
  ];
}

export interface ResolvedCamera {
  position: Vec3;
  target: Vec3;
  /** Effective field scale after zoom. */
  fov: number;
}

/** Turn camera state into the values the shader consumes for one frame. */
export function resolveCamera(
  camera: CameraParameters,
  t: number,
  rotation: number,
): ResolvedCamera {
  return {
    position: camera.position ?? orbitPosition(t, rotation),
    target: camera.target,
    fov: camera.fov / camera.zoom,
  };
}
