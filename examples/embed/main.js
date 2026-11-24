/**
 * Embed example: a plain page that consumes the installed `nebula` package.
 *
 * It never imports files from the repository's `src/` tree, only the public
 * entry point resolved by the package's `exports` map.
 */

import { Nebula, NebulaError, randomSeed } from 'nebula';

const stage = document.getElementById('stage');
const status = document.getElementById('status');
const playButton = document.getElementById('toggle-play');

/** @type {Nebula} */
let nebula;

try {
  nebula = new Nebula({
    container: stage,
    config: {
      seed: 90210,
      generation: { density: 0.85, warp: 1.1, palette: 'violet', rotation: -0.08 },
      rendering: { mode: 'volume', volumeSteps: 40 },
      camera: { position: null, target: [0, 0, 0], fov: 0.66, zoom: 1 },
    },
    autoStart: true,
  });
} catch (error) {
  status.textContent =
    error instanceof NebulaError ? `${error.code}: ${error.message}` : String(error);
  throw error;
}

nebula.on('ready', ({ capabilities }) => {
  status.textContent =
    `${capabilities.renderer} · volume ${capabilities.volume ? 'yes' : 'no'}` +
    ` · bloom ${capabilities.bloom ? 'yes' : 'no'} · GPU timer ${capabilities.gpuTimer ? 'yes' : 'no'}`;
});
nebula.on('error', ({ message }) => {
  status.textContent = message;
});
nebula.on('contextlost', () => {
  status.textContent = 'Context lost — waiting for restore…';
});
nebula.on('contextrestored', () => {
  status.textContent = 'Context restored';
});

for (const button of document.querySelectorAll('[data-camera]')) {
  button.addEventListener('click', () => {
    nebula.setCameraPreset(button.dataset.camera);
    status.textContent = `camera: ${button.dataset.camera}`;
  });
}

playButton.addEventListener('click', () => {
  const paused = !nebula.getParameters().paused;
  nebula.updateParameters({ paused });
  playButton.textContent = paused ? 'Resume' : 'Pause';
});

document.getElementById('still').addEventListener('click', () => {
  // Manual rendering: stop the internal loop and draw one deterministic frame.
  nebula.stop();
  nebula.render(0);
  playButton.textContent = 'Resume';
  status.textContent = 'manual frame at t=0';
});

document.getElementById('reseed').addEventListener('click', () => {
  const seed = randomSeed();
  nebula.updateParameters({ seed });
  status.textContent = `seed ${seed}`;
  if (!nebula.isRunning) nebula.start();
  playButton.textContent = 'Pause';
});

window.embedExample = nebula;
