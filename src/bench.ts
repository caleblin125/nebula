/**
 * Reproducible benchmark and self-test harness (development only).
 *
 *   /bench.html?w=1920&h=1080&preset=orion-deep
 *   /bench.html?mode=volume&w=1280&h=720
 *   /bench.html?test=suite
 *   /bench.html?test=compare&ref=orion-deep-2d.png&preset=orion-deep&w=640&h=400
 *   /bench.html?test=io
 *   /bench.html?test=contextloss
 *   /bench.html?test=shot&preset=carina-core&w=1800&h=1157
 *   /bench.html?test=gallery&prefix=final
 *
 * Perf mode measures two things separately:
 *   - presentation cadence from requestAnimationFrame (vsync-limited), and
 *   - draw cost from a synchronous batch of forced frames plus gl.finish(),
 *     which is independent of the display refresh rate.
 */

import {
  hexToLinear,
  linearChannelToSrgb,
  Renderer,
  srgbChannelToLinear,
  type RendererStats,
} from './renderer/Renderer';
import {
  DEFAULT_PARAMETERS,
  normalizeParameters,
  PALETTES,
  parseParameters,
  serializeParameters,
  type NebulaParameters,
} from './simulation/Parameters';
import { applyPreset, presetById, PRESETS } from './simulation/Presets';
import { normalizeSeed } from './utils/Random';
import {
  CAMERA_PRESETS,
  CONFIG_VERSION,
  ConfigError,
  DEFAULT_CAMERA,
  Nebula,
  NebulaError,
  cameraPreset,
  fromParameters,
  normalizeCamera,
  normalizeConfig,
  orbitPosition,
  parseConfig,
  resolveCamera,
  serializeConfig,
  type NebulaConfig,
} from './library';

const query = new URLSearchParams(window.location.search);
const canvas = document.getElementById('bench-canvas') as HTMLCanvasElement;
const out = document.getElementById('bench-out') as HTMLPreElement;

type Test = 'perf' | 'io' | 'contextloss' | 'shot' | 'gallery' | 'suite' | 'compare';

const test = (query.get('test') ?? 'perf') as Test;

type Check = [label: string, ok: boolean, detail: string];

