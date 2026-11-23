# Procedural Nebula Renderer — Working Plan

Status: in progress
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
│   └── PerformanceMonitor.ts frame stats, GPU timer query
├── shaders/
│   ├── vertex.glsl          fullscreen triangle (positions + uv)
│   ├── nebula.frag          2D composition (density → emission → stars)
│   ├── volume.frag          raymarched 3D nebula
│   ├── noise.glsl           2D/3D gradient noise, fBm, ridged, warp
│   ├── density.glsl         density field model, shared by both renderers
│   ├── color.glsl           palettes, emission ramp, tonemap
│   └── stars.glsl           procedural star field
├── simulation/
│   ├── Parameters.ts        parameter schema, defaults, clamp/serialize
│   └── Presets.ts           curated presets
├── ui/
│   └── Controls.ts          panel built from the schema
└── utils/
    └── Random.ts            deterministic PRNG helpers
```

Data flow: `Parameters` → uniforms → shader. `Controls` only mutates `Parameters`.
UI and renderer communicate through a small callback interface.

## Mathematical model (2D)

1. **Noise**: quintic-interpolated 2D gradient noise (hash-based, no texture).
2. **fBm**: `F(p) = Σ a_i N(f_i p)`, rotation between octaves to suppress axis alignment.
3. **Ridged**: `1 - |N|` folded fBm, squared for filament sharpening.
4. **Domain warp**: `q = p + k·(A(p), B(p))`, two levels with different scales and
   animation drift; warp amplitudes kept small enough to preserve cloud identity.
5. **Density**: weighted sum of large/medium/fine fields, shaped by a soft
   threshold `smoothstep(t0, t1, ·)`, modulated by a ridged filament layer and a
   low-frequency spatial mask, then a power remap. Negative space is preserved by
   subtracting an ambient floor before thresholding.
6. **Emission**: density → emission ramp with a core/ionization term; color from
   palette stops; emission multiplied by density² so only filaments glow.
7. **Composition**: additive emission over a dark blue-noise-dithered background,
   vignette, ACES-ish tonemap, dithering to fight banding.

## Mathematical model (3D / volume)

Camera ray → slab intersection with unit cube → fixed + adaptive steps →
front-to-back `T *= exp(-σ D Δs)`, `C += T (1 - exp(-σ D Δs)) C_em` →
emission colored by density; early termination at low transmittance or when the
slab is exited.

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

## Validation checklist

- [ ] Compiles with `tsc --noEmit`
- [ ] `npm run build` succeeds
- [ ] Renders at 720p / 1080p / 1440p without errors
- [ ] No console errors, no GL warnings
- [ ] Controls all affect output
- [ ] Import/export round-trips
- [ ] Context loss restores rendering
- [ ] Star field sparse and stable
- [ ] Volume mode has no obvious stepping/banding
