/**
 * Reproducible benchmark and self-test harness (development only).
 *
 *   /bench.html?w=1920&h=1080&preset=orion-deep
 *   /bench.html?mode=volume&w=1280&h=720
 *   /bench.html?test=io
 *   /bench.html?test=contextloss
 *
 * Perf mode measures two things separately:
 *   - presentation cadence from requestAnimationFrame (vsync-limited), and
 *   - draw cost from a synchronous batch of forced frames plus gl.finish(),
 *     which is independent of the display refresh rate.
 */

import { Renderer, type RendererStats } from './renderer/Renderer';
import {
  DEFAULT_PARAMETERS,
  normalizeParameters,
  parseParameters,
  serializeParameters,
  type NebulaParameters,
} from './simulation/Parameters';
import { applyPreset, presetById } from './simulation/Presets';
import { normalizeSeed } from './utils/Random';

const query = new URLSearchParams(window.location.search);
const canvas = document.getElementById('bench-canvas') as HTMLCanvasElement;
const out = document.getElementById('bench-out') as HTMLPreElement;

type Test = 'perf' | 'io' | 'contextloss' | 'shot';

const test = (query.get('test') ?? 'perf') as Test;

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

/**
 * Render one frame at a fixed buffer size and hand the PNG/JPEG to the
 * browser as a download. Used to capture documentation screenshots on a
 * machine whose browser panel is narrower than the target image.
 */
async function runScreenshot(): Promise<void> {
  const width = Math.round(numberParam('w', 2160));
  const height = Math.round(numberParam('h', 1350));
  const mime = query.get('format') === 'png' ? 'image/png' : 'image/jpeg';

  sizeCanvas(width, height);
  canvas.style.opacity = '1';
  canvas.style.zIndex = '0';

  const parameters = normalizeParameters({ ...parametersFromQuery(), paused: true });
  const renderer = new Renderer(canvas, parameters);
  renderer.renderOnce();

  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('No WebGL2 context');

  // Volume mode renders below CSS resolution, so read the real buffer rather
  // than the requested display size.
  const bufferWidth = canvas.width;
  const bufferHeight = canvas.height;
  const pixels = new Uint8Array(bufferWidth * bufferHeight * 4);
  gl.readPixels(0, 0, bufferWidth, bufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // WebGL rows start at the bottom; ImageData expects top-down.
  const flipped = new Uint8ClampedArray(pixels.length);
  const rowBytes = bufferWidth * 4;
  for (let y = 0; y < bufferHeight; y++) {
    const source = (bufferHeight - 1 - y) * rowBytes;
    flipped.set(pixels.subarray(source, source + rowBytes), y * rowBytes);
  }

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

  const preset = query.get('preset') ?? 'custom';
  const extension = mime === 'image/png' ? 'png' : 'jpg';
  const name =
    query.get('name') ??
    `nebula-${preset}-${parameters.mode}-${bufferWidth}x${bufferHeight}.${extension}`;

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

  const url = URL.createObjectURL(blob);
  const preview = document.createElement('img');
  preview.src = url;
  preview.alt = name;
  preview.style.cssText =
    'display:block;width:100%;max-width:900px;margin-top:10px;border:1px solid rgba(160,190,235,.25);border-radius:6px;';
  document.body.append(preview);

  render(
    [
      'SCREENSHOT',
      `${bufferWidth}×${bufferHeight} ${parameters.mode} · ${preset} · seed ${parameters.seed}`,
      `requested ${width}×${height} (pipeline scale ${(bufferWidth / width).toFixed(2)})`,
      `${(blob.size / 1024).toFixed(0)} KB ${extension.toUpperCase()}`,
      saved,
    ].join('\n'),
  );
  document.title = `shot ${name}`;
  (window as unknown as { benchResult: unknown }).benchResult = {
    name,
    width: bufferWidth,
    height: bufferHeight,
    bytes: blob.size,
    saved,
  };

  renderer.dispose();
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
} else if (test === 'contextloss') {
  void runContextLossTest();
} else if (test === 'shot') {
  void runScreenshot().catch((error: unknown) => {
    render(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    document.title = 'shot FAIL';
  });
} else {
  void runPerf().catch((error: unknown) => {
    render(`FAIL  ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    document.title = 'bench FAIL';
  });
}
