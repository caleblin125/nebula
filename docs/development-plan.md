# Procedural Nebula Renderer — Working Plan

Status: complete
Goal: organic, mathematically coherent nebula structures rendered on the GPU with WebGL2 + GLSL ES 3.00, animated, controllable, reproducible, and profiled.

## Ground rules

- TypeScript + Vite, WebGL2 only. No rendering libraries.
- Rendering is independent of the page shell and of the UI module.
- Everything visual must be explainable by the density / emission model.
- Commit at every coherent step (build passes → commit).
- Determinism: a seed + parameter set must always yield the same image.

## Architecture

```
src/
├── main.ts                  boot, context-loss handling, loop, HUD wiring
├── renderer/
│   ├── Renderer.ts          2D nebula pass + volumetric mode switch
│   ├── ShaderProgram.ts     compile/link, uniform reflection, hot status
│   ├── FullscreenTriangle.ts VAO-less fullscreen triangle
│   ├── Uniforms.ts          typed uniform setter + caching
│   ├── PostFx.ts            scene target + bloom passes
│   └── PerformanceMonitor.ts frame stats, GPU timer query
├── shaders/
│   ├── vertex.glsl          fullscreen triangle (positions + uv)
│   ├── nebula.frag          2D composition (density → emission → stars)
│   ├── volume.frag          raymarched 3D nebula
│   ├── post.frag            bloom bright/blur/composite
│   ├── noise.glsl           2D/3D gradient noise, fBm, ridged, warp
│   ├── density.glsl         density field model, shared by both renderers
│   ├── color.glsl           palettes, emission ramp, tonemap
│   └── stars.glsl           procedural star field
├── simulation/
│   ├── Parameters.ts        parameter schema, defaults, clamp/serialize
│   └── Presets.ts           curated presets
├── ui/
│   └── Controls.ts          panel built from the schema
├── utils/
│   └── Random.ts            deterministic PRNG helpers
└── bench.ts                 benchmark, self-tests, screenshot capture
```

Data flow: `Parameters` → uniforms → shader. `Controls` only mutates `Parameters`.
UI and renderer communicate through a small callback interface.

## Mathematical model (2D)

1. **Noise**: quintic-interpolated 2D gradient noise (hash-based, no texture).
2. **fBm**: `F(p) = Σ a_i N(f_i p)`, rotation between octaves to suppress axis alignment.
3. **Ridged**: `1 - |N|` folded fBm, squared for filament sharpening.
4. **Domain warp**: `q = p + k·(A(p), B(p))`, two levels with different scales and
   animation drift; warp amplitudes kept small enough to preserve cloud identity.
5. **Density**: a three-scale signed sheet shaped by a soft threshold
   `smoothstep(t0, t1, ·)`, modulated by a spatially gated turbulence/clump term
   and high-frequency erosion. The two largest scales carry the silhouette; fine
   noise lives in erosion and filaments.
6. **Filaments**: the zero-crossing iso-line of two crossing gradient-noise
   fields, plus a finer lace family. An iso-line is thin and connected where a
   thresholded ridge is a broad, broken blob.
7. **Dust**: a separate wider crease family returned as an absorption term, never
   subtracted from density.
8. **Emission**: density → emission ramp with a core/ionization term; color from
   palette stops; emission is grain-modulated so only structured gas glows.
9. **Composition**: dust-absorbed background and envelope, additive emission,
   vignette, ACES-ish tonemap, exact sRGB, dithering to fight banding.
10. **Bloom**: bright extract + quarter-resolution downsample, two separable
    gaussian blurs, additive composite in display space.

## Mathematical model (3D / volume)

Camera ray → epsilon-safe slab intersection with the unit cube → fixed steps
front to back, integrating gas and dust extinction separately:

```text
αg = 1 - exp(-σg Δs);  αd = 1 - exp(-σd Δs)
C += T · αg · emission(σg);  T *= 1 - (αg + αd(1 - αg))
```

The extinction already carries `Δs`, so the source is not step-weighted. The
field is a warp + four base + two medium + two fine octaves with `ridged3`
veils, a mask-displaced spherical envelope, and two soft dust shells. Sampling
uses an exact empty-space early-out, 2.6× empty-space stepping, slab-exit and
transmittance termination. Four debug views expose the field independent of the
camera.

## Phases

### Phase 0 — Project setup
- [x] git init, package.json, tsconfig, vite config, index.html, styles
- [x] Working plan (this file)
- [x] Renderer skeleton compiles

### Phase 1 — Minimal renderer
- [x] Fullscreen triangle, WebGL2 context, resize with DPR cap
- [x] Gradient noise + fBm, static cloud preview
- [x] Context-loss recovery, WebGL2 fallback message

