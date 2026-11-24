# Embedding Nebula

The library is the same renderer the demo uses, exposed as one class and a
versioned configuration. It has no UI framework dependency and no runtime
dependency beyond WebGL2.

## Build

```bash
npm install
npm run build:lib
```

Outputs:

```text
dist-lib/nebula.js              ESM bundle (GLSL included as strings)
dist-lib/nebula.cjs             CommonJS bundle
dist-lib/nebula.js.map          source map
dist-lib/types/…/index.d.ts     declarations for the public entry point
```

`npm run build` builds both the demo (`dist/`) and the library (`dist-lib/`).
The package `exports` map points `import` at the ESM bundle, `require` at the
CommonJS bundle and `types` at the declarations.

## Basic use

```ts
import { Nebula } from 'nebula';

const nebula = new Nebula({
  container: document.querySelector('#stage')!,
  autoStart: true,
});

nebula.on('ready', ({ capabilities }) => {
  console.log(capabilities.renderer, capabilities.volume);
});

nebula.on('error', ({ message }) => console.warn(message));
```

Pass an existing `canvas` instead of a `container` when the page owns its
markup. When a container is used the library creates a canvas that fills it;
give the container a size.

## Lifecycle

| Call | Effect |
|---|---|
| `new Nebula(options)` | Compile shaders, observe size, optionally start the loop |
| `render(seconds)` | Draw exactly one frame at that shader time |
| `render()` | Redraw at the current time |
| `start()` / `stop()` | Enable/disable the built-in animation loop |
| `dispose()` | Stop, release GL resources, detach listeners and the owned canvas |

`autoStart` defaults to `true`. With `autoStart: false` the instance renders
only when asked, which makes deterministic stills and host-driven render loops
straightforward:

```ts
const nebula = new Nebula({ canvas, autoStart: false });

function frame(nowMs: number) {
  nebula.render(nowMs / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

`render(t)` sets the shader clock to `t`, so the same seed and `t` always
produce the same frame. Playback state (`paused`) only affects the built-in
loop; it does not block manual rendering.

## Configuration

```ts
import { parseConfig, serializeConfig } from 'nebula';

const config = {
  seed: 90210,
  generation: {
    density: 0.9,
    scale: 1.4,
    warp: 1.1,
    octaves: 6,
    detail: 0.7,
    lacunarity: 2.02,
    persistence: 0.5,
    rotation: -0.08,
    palette: 'violet',
  },
  rendering: {
    mode: 'volume',
    renderScale: 1,
    adaptiveQuality: true,
    volumeSteps: 40,
    emission: 1.3,
    exposure: 1.1,
    starDensity: 0.5,
    vignette: 0.5,
    animationSpeed: 0.35,
  },
  camera: { position: null, target: [0, 0, 0], fov: 0.66, zoom: 1 },
};

const nebula = new Nebula({ container, config });
const json = serializeConfig(nebula.getConfig());
const upgraded = parseConfig(json);
```

`serializeConfig` writes `{ format: 'nebula-config', version: 1, seed,
generation, rendering, camera }`. Missing fields are filled from defaults and
every value is clamped. `normalizeConfig` accepts partial envelopes, bare
parameter objects and legacy `nebula-parameters` exports. A configuration with
a version newer than the build throws `ConfigError` instead of being
half-imported.

`paused` is host playback state and is deliberately not serialized.
`setConfig` replaces the whole configuration; `setParameters`,
`updateParameters`, `setGeneration`, `setRendering` and `setCamera` merge.

## Camera

The camera is independent of the nebula generation parameters.

```ts
nebula.setCamera({ position: [2.8, 0.2, 0.2], target: [0, 0.05, 0], fov: 0.66 });
nebula.setCamera({ zoom: 1.4 });       // keeps position/direction
nebula.setCamera({ position: null });  // back to the built-in orbit
nebula.setCameraPreset('wide');        // default | wide | close | high | side
nebula.resetCamera();
```

`position: null` selects the original slow orbit, so existing volume frames
are unchanged. An explicit position freezes the view while the gas continues to
animate. `fov` is a field scale (larger is wider) and `zoom` divides it. The 2D
mode ignores camera settings. Invalid numbers and a camera placed exactly on its
target have no view direction, so they fall back to the orbit instead of
producing an empty frame.

## Events

```ts
const off = nebula.on('performance', (stats) => {
  hud.textContent = `${stats.fps.toFixed(0)} fps · ${stats.frameMs.toFixed(1)} ms`;
});

// later
off();
```

| Event | Payload | When |
|---|---|---|
| `ready` | `{ stats, capabilities }` | Rendering pipeline initialized (microtask) |
| `error` | `{ message, error? }` | Recoverable problem, e.g. volume shader fallback |
| `configurationchange` | `{ config, parameters }` | Public configuration API changed the look |
| `render` | `{ time }` | After every drawn frame |
| `performance` | `RendererStats` | Throttled frame statistics (about 5 Hz) |
| `contextlost` | `{ time }` | WebGL context lost |
| `contextrestored` | `{ time }` | Context rebuilt; call `render()` if driving manually |

`on` returns an unsubscribe function; `once` and `off` are also available.

## Several instances

Each `Nebula` owns its canvas, WebGL2 context, configuration and camera. Two
instances can run different seeds, modes or cameras on one page. `dispose()`
only tears down that instance.

## Errors

`Nebula` construction throws `NebulaError` with a `code`:

| Code | Meaning |
|---|---|
| `no-target` | Neither `canvas` nor `container` was supplied |
| `webgl2-unavailable` | The browser could not create a WebGL2 context |
| `configuration` | Invalid configuration, or use after `dispose()` |
| `unknown-camera-preset` | `setCameraPreset` was given an unknown id |

`Nebula.isSupported()` probes for WebGL2 without constructing a renderer.
`getCapabilities()` reports volume/bloom/GPU-timer support, the maximum texture
size and the unmasked GPU name when the driver exposes it.

## Verifying the package

[`examples/embed`](../examples/embed) installs the repository with
`"nebula": "file:../.."` and imports only `nebula`:

```bash
cd examples/embed
npm install
npm run check   # Node: ESM + CJS entry points, config and camera helpers
npm run dev     # browser example
npm run build
```
