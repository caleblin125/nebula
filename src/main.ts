/**
 * Application shell: mounts the renderer, telemetry and controls.
 *
 * Nothing in here is required by the renderer itself — the same modules can be
 * embedded in another page by constructing `Renderer` and `Controls`.
 */

import './style.css';

import { Renderer, type RendererStats } from './renderer/Renderer';
import { Controls } from './ui/Controls';
import {
  DEFAULT_PARAMETERS,
  PALETTES,
  normalizeParameters,
  type NebulaParameters,
} from './simulation/Parameters';
import { applyPreset, detectPreset, presetById } from './simulation/Presets';
import { normalizeSeed, randomSeed } from './utils/Random';

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

function updateStats(stats: RendererStats, compileMs: number): void {
  statFps.textContent = String(Math.round(stats.fps));
  statMs.textContent = stats.frameMs.toFixed(1);
  statGpu.textContent = stats.gpuMs === null ? 'n/a' : stats.gpuMs.toFixed(1);
  statRes.textContent = `${stats.bufferWidth}×${stats.bufferHeight}`;
  statCost.textContent = `≈${stats.noisePerPixel}/px`;
  statCost.title = `${stats.noisePerPixel} noise evaluations per pixel · shaders compiled in ${compileMs.toFixed(0)} ms`;
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
  let renderer: Renderer;

  try {
    renderer = new Renderer(canvas, parameters, {
      onStats: (stats) => updateStats(stats, stats.compileMs),
      onStatus: (status) => {
        if (status === 'context-lost') {
          showNotice(
            'Graphics context lost',
            'The browser released the GPU context. Rendering will resume automatically when it is restored.',
          );
        } else if (status === 'restored') {
          hideNotice();
          showToast('Rendering restored');
        }
      },
      onError: (message) => showToast(message),
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    showNotice(
      'WebGL2 unavailable',
      `${message}\n\nTry a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.`,
    );
    return;
  }

  document.documentElement.style.setProperty('--accent', PALETTES[parameters.palette].accent);
  document.documentElement.style.setProperty(
    '--accent-soft',
    PALETTES[parameters.palette].accent + '38',
  );

  const debugParam = new URLSearchParams(window.location.search).get('debug');
  if (debugParam) {
    const views: Record<string, number> = {
      density: 1,
      cloud: 2,
      filament: 3,
      shape: 4,
      mask: 5,
    };
    renderer.setDebugView(views[debugParam] ?? 0);
  }

  let urlTimer = 0;
  let controls: Controls | undefined;
  const applyParameters = (next: NebulaParameters, fromPanel: boolean): void => {
    renderer.setParameters(next);
    if (!fromPanel) controls?.setParameters(next);
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => syncUrl(next), 250);
  };

  controls = new Controls(controlsRoot, {
    parameters,
    onChange: (next) => applyParameters(next, true),
    onNotice: showToast,
    volumeAvailable: renderer.volumeAvailable,
  });

  if (!renderer.volumeAvailable) {
    controls.setVolumeAvailable(false);
  }

  // Telemetry starts immediately, even before the first animation frame.
  updateStats(renderer.getStats(), 0);
  syncUrl(parameters);

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      const next = { ...renderer.getParameters(), paused: !renderer.getParameters().paused };
      applyParameters(next, false);
      showToast(next.paused ? 'Time frozen' : 'Time running');
    } else if (event.key.toLowerCase() === 'r') {
      const next = { ...renderer.getParameters(), seed: randomSeed() };
      applyParameters(next, false);
      showToast('New seed');
    }
  });

  // Expose a tiny debugging handle for console experiments.
  Object.assign(window, {
    nebula: {
      renderer,
      get parameters() {
        return renderer.getParameters();
      },
    },
  });
}

main();