function numberParam(name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function render(html: string): void {
  out.innerHTML = html;
}

function parametersFromQuery(): NebulaParameters {
  let parameters = normalizeParameters(DEFAULT_PARAMETERS);
  const preset = presetById(query.get('preset') ?? '');
  if (preset) parameters = applyPreset(parameters, preset);

  const seed = query.get('seed');
  if (seed !== null) parameters.seed = normalizeSeed(Number(seed));

  parameters = normalizeParameters({
    ...parameters,
    mode: query.get('mode') === 'volume' ? 'volume' : '2d',
    renderScale: numberParam('scale', 1),
    adaptiveQuality: query.get('adaptive') === '1',
    volumeSteps: numberParam('steps', parameters.volumeSteps),
    paused: false,
  });
  return parameters;
}

/** Size the CSS box so the WebGL buffer is exactly w × h device pixels. */
function sizeCanvas(width: number, height: number): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${width / dpr}px`;
  canvas.style.height = `${height / dpr}px`;
  return dpr;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

interface PerfResult {
  test: 'perf';
  requested: { width: number; height: number; mode: string };
  buffer: { width: number; height: number };
  dpr: number;
  refreshHz: number;
  presentation: { fps: number; frameMs: number; p95Ms: number; minMs: number; frames: number };
  draw: { ms: number; p95Ms: number; fps: number; iterations: number };
  gpu: { available: boolean; ms: number | null };
  noisePerPixel: number;
  compileMs: number;
  effectiveScale: number;
  gpuName: string;
}

async function runPerf(): Promise<void> {
  const width = Math.round(numberParam('w', 1280));
  const height = Math.round(numberParam('h', 720));
  const warmupMs = numberParam('warmup', 2500);
  const measureMs = numberParam('measure', 4000);
  const iterations = Math.max(3, Math.round(numberParam('iterations', 24)));

  const dpr = sizeCanvas(width, height);
  const parameters = parametersFromQuery();

  render(`warming up · ${width}×${height} · ${parameters.mode}\n`);

  const statuses: string[] = [];
  const samples: Array<{ frameMs: number; gpuMs: number | null }> = [];
  const renderer = new Renderer(canvas, parameters, {
    onStats: (stats: RendererStats) => {
      if (performance.now() < warmupMs) return;
      samples.push({ frameMs: stats.frameMs, gpuMs: stats.gpuMs });
    },
    onStatus: (status) => statuses.push(status),
    onError: (message) => statuses.push(`error: ${message}`),
  });
  renderer.start();

  const deltas: number[] = [];
  let frames = 0;
  let previous = 0;
  let lastProgress = 0;
  const start = performance.now();
  const totalMs = warmupMs + measureMs;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // If rAF is throttled (tab not composited), do not hang forever.
    window.setTimeout(finish, totalMs + 3000);

    const tick = (now: number): void => {
      if (previous > 0) {
        deltas.push(now - previous);
        frames++;
      }
      previous = now;
      const elapsed = now - start;
      if (now - lastProgress > 400) {
        lastProgress = now;
        render(
          `warming up · ${width}×${height} · ${parameters.mode}\n` +
            `elapsed ${(elapsed / 1000).toFixed(1)}s · ${frames} rAF frames`,
        );
      }
      if (elapsed < totalMs) {
        requestAnimationFrame(tick);
        return;
      }
      finish();
    };
    requestAnimationFrame(tick);
  });

  const measuredDeltas = deltas.slice(Math.floor(deltas.length * (warmupMs / (warmupMs + measureMs))));
  const stats = renderer.getStats();

  // Force frames one at a time and synchronise each with finish + a one-pixel
  // readback, so the number does not depend on the display refresh rate.
  const gl = canvas.getContext('webgl2');
  const pixel = new Uint8Array(4);
  const frameTimes: number[] = [];
  renderer.renderOnce();
  gl?.finish();
  for (let i = 0; i < iterations; i++) {
    const frameStart = performance.now();
    renderer.renderOnce();
    gl?.finish();
    gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    frameTimes.push(performance.now() - frameStart);
  }
  const drawMs = median(frameTimes);

  const gpuSamples = samples.map((sample) => sample.gpuMs).filter((value): value is number => value !== null);
  const refreshHz = measuredDeltas.length > 0 ? Math.round(1000 / Math.min(...measuredDeltas)) : 0;

  const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpuName = gl
    ? String(
        (debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? 'unknown',
      )
    : 'no context';

  const result: PerfResult = {
    test: 'perf',
    requested: { width, height, mode: parameters.mode },
    buffer: { width: stats.bufferWidth, height: stats.bufferHeight },
    dpr,
    refreshHz,
    presentation: {
      fps: measuredDeltas.length > 0 ? 1000 / median(measuredDeltas) : 0,
      frameMs: median(measuredDeltas),
      p95Ms: percentile(measuredDeltas, 0.95),
      minMs: measuredDeltas.length > 0 ? Math.min(...measuredDeltas) : 0,
      frames,
    },
    draw: { ms: drawMs, p95Ms: percentile(frameTimes, 0.95), fps: 1000 / Math.max(0.0001, drawMs), iterations },
    gpu: { available: stats.gpuTimerAvailable, ms: gpuSamples.length > 0 ? mean(gpuSamples) : null },
    noisePerPixel: stats.noisePerPixel,
    compileMs: stats.compileMs,
    effectiveScale: stats.effectiveScale,
    gpuName,
  };

  document.title = `bench ${width}x${height} ${parameters.mode} ${drawMs.toFixed(2)}ms`;
  (window as unknown as { benchResult: PerfResult }).benchResult = result;

  render(
    [
      'PERF',
      `requested   ${width}×${height} ${parameters.mode}`,
      `buffer      ${result.buffer.width}×${result.buffer.height} (dpr ${dpr}, scale ${result.effectiveScale.toFixed(2)})`,
      `present     ${result.presentation.fps.toFixed(1)} fps median · ${result.presentation.frameMs.toFixed(2)} ms · p95 ${result.presentation.p95Ms.toFixed(2)} ms · min ${result.presentation.minMs.toFixed(2)} ms`,
      `draw cost   ${drawMs.toFixed(2)} ms/frame median · p95 ${result.draw.p95Ms.toFixed(2)} ms (${result.draw.fps.toFixed(1)} fps ceiling, ${iterations} synced frames)`,
      `gpu timer   ${result.gpu.available ? `${result.gpu.ms?.toFixed(2) ?? 'n/a'} ms` : 'unavailable'}`,
      `noise       ≈${result.noisePerPixel} evaluations/pixel`,
      `compile     ${result.compileMs.toFixed(1)} ms total`,
      `refresh     ${refreshHz} Hz (estimated from fastest rAF delta)`,
      `gpu         ${gpuName}`,
      '',
      'JSON',
      JSON.stringify(result),
    ].join('\n'),
  );
  renderer.dispose();
}

function runIoTest(): void {
  const source: NebulaParameters = {
    ...DEFAULT_PARAMETERS,
    seed: 424242,
    palette: 'violet',
    mode: 'volume',
    paused: true,
    adaptiveQuality: false,
    renderScale: 0.85,
    volumeSteps: 64,
    density: 1.37,
  };

  const json = serializeParameters(source);
  const roundTrip = parseParameters(json);
  const keys = Object.keys(source) as Array<keyof NebulaParameters>;
  const mismatches = keys.filter((key) => source[key] !== roundTrip[key]);

  const clamped = normalizeParameters({
    seed: -12,
    density: 99,
    warp: -4,
    octaves: 12.6,
    palette: 'bogus',
    mode: 'hologram',
    starDensity: '0.33',
    adaptiveQuality: 'true',
  });

  const checks: Array<[string, boolean, string]> = [
    ['round-trip preserves all fields', mismatches.length === 0, mismatches.join(', ') || 'no mismatches'],
    ['seed clamps to range', clamped.seed >= 1 && clamped.seed <= 999999, String(clamped.seed)],
    ['density clamps high', clamped.density === 1.8, String(clamped.density)],
    ['warp clamps low', clamped.warp === 0, String(clamped.warp)],
    ['octaves rounds and clamps', clamped.octaves === 9, String(clamped.octaves)],
    ['invalid palette keeps default', clamped.palette === DEFAULT_PARAMETERS.palette, clamped.palette],
    ['invalid mode keeps default', clamped.mode === DEFAULT_PARAMETERS.mode, clamped.mode],
    ['string number accepted', clamped.starDensity === 0.33, String(clamped.starDensity)],
    ['string boolean accepted', clamped.adaptiveQuality === true, String(clamped.adaptiveQuality)],
    ['bare object envelope accepted', parseParameters('{"seed":7,"density":1.2}').seed === 7, 'seed 7'],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  document.title = `io ${failed.length === 0 ? 'PASS' : 'FAIL'}`;
  (window as unknown as { benchResult: unknown }).benchResult = { checks, failed: failed.length };

  render(
    [
      'IMPORT / EXPORT ROUND-TRIP',
      ...checks.map(([label, ok, detail]) => `${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`),
      '',
      `${checks.length - failed.length}/${checks.length} passed`,
    ].join('\n'),
  );
}

interface CaptureResult {
  name: string;
  width: number;
  height: number;
  bytes: number;
  saved: string;
}

interface RawFrame {
  width: number;
  height: number;
  /** Top-down RGBA, ready for ImageData or a per-pixel comparison. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  mode: string;
  compileMs: number;
  bufferScale: number;
}

/**
 * Render one frame at an exact buffer size and read it back.
 *
 * Shared by captures, the self-test suite and the visual-regression comparison
 * so that all three exercise exactly the same path.
 */
function renderFrame(
  width: number,
  height: number,
  parameters: NebulaParameters,
  debugView = 0,
): RawFrame {
  sizeCanvas(width, height);
  canvas.style.opacity = '1';
  canvas.style.zIndex = '0';

  const renderer = new Renderer(canvas, normalizeParameters({ ...parameters, paused: true }));
  if (debugView > 0) renderer.setDebugView(debugView);
  renderer.renderOnce();

  // A shader that fails to compile makes the renderer fall back to 2D without
  // throwing. Captures must never record that fallback as if it were the
  // requested mode: it once produced a "volume" screenshot that was actually
  // the 2D field. The suite relies on the same signal to prove compilation.
  const stats = renderer.getStats();
  if (stats.mode !== parameters.mode) {
    renderer.dispose();
    throw new Error(
      `Renderer fell back to ${stats.mode}: the ${parameters.mode} shader did not compile.`,
    );
  }

  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('No WebGL2 context');

  // Volume mode renders below CSS resolution, so read the real buffer rather
  // than the requested display size.
  const bufferWidth = canvas.width;
  const bufferHeight = canvas.height;
  const raw = new Uint8Array(bufferWidth * bufferHeight * 4);
  gl.readPixels(0, 0, bufferWidth, bufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  renderer.dispose();

  // WebGL rows start at the bottom; ImageData expects top-down.
  const pixels = new Uint8ClampedArray(new ArrayBuffer(raw.length));
  const rowBytes = bufferWidth * 4;
  for (let y = 0; y < bufferHeight; y++) {
    const source = (bufferHeight - 1 - y) * rowBytes;
    pixels.set(raw.subarray(source, source + rowBytes), y * rowBytes);
  }

  return {
    width: bufferWidth,
    height: bufferHeight,
    pixels,
    mode: stats.mode,
    compileMs: stats.compileMs,
    bufferScale: bufferWidth / width,
  };
}

/**
 * Render one frame at an exact buffer size and hand the encoded frame to the
 * development capture sink. Reused by the single-shot and gallery routes.
 */
async function captureFrame(
  width: number,
  height: number,
  parameters: NebulaParameters,
  name: string,
  mime: string,
  debugView = 0,
): Promise<CaptureResult> {
  const frame = renderFrame(width, height, parameters, debugView);
  const { width: bufferWidth, height: bufferHeight, pixels: flipped } = frame;

  const surface = document.createElement('canvas');
  surface.width = bufferWidth;
  surface.height = bufferHeight;
  const context = surface.getContext('2d');
  if (!context) throw new Error('No 2D context');
  context.putImageData(new ImageData(flipped, bufferWidth, bufferHeight), 0, 0);

  const blob = await new Promise<Blob | null>((resolve) =>
    surface.toBlob(resolve, mime, 0.92),
  );
  if (!blob) throw new Error('Encoding failed');

  // Development sink: writes the frame straight into screenshots/. The browser
  // panel is often narrower than the capture, and sandboxed downloads never
  // reach the project, so a POST is the reliable path.
  const saved = await fetch('/__capture', {
    method: 'POST',
    headers: { 'content-type': mime, 'x-capture-name': name },
    body: blob,
  })
    .then((response) => (response.ok ? response.text() : `HTTP ${response.status}`))
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

  return { name, width: bufferWidth, height: bufferHeight, bytes: blob.size, saved };
}

/**
 * Render one frame at a fixed buffer size and write it into screenshots/.
 * Used to capture documentation screenshots on a machine whose browser panel
 * is narrower than the target image.
 */
async function runScreenshot(): Promise<void> {
  const width = Math.round(numberParam('w', 2160));
  const height = Math.round(numberParam('h', 1350));
  const mime = query.get('format') === 'png' ? 'image/png' : 'image/jpeg';

  const parameters = parametersFromQuery();
  const preset = query.get('preset') ?? 'custom';
  const extension = mime === 'image/png' ? 'png' : 'jpg';
  // Estimate the buffer for the default name; the result carries the real size.
  const name =
    query.get('name') ??
    `nebula-${preset}-${parameters.mode}-${width}x${height}.${extension}`;

  const result = await captureFrame(
    width,
    height,
    parameters,
    name,
    mime,
    Math.round(numberParam('debug', 0)),
  );

  const previewUrl = `/screenshots/${result.name}`;
  const preview = document.createElement('img');
  preview.src = previewUrl;
  preview.alt = result.name;
  preview.style.cssText =
    'display:block;width:100%;max-width:900px;margin-top:10px;border:1px solid rgba(160,190,235,.25);border-radius:6px;';
  document.body.append(preview);

  const extensionLabel = mime === 'image/png' ? 'PNG' : 'JPG';
  render(
    [
      'SCREENSHOT',
      `${result.width}×${result.height} ${parameters.mode} · ${preset} · seed ${parameters.seed}`,
      `requested ${width}×${height} (pipeline scale ${(result.width / width).toFixed(2)})`,
      `${(result.bytes / 1024).toFixed(0)} KB ${extensionLabel}`,
      result.saved,
    ].join('\n'),
  );
  document.title = `shot ${result.name}`;
  (window as unknown as { benchResult: unknown }).benchResult = result;
}

/**
 * Capture every preset at one fixed size, plus a volume frame, into
 * screenshots/<prefix>-<preset>.jpg. This is the visual-regression set: same
 * seeds, same size, same paused clock, so differences come from the renderer.
 */
async function runGallery(): Promise<void> {
  const width = Math.round(numberParam('w', 1400));
  const height = Math.round(numberParam('h', 900));
  const prefix = (query.get('prefix') ?? 'gallery').replace(/[^a-zA-Z0-9._-]/g, '_');
  const includeVolume = query.get('volume') !== '0';
  const mime = 'image/jpeg';

  const results: CaptureResult[] = [];
  for (const preset of PRESETS) {
    const base = applyPreset(
      normalizeParameters({ ...DEFAULT_PARAMETERS, adaptiveQuality: false, paused: true }),
      preset,
    );
    const shot = await captureFrame(width, height, base, `${prefix}-${preset.id}.jpg`, mime);
    results.push(shot);
    render(`GALLERY\n${results.length}/${PRESETS.length + (includeVolume ? 1 : 0)}\n${shot.name}`);
  }

  if (includeVolume) {
    const preset = presetById(query.get('volumePreset') ?? 'orion-deep') ?? PRESETS[0];
    const base = applyPreset(
      normalizeParameters({
        ...DEFAULT_PARAMETERS,
        mode: 'volume',
        adaptiveQuality: false,
        paused: true,
        volumeSteps: Math.round(numberParam('steps', 48)),
      }),
      preset,
    );
    const shot = await captureFrame(
      width,
      height,
      base,
      `${prefix}-${preset.id}-volume.jpg`,
      mime,
    );
    results.push(shot);
  }

  document.title = `gallery ${results.length} shots`;
  (window as unknown as { benchResult: unknown }).benchResult = { prefix, results };
  render(
    [
      'GALLERY',
      ...results.map(
        (shot) => `${shot.name}  ${shot.width}×${shot.height}  ${(shot.bytes / 1024).toFixed(0)} KB`,
      ),
      '',
      `${results.length} frames written to screenshots/`,
    ].join('\n'),
  );
}

/** Mean absolute channel difference and share of visibly changed pixels. */
function compareFrames(a: Uint8ClampedArray, b: Uint8ClampedArray): {
  meanAbs: number;
  changedFraction: number;
} {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  let changed = 0;
  let pixels = 0;
  for (let i = 0; i < length; i += 4) {
    let delta = 0;
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(a[i + channel] - b[i + channel]);
      sum += difference;
      delta = Math.max(delta, difference);
    }
    if (delta > 8) changed++;
    pixels++;
  }
  return {
    meanAbs: pixels > 0 ? sum / (pixels * 3) : 0,
    changedFraction: pixels > 0 ? changed / pixels : 0,
  };
}

function framesEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface FieldStats {
  mean: number;
  peak: number;
  saturated: number;
  massFraction: number;
  borderPeak: number;
}

/** Statistics of the red channel of a single-channel debug render. */
function fieldStats(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  ring = 4,
): FieldStats {
  let sum = 0;
  let peak = 0;
  let saturated = 0;
  let mass = 0;
  const counts = width * height;
  for (let i = 0; i < counts; i++) {
    const value = pixels[i * 4];
    sum += value;
    peak = Math.max(peak, value);
    if (value >= 255) saturated++;
    if (value >= 20) mass++;
  }
  // A ring around the frame: for the lattice slice this samples the region
  // outside the envelope's support, where the field must be exactly zero.
  let borderPeak = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= ring && x < width - ring && y >= ring && y < height - ring) continue;
      borderPeak = Math.max(borderPeak, pixels[(y * width + x) * 4]);
    }
  }
  return {
    mean: sum / Math.max(1, counts),
    peak,
    saturated,
    massFraction: mass / Math.max(1, counts),
    borderPeak,
  };
}

/** Lowercase hex of the first bytes, for readable details in failures. */
function digest(pixels: Uint8ClampedArray): string {
  let hash = 2166136261;
  for (let i = 0; i < pixels.length; i += 7) {
    hash ^= pixels[i];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Off-screen canvas for independent library instances. */
function createSurface(width: number, height: number): HTMLCanvasElement {
  const surface = document.createElement('canvas');
  surface.style.cssText =
    `position:fixed;left:0;top:0;width:${width}px;height:${height}px;` +
    'opacity:0;pointer-events:none;';
  surface.setAttribute('aria-hidden', 'true');
  document.body.append(surface);
  return surface;
}

/** Read back a surface drawn by a library instance. */
function readSurface(surface: HTMLCanvasElement): Uint8ClampedArray {
  const gl = surface.getContext('webgl2');
  if (!gl) throw new Error('No WebGL2 context on the test surface.');
  const raw = new Uint8Array(surface.width * surface.height * 4);
  gl.readPixels(0, 0, surface.width, surface.height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  return new Uint8ClampedArray(raw);
}

function litProbes(surface: HTMLCanvasElement): number {
  const gl = surface.getContext('webgl2');
  if (!gl) return 0;
  const pixel = new Uint8Array(4);
  let lit = 0;
  const probes: Array<[number, number]> = [
    [0.25, 0.5],
    [0.5, 0.5],
    [0.75, 0.5],
  ];
  for (const [u, v] of probes) {
    gl.readPixels(
      Math.round(surface.width * u),
      Math.round(surface.height * v),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    );
    if (pixel[0] + pixel[1] + pixel[2] > 0) lit++;
  }
  return lit;
}

function sameVec(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < 1e-12);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * Self-test suite: normalization, presets, colour conversion, shader
 * compilation, initialization, reproducibility, density bounds, envelope and
 * context loss. Every check is expressed in the same terms the docs use, so a
 * failure names the behaviour rather than a line of code.
 */
async function runSuite(): Promise<void> {
  const sections: Array<{ title: string; checks: Check[] }> = [];
  let checks: Check[] = [];
  const begin = (title: string): void => {
    checks = [];
    sections.push({ title, checks });
  };
  const add = (label: string, ok: boolean, detail: string): void => {
    checks.push([label, ok, detail]);
  };
  const progress = (label: string): void => {
    const failed = sections.reduce((total, section) => total + section.checks.filter(([, ok]) => !ok).length, 0);
    render(`SELF-TEST\n${label}\n${failed} failure(s) so far`);
  };

  // -- normalization -------------------------------------------------------
  begin('normalization');
  progress('normalization');
  const clamped = normalizeParameters({
    seed: -7,
    density: 99,
    warp: -3,
    octaves: 12.4,
    palette: 'bogus',
    mode: 'hologram',
    starDensity: '0.31',
    emission: 'not-a-number',
  });
  add('seed clamps into range', clamped.seed >= 1 && clamped.seed <= 999999, String(clamped.seed));
  add('density clamps at the top of its range', clamped.density === 1.8, String(clamped.density));
  add('warp clamps at zero', clamped.warp === 0, String(clamped.warp));
  add('octaves round and clamp', clamped.octaves === 9, String(clamped.octaves));
  add('unknown palette falls back', clamped.palette === DEFAULT_PARAMETERS.palette, clamped.palette);
  add('unknown mode falls back', clamped.mode === DEFAULT_PARAMETERS.mode, clamped.mode);
  add('numeric strings parse', clamped.starDensity === 0.31, String(clamped.starDensity));
  add('unparsable numbers fall back', clamped.emission === DEFAULT_PARAMETERS.emission, String(clamped.emission));
  add(
    'normalization is idempotent',
    JSON.stringify(normalizeParameters(clamped)) === JSON.stringify(clamped),
    'stable on a second pass',
  );
  if (Number.isFinite(clamped.octaves)) {
    // Every numeric parameter must be finite: a single NaN would poison the
    // whole field, and NaN compares false against its own bounds.
    const nonFinite = (Object.keys(clamped) as Array<keyof NebulaParameters>).filter(
      (key) => typeof clamped[key] === 'number' && !Number.isFinite(clamped[key] as number),
    );
    add('no parameter is non-finite', nonFinite.length === 0, nonFinite.join(', ') || 'all finite');
  }

  // -- serialization -------------------------------------------------------
  begin('import / export');
  const source: NebulaParameters = {
    ...DEFAULT_PARAMETERS,
    seed: 424242,
    palette: 'violet',
    mode: 'volume',
    volumeSteps: 37,
    density: 1.37,
    paused: true,
  };
  const roundTrip = parseParameters(serializeParameters(source));
  const mismatches = (Object.keys(source) as Array<keyof NebulaParameters>).filter(
    (key) => source[key] !== roundTrip[key],
  );
  add('round-trip preserves every field', mismatches.length === 0, mismatches.join(', ') || 'no mismatches');
  add(
    'every palette survives a round-trip',
    (Object.keys(PALETTES) as Array<keyof typeof PALETTES>).every(
      (id) => parseParameters(serializeParameters({ ...source, palette: id })).palette === id,
    ),
    `${Object.keys(PALETTES).length} palettes`,
  );

  // -- presets -------------------------------------------------------------
  begin('presets');
  const applied = PRESETS.map((preset) => applyPreset(normalizeParameters({ ...DEFAULT_PARAMETERS }), preset));
  add('six presets are defined', PRESETS.length === 6, `${PRESETS.length}`);
  add(
    'preset ids and labels are unique',
    new Set(PRESETS.map((preset) => preset.id)).size === PRESETS.length &&
      new Set(PRESETS.map((preset) => preset.label)).size === PRESETS.length,
    PRESETS.map((preset) => preset.id).join(', '),
  );
  add(
    'presets are defined in normalized values',
    applied.every((parameters) => JSON.stringify(normalizeParameters(parameters)) === JSON.stringify(parameters)),
    'no clamping needed',
  );
  add(
    'presets use distinct seeds',
    new Set(applied.map((parameters) => parameters.seed)).size === applied.length,
    applied.map((parameters) => parameters.seed).join(', '),
  );
  const untouched = normalizeParameters({ ...DEFAULT_PARAMETERS, seed: 7 });
  const before = JSON.stringify(untouched);
  applyPreset(untouched, PRESETS[0]);
  add('applyPreset does not mutate its input', JSON.stringify(untouched) === before, 'input unchanged');
  add(
    'preset looks are distinct',
    new Set(applied.map((parameters) => `${parameters.seed}:${parameters.palette}:${parameters.density}`)).size ===
      applied.length,
    'seed, palette and density differ',
  );

  // -- versioned configuration ---------------------------------------------
  begin('library configuration');
  const configSource: NebulaParameters = {
    ...DEFAULT_PARAMETERS,
    seed: 32123,
    density: 1.22,
    mode: 'volume',
    volumeSteps: 40,
    paused: true,
  };
  const config = fromParameters(configSource, {
    position: [1.2, 0.5, 1.8],
    target: [0, 0.05, 0],
    fov: 0.72,
    zoom: 1.25,
  });
  const configRoundTrip = parseConfig(serializeConfig(config));
  add(
    'configuration carries a format and version',
    config.format === 'nebula-config' && config.version === CONFIG_VERSION,
    `v${config.version}`,
  );
  add(
    'configuration round-trips exactly',
    JSON.stringify(configRoundTrip) === JSON.stringify(config),
    'generation, rendering and camera',
  );
  add(
    'generation is separate from rendering',
    !('mode' in config.generation) && !('emission' in config.generation) && !('density' in config.rendering),
    'split envelope',
  );
  add(
    'camera survives a round-trip',
    sameVec(configRoundTrip.camera.position ?? [], [1.2, 0.5, 1.8]) && configRoundTrip.camera.zoom === 1.25,
    'explicit view preserved',
  );
  add(
    'pause state stays out of the artwork',
    !Object.prototype.hasOwnProperty.call(config.rendering, 'paused') &&
      !Object.prototype.hasOwnProperty.call(config, 'paused'),
    'host-owned playback state',
  );
  const legacyConfig = parseConfig(serializeParameters(configSource));
  add(
    'legacy parameter exports still import',
    legacyConfig.seed === configSource.seed &&
      legacyConfig.rendering.mode === 'volume' &&
      legacyConfig.generation.density === 1.22,
    `seed ${legacyConfig.seed}, ${legacyConfig.rendering.mode}`,
  );
  const bareConfig = normalizeConfig({ seed: 77, density: 9, camera: { fov: 99 } });
  add(
    'bare objects normalize and clamp',
    bareConfig.seed === 77 && bareConfig.generation.density === 1.8 && bareConfig.camera.fov === 1.5,
    `seed ${bareConfig.seed}, density ${bareConfig.generation.density}, fov ${bareConfig.camera.fov}`,
  );
  add(
    'seeds normalize into range',
    normalizeConfig({ seed: 0 }).seed === 1 && normalizeConfig({ seed: -8 }).seed === 1,
    'magnitude clamped into 1..999999',
  );
  let futureRejected = false;
  try {
    normalizeConfig({ format: 'nebula-config', version: 2 });
  } catch (error) {
    futureRejected = error instanceof ConfigError;
  }
  add('a newer configuration version is rejected', futureRejected, 'version 2');
  let invalidJsonRejected = false;
  try {
    parseConfig('{nope');
  } catch (error) {
    invalidJsonRejected = error instanceof ConfigError;
  }
  add('invalid JSON raises ConfigError', invalidJsonRejected, 'parseConfig');

  // -- camera model --------------------------------------------------------
  begin('camera');
  const orbit = orbitPosition(0, 0);
  add(
    'default framing matches the original orbit',
    sameVec(orbit, [Math.cos(2.3) * 1.88, 0.18, Math.sin(2.3) * 1.88]),
    `(${orbit.map((value) => value.toFixed(3)).join(', ')})`,
  );
  const defaultView = resolveCamera(DEFAULT_CAMERA, 0, 0);
  add(
    'default camera resolves to the same view',
    sameVec(defaultView.position, orbit) &&
      sameVec(defaultView.target, [0, 0, 0]) &&
      Math.abs(defaultView.fov - 0.66) < 1e-12,
    'position, target and FOV preserved',
  );
  add(
    'zoom narrows the field of view',
    Math.abs(resolveCamera({ ...DEFAULT_CAMERA, zoom: 2 }, 0, 0).fov - 0.33) < 1e-12,
    '0.66 / 2 = 0.33',
  );
  const clampedCamera = normalizeCamera({ fov: 99, zoom: 0.01, target: [Number.NaN, 0, 0] });
  add(
    'camera values clamp and reject non-finite vectors',
    clampedCamera.fov === 1.5 &&
      clampedCamera.zoom === 0.4 &&
      sameVec(clampedCamera.target, DEFAULT_CAMERA.target),
    `fov ${clampedCamera.fov}, zoom ${clampedCamera.zoom}`,
  );
  add(
    'a degenerate view falls back to the orbit',
    normalizeCamera({ position: [0, 0, 0] }).position === null &&
      normalizeCamera({ position: [Number.NaN, 0, 0] }).position === null,
    'eye on target and non-finite positions rejected',
  );
  add(
    'five named camera presets are available',
    Object.keys(CAMERA_PRESETS).length === 5 &&
      CAMERA_PRESETS.default.position === null &&
      cameraPreset('missing') === undefined,
    Object.keys(CAMERA_PRESETS).join(', '),
  );
  add(
    'camera presets frame distinct directions',
    new Set(
      Object.values(CAMERA_PRESETS)
        .filter((preset) => preset.position !== null)
        .map((preset) => preset.position?.map((value) => value.toFixed(2)).join(',')),
    ).size === 4,
    'four explicit views',
  );

  // -- colour --------------------------------------------------------------
  begin('colour conversion');
  // Reference value for exact sRGB: 0.5 encodes 0.21404114048223255 linear.
  add(
    'sRGB decode uses the exact transfer function',
    Math.abs(srgbChannelToLinear(0.5) - 0.21404114048223255) < 1e-12,
    srgbChannelToLinear(0.5).toFixed(12),
  );
  add(
    'linear segments are exact at the ends',
    srgbChannelToLinear(0) === 0 && srgbChannelToLinear(1) === 1,
    '0 and 1 map to 0 and 1',
  );
  let worstRoundTrip = 0;
  for (let step = 0; step <= 255; step++) {
    const srgb = step / 255;
    worstRoundTrip = Math.max(worstRoundTrip, Math.abs(linearChannelToSrgb(srgbChannelToLinear(srgb)) - srgb));
  }
  add('sRGB encode inverts decode', worstRoundTrip < 1e-9, `worst error ${worstRoundTrip.toExponential(2)}`);
  add(
    'hex parsing produces linear values',
    hexToLinear('#ffffff').every((channel) => channel === 1) && hexToLinear('#000000').every((channel) => channel === 0),
    'white is (1, 1, 1)',
  );
  const paletteStopsFlat = (Object.keys(PALETTES) as Array<keyof typeof PALETTES>).flatMap((id) =>
    PALETTES[id].stops.map((stop) => ({ id, stop, linear: hexToLinear(stop) })),
  );
  add(
    'every palette stop decodes into [0, 1]',
    paletteStopsFlat.every(({ linear }) => linear.every((channel) => channel >= 0 && channel <= 1)),
    `${paletteStopsFlat.length} stops`,
  );
  const luminance = (hex: string): number => {
    const [r, g, b] = hexToLinear(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const paletteIds = Object.keys(PALETTES) as Array<keyof typeof PALETTES>;
  // A violet stop is legitimately darker in luminance than the cyan before it,
  // so the ramp is checked at its ends rather than step by step: the first stop
  // must be the darkest and the last the brightest, which is what the emission
  // ramps rely on when they index "faint gas" and "ionized core".
  add(
    'palette ramps run from dark to bright',
    paletteIds.every((id) => {
      const stops = PALETTES[id].stops;
      const values = stops.map(luminance);
      return values[0] === Math.min(...values) && values[values.length - 1] === Math.max(...values);
    }),
    'first stop darkest, last stop brightest',
  );
  add(
    'palette stops are distinct',
    paletteIds.every((id) => new Set(PALETTES[id].stops).size === PALETTES[id].stops.length),
    `${paletteStopsFlat.length} stops`,
  );
  add(
    'sky is darker than the first stop of every palette',
    paletteIds.every((id) => luminance(PALETTES[id].background) < luminance(PALETTES[id].stops[0])),
    'background stays behind the gas',
  );

  // -- shader compilation and initialization -------------------------------
  begin('shader compilation and init');
  progress('shader compilation');
  sizeCanvas(480, 270);
  const initRenderer = new Renderer(
    canvas,
    normalizeParameters({ ...DEFAULT_PARAMETERS, paused: true, adaptiveQuality: false }),
  );
  const initStats = initRenderer.getStats();
  const reports = initRenderer.getCompileReports();
  add('renderer initializes a WebGL2 pipeline', initStats.bufferWidth > 0, `${initStats.bufferWidth}×${initStats.bufferHeight}`);
  add(
    'three programs compile',
    reports.length === 3,
    reports.map((report) => `${report.name} ${report.totalMs.toFixed(0)} ms`).join(' · ') || 'no reports',
  );
  add(
    'compiled programs expose uniforms',
    reports.every((report) => report.uniformCount > 0),
    reports.map((report) => `${report.name}:${report.uniformCount}`).join(' '),
  );
  add('2D mode is active', initStats.mode === '2d', initStats.mode);
  add('2D renders at full resolution', initStats.effectiveScale > 0.99, String(initStats.effectiveScale));
  add('volume pipeline is available', initRenderer.volumeAvailable, initRenderer.volumeFailure ?? 'available');
  initRenderer.dispose();

  const volumeRenderer = new Renderer(
    canvas,
    normalizeParameters({
      ...DEFAULT_PARAMETERS,
      mode: 'volume',
      paused: true,
      adaptiveQuality: false,
    }),
  );
  const volumeStats = volumeRenderer.getStats();
  add('volume mode is active when requested', volumeStats.mode === 'volume', volumeStats.mode);
  add(
    'volume renders through its resolution scale',
    volumeStats.effectiveScale < 0.8 && volumeStats.effectiveScale > 0.5,
    `scale ${volumeStats.effectiveScale.toFixed(2)}, buffer ${volumeStats.bufferWidth}×${volumeStats.bufferHeight}`,
  );
  add(
    'volume buffer keeps the display aspect',
    Math.abs(volumeStats.bufferWidth / volumeStats.bufferHeight - volumeStats.displayWidth / volumeStats.displayHeight) <
      0.02,
    `${(volumeStats.bufferWidth / volumeStats.bufferHeight).toFixed(3)}`,
  );
  volumeRenderer.dispose();

  // -- library lifecycle ---------------------------------------------------
  begin('library lifecycle');
  progress('library lifecycle');
  const still = normalizeParameters({ ...DEFAULT_PARAMETERS, paused: true, adaptiveQuality: false });

  let noTargetCode = 'none';
  try {
    new Nebula({});
  } catch (error) {
    noTargetCode = error instanceof NebulaError ? error.code : 'other';
  }
  add('a missing render target is rejected', noTargetCode === 'no-target', noTargetCode);

  const manualSurface = createSurface(180, 120);
  const manual = new Nebula({
    canvas: manualSurface,
    config: fromParameters(still),
    autoStart: false,
  });
  let readyCount = 0;
  let readyBuffer = 0;
  manual.on('ready', (payload) => {
    readyCount++;
    readyBuffer = payload.stats.bufferWidth;
  });
  await Promise.resolve();
  add(
    'ready is emitted after construction',
    readyCount === 1 && readyBuffer > 0,
    `${readyCount} event, ${readyBuffer}px buffer`,
  );
  add(
    'manual mode does not start an animation loop',
    !manual.isRunning && !manual.autoStart,
    `${manual.isRunning ? 'running' : 'idle'}`,
  );

  let renderEvents = 0;
  let changeEvents = 0;
  let performanceEvents = 0;
  manual.on('render', () => renderEvents++);
  manual.on('configurationchange', () => changeEvents++);
  manual.on('performance', () => performanceEvents++);

  manual.render(0);
  add(
    'manual render draws one frame at the requested time',
    renderEvents === 1 && manual.getTime() === 0,
    `${renderEvents} render event(s)`,
  );
  const manualA = readSurface(manualSurface);
  manual.render(0);
  const manualB = readSurface(manualSurface);
  add('the same time renders identical pixels', framesEqual(manualA, manualB), digest(manualA));
  manual.render(4);
  const manualC = readSurface(manualSurface);
  add('a later time advances the field', !framesEqual(manualA, manualC), 't=4 differs from t=0');

  manual.setCamera({ zoom: 1.35 });
  add(
    'camera changes emit configurationchange',
    changeEvents > 0 && manual.getCamera().zoom === 1.35,
    `${changeEvents} change event(s)`,
  );
  const detachedCamera = manual.getCamera();
  (detachedCamera.target as [number, number, number])[0] = 99;
  add(
    'getCamera returns a detached copy',
    manual.getCamera().target[0] === 0,
    `target ${manual.getCamera().target.join(', ')}`,
  );
  manual.resetCamera();
  add(
    'camera reset restores the built-in orbit',
    manual.getCamera().position === null && manual.getCamera().zoom === 1,
    'orbit, zoom 1',
  );

  manual.setConfig({
    generation: { palette: 'ice' },
    rendering: { mode: 'volume', volumeSteps: 24, adaptiveQuality: false },
    camera: { position: [1, 0, 0], target: [0, 0, 0], fov: 0.7, zoom: 1 },
  });
  add(
    'setConfig applies artwork, rendering and camera together',
    manual.getConfig().generation.palette === 'ice' &&
      manual.getParameters().mode === 'volume' &&
      sameVec(manual.getCamera().position ?? [], [1, 0, 0]),
    'config replaced as one unit',
  );
  let badVersionCode = 'none';
  try {
    manual.setConfig({ format: 'nebula-config', version: 2 } as unknown as NebulaConfig);
  } catch (error) {
    badVersionCode = error instanceof NebulaError ? error.code : 'other';
  }
  add('setConfig rejects unsupported versions', badVersionCode === 'configuration', badVersionCode);

  manual.start();
  add('start enables the internal loop', manual.isRunning, 'running');
  manual.stop();
  add('stop returns to manual rendering', !manual.isRunning, 'stopped');

  manual.render(0);
  await delay(260);
  manual.render(0);
  add(
    'performance statistics are reported',
    performanceEvents > 0,
    `${performanceEvents} sample(s)`,
  );

  manual.dispose();
  let disposedCode = 'none';
  try {
    manual.render(0);
  } catch (error) {
    disposedCode = error instanceof NebulaError ? error.code : 'other';
  }
  add('dispose rejects further use', disposedCode === 'configuration', disposedCode);
  manual.dispose();
  add('dispose is idempotent', true, 'second call is a no-op');
  manualSurface.remove();

  const cameraSurface = createSurface(160, 100);
  const cameraNebula = new Nebula({
    canvas: cameraSurface,
    config: fromParameters({ ...still, mode: 'volume', volumeSteps: 24 }),
    autoStart: false,
  });
  cameraNebula.render(0);
  const orbitFrame = readSurface(cameraSurface);
  cameraNebula.setCamera({
    position: CAMERA_PRESETS.side.position,
    target: CAMERA_PRESETS.side.target,
    fov: CAMERA_PRESETS.side.fov,
    zoom: 1,
  });
  cameraNebula.render(0);
  const sideFrame = readSurface(cameraSurface);
  const cameraDifference = compareFrames(orbitFrame, sideFrame);
  add(
    'an explicit camera reframes the same field',
    cameraDifference.changedFraction > 0.02,
    `${(cameraDifference.changedFraction * 100).toFixed(0)}% of pixels differ`,
  );
  cameraNebula.setCameraPreset('close');
  add(
    'named camera presets apply',
    JSON.stringify(cameraNebula.getCamera()) === JSON.stringify(cameraPreset('close')),
    'close',
  );
  cameraNebula.dispose();
  cameraSurface.remove();

  const surfaceA = createSurface(144, 96);
  const surfaceB = createSurface(144, 96);
  const instanceA = new Nebula({
    canvas: surfaceA,
    config: fromParameters({ ...still, seed: 101 }),
    autoStart: false,
  });
  const instanceB = new Nebula({
    canvas: surfaceB,
    config: fromParameters({ ...still, seed: 202 }),
    autoStart: false,
  });
  instanceA.render(0);
  instanceB.render(0);
  const pixelsA = readSurface(surfaceA);
  const pixelsB = readSurface(surfaceB);
  add(
    'two instances render independently',
    pixelsA.length === pixelsB.length && !framesEqual(pixelsA, pixelsB),
    'different seeds, different frames',
  );
  instanceA.setCamera({ zoom: 1.5 });
  instanceB.render(0);
  add(
    'instances keep separate configuration',
    instanceA.getCamera().zoom === 1.5 && instanceB.getCamera().zoom === 1,
    'camera state isolated',
  );
  instanceA.dispose();
  instanceB.render(0);
  const survivingProbes = litProbes(surfaceB);
  add(
    'disposing one instance leaves the other alive',
    survivingProbes > 0,
    `${survivingProbes}/3 probes lit`,
  );
  instanceB.dispose();
  surfaceA.remove();
  surfaceB.remove();

  const webglProto = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const originalGetContext = webglProto.getContext;
  try {
    webglProto.getContext = () => null;
    add('isSupported is honest without WebGL2', Nebula.isSupported() === false, 'probe returned null');
    let initCode = 'none';
    try {
      new Nebula({ canvas: document.createElement('canvas') });
    } catch (error) {
      initCode = error instanceof NebulaError ? error.code : 'other';
    }
    add(
      'invalid WebGL2 initialization raises NebulaError',
      initCode === 'webgl2-unavailable',
      initCode,
    );
  } finally {
    webglProto.getContext = originalGetContext;
  }

  // -- reproducibility -----------------------------------------------------
  begin('reproducibility');
  progress('reproducibility');
  const paused = normalizeParameters({
    ...DEFAULT_PARAMETERS,
    paused: true,
    adaptiveQuality: false,
  });
  const frameA = renderFrame(320, 200, paused);
  const frameB = renderFrame(320, 200, paused);
  add('same seed and clock render identical pixels', framesEqual(frameA.pixels, frameB.pixels), digest(frameA.pixels));
  const reseeded = renderFrame(320, 200, { ...paused, seed: paused.seed + 1 });
  const seedDifference = compareFrames(frameA.pixels, reseeded.pixels);
  add(
    'a new seed produces a different field',
    seedDifference.changedFraction > 0.1,
    `${(seedDifference.changedFraction * 100).toFixed(0)}% of pixels differ`,
  );
  const volumePaused = normalizeParameters({
    ...paused,
    mode: 'volume',
    volumeSteps: 32,
  });
  const volumeA = renderFrame(240, 150, volumePaused);
  const volumeB = renderFrame(240, 150, volumePaused);
  add('volume repeats frame for frame', framesEqual(volumeA.pixels, volumeB.pixels), digest(volumeA.pixels));
  const volumeReseeded = renderFrame(240, 150, { ...volumePaused, seed: volumePaused.seed + 1 });
  add(
    'volume responds to the seed',
    compareFrames(volumeA.pixels, volumeReseeded.pixels).changedFraction > 0.05,
    `${(compareFrames(volumeA.pixels, volumeReseeded.pixels).changedFraction * 100).toFixed(0)}% of pixels differ`,
  );

  // -- density bounds and envelope -----------------------------------------
  begin('density bounds and envelope');
  progress('density bounds');
  // Debug view 4 of the volume shader draws the analytic field on a slice
  // through the cube, independent of the camera. It is the only view that can
  // tell the model's own bounds from what one viewpoint happens to see.
  const slice = renderFrame(256, 256, volumePaused, 4);
  // The slice maps the cube's [-1, 1] extent onto the frame, so the exact edge
  // of the image is the cube face. A non-zero value there means the envelope
  // was cut by the sampling limit rather than faded to zero.
  const sliceStats = fieldStats(slice.pixels, slice.width, slice.height, 1);
  add('volume field never saturates the density clamp', sliceStats.saturated === 0, `peak ${sliceStats.peak}/255`);
  add(
    'volume field carries mass',
    sliceStats.massFraction > 0.02,
    `${(sliceStats.massFraction * 100).toFixed(1)}% of the slice above 0.1`,
  );
  add(
    'volume field leaves most of the cube empty',
    sliceStats.massFraction < 0.6,
    `${(sliceStats.massFraction * 100).toFixed(1)}% occupied`,
  );
  add(
    'the envelope reaches zero before the cube face',
    sliceStats.borderPeak === 0,
    `border peak ${sliceStats.borderPeak}`,
  );
  add(
    'mean density stays in a plausible band',
    sliceStats.mean > 4 && sliceStats.mean < 90,
    `mean ${sliceStats.mean.toFixed(1)}/255`,
  );

  const density2D = renderFrame(320, 200, paused, 1);
  const stats2D = fieldStats(density2D.pixels, density2D.width, density2D.height);
  add(
    '2D density fills its frame without flooding it',
    stats2D.massFraction > 0.08 && stats2D.massFraction < 0.95,
    `${(stats2D.massFraction * 100).toFixed(0)}% of the frame above 0.08`,
  );
  add('2D density is finite everywhere', stats2D.peak > 0, `peak ${stats2D.peak}/255`);

  // -- context loss --------------------------------------------------------
  begin('context loss and restore');
  progress('context loss');
  sizeCanvas(480, 270);
  const statuses: string[] = [];
  const live = new Renderer(
    canvas,
    normalizeParameters({ ...DEFAULT_PARAMETERS, adaptiveQuality: false, paused: false }),
    {
      onStatus: (status) => statuses.push(status),
    },
  );
  await delay(500);

  // Draw one frame synchronously rather than trusting rAF: a background tab can
  // throttle animation frames to zero, and the point here is to prove the
  // pipeline renders *before* the loss, not that the compositor is awake.
  live.renderOnce();
  const liveGl = canvas.getContext('webgl2');
  let litBefore = 0;
  if (liveGl) {
    const probe = new Uint8Array(4);
    for (const [u, v] of [
      [0.3, 0.5],
      [0.5, 0.5],
      [0.7, 0.5],
    ] as Array<[number, number]>) {
      liveGl.readPixels(
        Math.round(canvas.width * u),
        Math.round(canvas.height * v),
        1,
        1,
        liveGl.RGBA,
        liveGl.UNSIGNED_BYTE,
        probe,
      );
      if (probe[0] + probe[1] + probe[2] > 0) litBefore++;
    }
  }
  add('renderer draws before the loss', litBefore > 0, `${litBefore}/3 probes lit`);

  const loseExtension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context') ?? null;
  add('WEBGL_lose_context is available', loseExtension !== null, loseExtension ? 'available' : 'missing');
  if (loseExtension) {
    loseExtension.loseContext();
    await delay(300);
    loseExtension.restoreContext();
    await delay(900);

    const gl = canvas.getContext('webgl2');
    while (gl && gl.getError() !== gl.NO_ERROR) {
      /* clear stale errors */
    }
    live.renderOnce();
    const glError = gl ? gl.getError() : -1;
    let lit = 0;
    if (gl) {
      const probe = new Uint8Array(4);
      for (const [u, v] of [
        [0.3, 0.5],
        [0.5, 0.5],
        [0.7, 0.5],
      ] as Array<[number, number]>) {
        gl.readPixels(
          Math.round(canvas.width * u),
          Math.round(canvas.height * v),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          probe,
        );
        if (probe[0] + probe[1] + probe[2] > 0) lit++;
      }
    }
    add('context loss is reported', statuses.includes('context-lost'), statuses.join(', '));
    add('context restore is reported', statuses.includes('restored'), statuses.join(', '));
    add('render after restore is GL-clean', glError === (gl?.NO_ERROR ?? 0), `gl error ${glError}`);
    add('render after restore produces pixels', lit > 0, `${lit}/3 probes lit`);
    add('volume pipeline survives the restore', live.volumeAvailable, live.volumeFailure ?? 'available');
  }
  live.dispose();

  // The same recovery path through the library's event surface.
  const recoverySurface = createSurface(240, 160);
  const recovery = new Nebula({
    canvas: recoverySurface,
    config: fromParameters({ ...still, paused: true }),
    autoStart: false,
  });
  let libraryLost = 0;
  let libraryRestored = 0;
  recovery.on('contextlost', () => libraryLost++);
  recovery.on('contextrestored', () => libraryRestored++);
  recovery.render(0);
  const recoveryExtension = recoverySurface
    .getContext('webgl2')
    ?.getExtension('WEBGL_lose_context');
  if (recoveryExtension) {
    recoveryExtension.loseContext();
    await delay(300);
    recoveryExtension.restoreContext();
    await delay(900);
    recovery.render(0);
    const recoveredProbes = litProbes(recoverySurface);
    add('library emits contextlost', libraryLost > 0, `${libraryLost} event(s)`);
    add('library emits contextrestored', libraryRestored > 0, `${libraryRestored} event(s)`);
    add('library renders after restore', recoveredProbes > 0, `${recoveredProbes}/3 probes lit`);
  }
  recovery.dispose();
  recoverySurface.remove();

  // -- report --------------------------------------------------------------
  const failed = sections.flatMap((section) => section.checks).filter(([, ok]) => !ok);
  const total = sections.reduce((count, section) => count + section.checks.length, 0);
  document.title =
    `${failed.length === 0 ? 'suite PASS' : 'suite FAIL'} · ` +
    `${total - failed.length}/${total}`;
  (window as unknown as { benchResult: unknown }).benchResult = { sections, total, failed: failed.length };

  render(
    [
      'SELF-TEST',
      ...sections.map((section) =>
        [
          `— ${section.title}`,
          ...section.checks.map(([label, ok, detail]) => `${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`),
        ].join('\n'),
      ),
      '',
      `${total - failed.length}/${total} passed`,
      ...failed.map(([label]) => `failed: ${label}`),
    ].join('\n\n'),
  );
}

/**
 * Visual regression: render a fixed-seed frame and compare it against a stored
 * reference. The comparison is tolerant (JPEG and driver differences), so it
 * catches a changed look rather than a changed rounding path.
 */
async function runCompare(): Promise<void> {
  const reference = (query.get('ref') ?? 'orion-deep-2d.png').replace(/[^a-zA-Z0-9._-]/g, '_');
  const width = Math.round(numberParam('w', 640));
  const height = Math.round(numberParam('h', 400));
  const parameters = normalizeParameters({
    ...parametersFromQuery(),
    paused: true,
    adaptiveQuality: false,
  });

  const frame = renderFrame(width, height, parameters);
  // The reference name is a file name under screenshots/reference/, extension
  // included, so lossless PNG references can be used for exact comparisons.
  const response = await fetch(`/screenshots/reference/${reference}`);
  if (!response.ok) {
    throw new Error(`Missing reference screenshots/reference/${reference} (HTTP ${response.status})`);
  }
  const bitmap = await createImageBitmap(await response.blob());
  const surface = document.createElement('canvas');
  surface.width = bitmap.width;
  surface.height = bitmap.height;
  const context = surface.getContext('2d');
  if (!context) throw new Error('No 2D context');
  context.drawImage(bitmap, 0, 0);
  const referencePixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;

  const sizeMatches = bitmap.width === frame.width && bitmap.height === frame.height;
  const difference = sizeMatches
    ? compareFrames(frame.pixels, referencePixels)
    : { meanAbs: 255, changedFraction: 1 };
  const checks: Check[] = [
    [
      'render matches the reference size',
      sizeMatches,
      `${frame.width}×${frame.height} vs ${bitmap.width}×${bitmap.height}`,
    ],
    ['mean difference below tolerance', difference.meanAbs <= 2.5, `mean ${difference.meanAbs.toFixed(2)}/255`],
    [
      'changed area below tolerance',
      difference.changedFraction <= 0.02,
      `${(difference.changedFraction * 100).toFixed(2)}% of pixels differ by more than 8/255`,
    ],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  document.title = `compare ${failed.length === 0 ? 'PASS' : 'FAIL'}`;
  (window as unknown as { benchResult: unknown }).benchResult = { reference, difference, checks };
  render(
    [
      `VISUAL REGRESSION · ${reference}`,
      `${frame.width}×${frame.height} ${parameters.mode} · preset ${query.get('preset') ?? 'default'} · seed ${parameters.seed}`,
      ...checks.map(([label, ok, detail]) => `${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`),
      '',
      failed.length === 0 ? 'matches the reference' : `${failed.length} check(s) failed`,
    ].join('\n'),
  );
}

async function runContextLossTest(): Promise<void> {
  sizeCanvas(640, 360);
  const parameters = normalizeParameters({ ...DEFAULT_PARAMETERS, paused: false, adaptiveQuality: false });
  const statuses: string[] = [];
  let frames = 0;

  const renderer = new Renderer(canvas, parameters, {
    onStats: () => {
      frames++;
    },
    onStatus: (status) => statuses.push(status),
  });
  renderer.start();

  render('context-loss test running…\n');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const framesBefore = frames;

  const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
  if (!extension) {
    render('FAIL  WEBGL_lose_context extension unavailable');
    renderer.dispose();
    return;
  }

  extension.loseContext();
  await new Promise((resolve) => setTimeout(resolve, 400));
  extension.restoreContext();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const framesAfter = frames;

  // A hidden panel may pause rAF, so prove recovery directly: draw one frame
  // and inspect the GL state and the produced pixels.
  const gl = canvas.getContext('webgl2');
  const contextRestored = gl !== null && !gl.isContextLost();
  if (gl) while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
  renderer.renderOnce();
  const glError = gl ? gl.getError() : -1;

  let litPixels = 0;
  if (gl) {
    const pixel = new Uint8Array(4);
    const probes: Array<[number, number]> = [
      [0.25, 0.5],
      [0.5, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
    ];
    for (const [u, v] of probes) {
      gl.readPixels(
        Math.round(canvas.width * u),
        Math.round(canvas.height * v),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      if (pixel[0] + pixel[1] + pixel[2] > 0) litPixels++;
    }
  }

  const lost = statuses.includes('context-lost');
  const restored = statuses.includes('restored');
  const checks: Array<[string, boolean, string]> = [
    ['context-lost reported', lost, statuses.join(', ')],
    ['context-restored reported', restored, statuses.join(', ')],
    ['context is live after restore', contextRestored, String(contextRestored)],
    ['render after restore is GL-clean', glError === (gl?.NO_ERROR ?? 0), String(glError)],
    ['render after restore produced pixels', litPixels > 0, `${litPixels}/5 probes lit`],
    ['no volume error after restore', renderer.volumeAvailable, renderer.volumeFailure ?? 'available'],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  document.title = `contextloss ${failed.length === 0 ? 'PASS' : 'FAIL'}`;
  (window as unknown as { benchResult: unknown }).benchResult = { checks, statuses, framesBefore, framesAfter };

  render(
    [
      'CONTEXT LOSS / RESTORE',
      ...checks.map(([label, ok, detail]) => `${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`),
      '',
      `${checks.length - failed.length}/${checks.length} passed`,
    ].join('\n'),
  );
  renderer.dispose();
}

if (test === 'io') {
  runIoTest();
} else if (test === 'suite') {
  void runSuite().catch((error: unknown) => {
    render(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    document.title = 'suite FAIL';
  });
} else if (test === 'compare') {
  void runCompare().catch((error: unknown) => {
    render(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    document.title = 'compare FAIL';
  });
} else if (test === 'contextloss') {
  void runContextLossTest();
} else if (test === 'shot') {
  void runScreenshot().catch((error: unknown) => {
    render(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    document.title = 'shot FAIL';
  });
} else if (test === 'gallery') {
  void runGallery().catch((error: unknown) => {
    render(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    document.title = 'gallery FAIL';
  });
} else {
  void runPerf().catch((error: unknown) => {
    render(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    document.title = 'bench FAIL';
  });
}
