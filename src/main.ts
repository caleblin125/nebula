/**
 * Demo application shell.
 *
 * The demo is an ordinary consumer of the public library entry point: it builds
 * a versioned configuration, constructs `Nebula`, wires telemetry/events and
 * mounts the development control panel. Nothing in the library depends on this
 * file, the stylesheet or the page markup.
 */

import './style.css';

import {
  DEFAULT_PARAMETERS,
  DEFAULT_CAMERA,
  Nebula,
  NebulaError,
  PALETTES,
  applyPreset,
  detectPreset,
  fromParameters,
  normalizeParameters,
  normalizeSeed,
  parseConfig,
  presetById,
  randomSeed,
  serializeConfig,
  type NebulaParameters,
  type RendererStats,
} from './library';
import { Controls } from './ui/Controls';

function mustElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in the document.`);
  return node as T;
}

const canvas = mustElement<HTMLCanvasElement>('nebula-canvas');
const controlsRoot = mustElement<HTMLElement>('controls');
const notice = mustElement<HTMLElement>('notice');

const statFps = mustElement<HTMLElement>('stat-fps');
const statMs = mustElement<HTMLElement>('stat-ms');
const statGpu = mustElement<HTMLElement>('stat-gpu');
const statRes = mustElement<HTMLElement>('stat-res');
const statCost = mustElement<HTMLElement>('stat-cost');
const statMode = mustElement<HTMLElement>('stat-mode');

let toastTimer = 0;

function showToast(message: string): void {
  let toast = document.querySelector<HTMLElement>('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.getElementById('stage')?.append(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.classList.remove('show'), 1800);
}

function showNotice(title: string, message: string, actionLabel?: string, action?: () => void): void {
  notice.replaceChildren();
  const card = document.createElement('div');
  card.className = 'notice-card';

  const heading = document.createElement('h2');
  heading.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = message;

  card.append(heading, paragraph);
  if (actionLabel && action) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.type = 'button';
    button.textContent = actionLabel;
    button.addEventListener('click', action);
    card.append(button);
  }

  notice.append(card);
  notice.hidden = false;
}

function hideNotice(): void {
  notice.hidden = true;
}

function initialParameters(): NebulaParameters {
  const query = new URLSearchParams(window.location.search);
  let parameters = normalizeParameters(DEFAULT_PARAMETERS);

  const preset = presetById(query.get('preset') ?? '');
  if (preset) parameters = applyPreset(parameters, preset);

  const seed = query.get('seed');
  if (seed !== null) parameters.seed = normalizeSeed(Number(seed));

  if (query.get('mode') === 'volume') parameters.mode = 'volume';
  if (query.get('static') === '1') {
    parameters.paused = true;
  }
  return parameters;
}

function updateStats(stats: RendererStats): void {
  statFps.textContent = String(Math.round(stats.fps));
  statMs.textContent = stats.frameMs.toFixed(1);
  statGpu.textContent = stats.gpuMs === null ? 'n/a' : stats.gpuMs.toFixed(1);
  statRes.textContent = `${stats.bufferWidth}×${stats.bufferHeight}`;
  statCost.textContent = `≈${stats.noisePerPixel}/px`;
  statCost.title = `${stats.noisePerPixel} noise evaluations per pixel · shaders compiled in ${stats.compileMs.toFixed(0)} ms`;
  statMode.textContent = stats.mode === 'volume' ? '3D' : '2D';
  statMode.title = stats.mode === 'volume' ? 'Raymarched volume' : 'Screen-space field';
}

function syncUrl(parameters: NebulaParameters): void {
  // Keep development-only query flags (debug views) intact.
  const query = new URLSearchParams(window.location.search);
  query.delete('seed');
  query.delete('preset');
  query.delete('mode');
  query.set('seed', String(parameters.seed));
  const preset = detectPreset(parameters);
  if (preset !== 'custom') query.set('preset', preset);
  if (parameters.mode === 'volume') query.set('mode', 'volume');
  const next = `${window.location.pathname}?${query.toString()}`;
  window.history.replaceState(null, '', next);
}

function main(): void {
  const parameters = initialParameters();

  // Clean capture mode for screenshots and embedding (?ui=0).
  if (new URLSearchParams(window.location.search).get('ui') === '0') {
    document.documentElement.classList.add('hide-ui');
  }

  let nebula: Nebula;
  try {
    nebula = new Nebula({
      canvas,
      config: fromParameters(parameters, DEFAULT_CAMERA),
      paused: parameters.paused,
      autoStart: true,
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof NebulaError && error.code === 'webgl2-unavailable') {
      showNotice(
        'WebGL2 unavailable',
        `${message}\n\nTry a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.`,
      );
    } else {
      showNotice('Nebula failed to start', message);
    }
    return;
  }

  document.documentElement.style.setProperty('--accent', PALETTES[parameters.palette].accent);
  document.documentElement.style.setProperty(
    '--accent-soft',
    PALETTES[parameters.palette].accent + '38',
  );

  nebula.on('performance', updateStats);
  nebula.on('error', ({ message }) => showToast(message));
  nebula.on('contextlost', () => {
    showNotice(
      'Graphics context lost',
      'The browser released the GPU context. Rendering will resume automatically when it is restored.',
    );
  });
  nebula.on('contextrestored', () => {
    hideNotice();
    showToast('Rendering restored');
  });

  const debugParam = new URLSearchParams(window.location.search).get('debug');
  if (debugParam) {
    const views: Record<string, number> = {
      density: 1,
      cloud: 2,
      filament: 3,
      shape: 4,
      mask: 5,
    };
    nebula.setDebugView(views[debugParam] ?? 0);
  }

  let urlTimer = 0;
  let controls: Controls | undefined;
  const applyParameters = (next: NebulaParameters, fromPanel: boolean): void => {
    nebula.setParameters(next);
    if (!fromPanel) controls?.setParameters(next);
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => syncUrl(next), 250);
  };

  controls = new Controls(controlsRoot, {
    parameters,
    onChange: (next) => applyParameters(next, true),
    onNotice: showToast,
    volumeAvailable: nebula.volumeAvailable,
    onExport: () => serializeConfig(nebula.getConfig()),
    onImport: (text) => {
      nebula.setConfig(parseConfig(text));
      return nebula.getParameters();
    },
  });

  if (!nebula.volumeAvailable) {
    controls.setVolumeAvailable(false);
  }

  // Telemetry starts immediately, even before the first animation frame.
  updateStats(nebula.getStats());
  syncUrl(parameters);

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
      return;
    }

    const current = nebula.getParameters();
    if (event.code === 'Space') {
      event.preventDefault();
      const next = { ...current, paused: !current.paused };
      applyParameters(next, false);
      showToast(next.paused ? 'Time frozen' : 'Time running');
    } else if (event.key.toLowerCase() === 'r') {
      applyParameters({ ...current, seed: randomSeed() }, false);
      showToast('New seed');
    }
  });

  // Expose a tiny debugging handle for console experiments.
  Object.assign(window, {
    nebula: {
      instance: nebula,
      get parameters() {
        return nebula.getParameters();
      },
      get config() {
        return nebula.getConfig();
      },
    },
  });
}

main();
