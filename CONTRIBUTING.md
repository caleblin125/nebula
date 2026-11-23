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

## Tests

The project has a dependency-free self-test suite and fixed-seed visual
regressions. Run both from a dev server before opening a pull request:

```text
bench.html?test=suite                         # 53 checks, all must pass
bench.html?test=compare&ref=orion-deep-2d.png&preset=orion-deep&w=640&h=400
bench.html?test=compare&ref=orion-deep-volume.png&mode=volume&steps=32&preset=orion-deep&w=640&h=400
```

The suite covers normalization, import/export, presets, exact sRGB conversion,
shader compilation and initialization, reproducibility, density bounds and the
envelope, and context loss/restore. The comparison renders through the same
`renderFrame` path as the captures and must match the lossless PNG in
`screenshots/reference/` within the stated tolerance.

A shader that fails to compile makes the renderer fall back to 2D silently, so
always confirm the mode in the harness output; the suite and comparison both
assert it rather than recording a fallback as a pass.

When the look changes on purpose, regenerate the references with `test=shot`
using `format=png` and move the file into `screenshots/reference/`, then commit
the new image with the change.

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
  bench.html?test=shot&w=1600&h=1000&preset=carina-core&name=before.jpg
  bench.html?test=shot&w=1600&h=1000&preset=carina-core&name=after.jpg
  ```

- Volume changes should report the draw cost from `bench.html?mode=volume`,
  not presentation FPS, so results are comparable. The HUD's noise estimate is a
  model of the sampler, not a measurement; cite draw cost.

## Style

- Strict TypeScript, two-space indentation, single quotes, trailing commas.
- No new runtime dependencies unless the project cannot reasonably do without
  them. The point is to keep the renderer readable and framework-free.
- Match the existing module boundaries: `Parameters` flows into the renderer,
  the UI only mutates parameters, and the renderer does not know about DOM
  controls.
