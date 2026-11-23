# Contributing

Issues and pull requests are welcome. This is a small, focused rendering
project, so keeping changes narrow and measurable is more useful than large
rewrites.

## Setup

```bash
npm install
npm run dev      # http://localhost:5183/
```

Node 20 or newer is required. The dev server uses a fixed port so the bench
URLs in the documentation stay valid.

## Before opening a pull request

```bash
npm run typecheck
npm run build
```

Both must pass. If the change affects rendering, also check it in 2D and volume
mode and across a few presets, since they exercise different density ranges and
palettes.

## Shader changes

- Keep GLSL in `src/shaders/*.glsl` and assemble it through `ShaderProgram`;
  avoid string-concatenated shader code in TypeScript.
- Density stays independent of color. If a change adds structure, express it in
  `density.glsl`; if it changes light, put it in `color.glsl` or the composition
  shader.
- Preserve determinism: no unseeded randomness, and any time-varying term must
  be a pure function of `uTime`.
- For visible changes, include a before/after frame. Use the capture harness:

  ```text
  bench.html?test=shot&w=1920&h=1080&preset=carina-core&name=before.jpg
  bench.html?test=shot&w=1920&h=1080&preset=carina-core&name=after.jpg
  ```

- Volume changes should report the draw cost from `bench.html?mode=volume`,
  not presentation FPS, so results are comparable.

## Style

- Strict TypeScript, two-space indentation, single quotes, trailing commas.
- No new runtime dependencies unless the project cannot reasonably do without
  them. The point is to keep the renderer readable and framework-free.
- Match the existing module boundaries: `Parameters` flows into the renderer,
  the UI only mutates parameters, and the renderer does not know about DOM
  controls.