### Phase 2 — Nebula formation
- [x] Two-level domain warping
- [x] Multi-scale density model with soft thresholds
- [x] Ridged filament layer, spatial mask, density remap

### Phase 3 — Visual refinement
- [x] Palette + emission mapping, dense cores, dark negative space
- [x] Stars, vignette, grain, tonemap
- [x] Screenshot review & tuning (multiple resolutions)

### Phase 4 — Animation and controls
- [x] Slow evolving field (time-driven warp + noise translation + optional rotation)
- [x] Parameter schema + controls (seed, density, scale, warp, octaves, emission, speed, palette)
- [x] Presets, reset, seed randomize, JSON export/import
- [x] Deterministic seed handling

### Phase 5 — Optimization
- [x] Render-resolution scale, adaptive quality
- [x] GPU timer queries + frame stats HUD
- [x] Shader cost reduction (shared octaves, loop bounds via uniforms/defines)
- [x] Document measurements

### Phase 6 — Volumetric extension
- [x] 3D gradient noise + 3D domain warp
- [x] Raymarch with transmittance / emission accumulation
- [x] Early termination, adaptive step, jitter
- [x] Compare with 2D renderer, document findings

### Phase 7 — Deliverables
- [x] README (dev instructions, math, measurements, limits)
- [x] Screenshots directory
- [x] Final polish pass and commit history

### Phase 8 — Engineering pass
- [x] Correctness audit (envelope direction, step-weighting, background
      transmittance, epsilon-safe slab test, exact sRGB, animation scaling)
- [x] 2D redesign: sheet + zero-crossing filaments + separate dust absorption
- [x] Volume rebuild: sample hierarchy, veils, two dust shells, ragged envelope
- [x] Measured optimization: early-out, 2.6× skip, slab exit, 48 steps
- [x] Dependency-free self-test suite (53 checks) and PNG visual regressions
- [x] Documentation refresh and change report

## Validation checklist

- [x] Compiles with `tsc --noEmit`
- [x] `npm run build` succeeds
- [x] Renders at 720p / 1080p / 1600×1000 without errors
- [x] No console errors, no GL warnings
- [x] Controls all affect output
- [x] Import/export round-trips
- [x] Context loss restores rendering
- [x] Star field sparse and stable
- [x] Volume mode has no obvious stepping/banding
- [x] Self-test suite passes 53/53
- [x] Fixed-seed visual regressions match for 2D and volume

## Measured results

Hardware: Intel Graphics (0xA7AC), ANGLE D3D11. Draw cost was measured with
forced synchronous frames (not vsync), adaptive quality off, median of 24
synced frames.

| Mode | 1280×720 | 1920×1080 |
|---|---:|---:|
| 2D field (full resolution) | 13.1 ms | 26.6 ms |
| Volume (922×518 / 1382×778, 48 steps) | 31.9 ms | 69.6 ms |

Before this engineering pass the same measurements were 15.5 / 31.7 ms for 2D
and 61.7 / 136.3 ms for the volume, so the pass removed about 15% and 48%
respectively without lowering the visible quality. 1440p was not remeasured.

Shader compile: 44–55 ms warm, >2 s cold. Noise cost: ~50 evaluations/pixel in
2D, ~346 in volume at 48 steps (the HUD model now includes the fine and dust
work). Volume cost fits `4.3 ms + 0.59 ms × steps`.

Volume optimisations that mattered: exact early-out for samples whose coarse
fields cannot reach the threshold (seven evaluations instead of thirteen), one
warp octave, four base / two medium / two fine octaves, 2.6× empty-space
stepping, stopping at the slab exit, and 48 steps instead of 56.

Remaining limitation: the volume is still heavy on integrated graphics. Adaptive
quality brings 1080p volume to roughly 25 fps at its 0.55 floor; lower volume
steps and render scale manually for more.

## Validation notes

- Console check was performed after fixing a feedback loop in the bloom's
  first pass (the previous frame's bloom texture remained bound to unit 1 while
  that texture was the new render target).
- `bench.html?test=suite` runs 53 checks across normalization, import/export,
  presets, exact sRGB conversion, shader compilation and init, reproducibility,
  density bounds and envelope, and context loss/restore.
- `bench.html?test=compare` renders a fixed-seed frame through the same path as
  the captures and compares it with a lossless PNG in `screenshots/reference/`.
  It asserts the requested mode is active, so a silent 2D fallback cannot pass.
- `bench.html?test=io` and `bench.html?test=contextloss` remain available as
  focused checks.
- The screenshot pipeline (`bench.html?test=shot`) renders at a fixed size
  independent of the browser panel and writes into `screenshots/`.
