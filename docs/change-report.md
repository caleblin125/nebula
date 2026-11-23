# Change report — rendering engineering pass

This pass audited the renderer for correctness, redesigned the 2D density model
and the volumetric field, measured an optimization pass, and added automated
regression coverage. The renderer architecture is unchanged: WebGL2, TypeScript,
GLSL ES 3.00 and Vite, with no new runtime dependencies.

## What changed and why

### Correctness audit

| Issue | Effect | Fix |
|---|---|---|
| `smoothstep` called with `edge0 > edge1` in the volume envelope | Undefined in GLSL; envelope direction could invert by driver | Envelope written in ascending-edge form |
| Emission multiplied by the step weight after extinction already carried `Δs` | Total emission scaled with `Δs²`, so the image changed with the step count | Removed the second `Δs`; emission is step-invariant |
| Background composited after absorption | Dust lanes could not darken the sky or the envelope behind them | Background and envelope now pass through dust transmittance |
| `intersectCube` divided by raw `rd` components | A ray parallel to a slab produced `0 × ∞` = NaN | Epsilon-safe slab test with sign-preserving clamp |
| Approximate sRGB (`pow(x, 2.2)`-style) decode | Palette and output did not match the real transfer function | Exact piecewise sRGB on CPU and in `linearToSrgb` |
| Rotation and twinkle used raw time | Field drifted and stars shimmered while animation speed was zero | Every motion term scales with `uAnimationSpeed` |
| Volume rejection radius inside the envelope's support | Faint constant shell at the cutoff: a hard sphere edge | Rejection moved outside the support; closure checked by the suite |
| Haze not multiplied by the envelope | Unattenuated haze formed a second faint shell | Haze enveloped before the early-out too |
| `sample` used as an identifier | Shader failed to compile on this driver (reserved word in GLSL ES 3.00) | Renamed to `material` |
| `uDebugView` uploaded only in 2D | Volume debug views silently showed the normal render | Uniform uploaded in both modes |
| Capture/compare accepted any render | A failed volume shader fell back to 2D and was saved as a "volume" shot | Both assert the requested mode is active |
| Duplicate preset seed (ember-bloom = orion-deep) | Two presets could not produce distinct structures | ember-bloom reseeded to 8123 |

Aspect handling was also checked: 2D coordinates divide by height, and the
volume buffer preserves the display aspect through its scale, both asserted by
the suite.

### Three significant visual deficiencies

1. **One uniform marbled sheet.** Every region of the field had the same
   character, so the image read as a single texture rather than gas with quiet
   and active regions.
   *Fix:* the silhouette is built from the two largest scales only, and a
   low-frequency `activity`/`churn` term spatially gates turbulence and clumps,
   while erosion feathers edges. Detail now varies across the frame instead of
   being uniformly distributed.

2. **Broad, disconnected bright ridges.** Thresholding a ridged fBm produced
   blobs that did not connect into a network, and the brightest ribbons
   dominated the frame.
   *Fix:* emitting filaments are now the **zero-crossing iso-line** of two
   crossing gradient-noise fields. An iso-line is inherently thin and connected,
   and crossing two families creates junctions, so the web branches. Ridges are
   demoted to concentrated veins and dust.

3. **No density hierarchy, and dust deleted density.** Thin gas, cloud body,
   dense cores and dust all shared one additive field; dust was applied as a
   density subtraction, so lanes read as holes in the model rather than
   absorption in front of it.
   *Fix:* the field is explicitly layered (sheet → medium lobes → fine texture →
   cores → veils → envelope), and dust is returned as its own component and
   integrated as absorption. Foreground dust now darkens what is behind it while
   the gas structure survives.

### Volume

The volume was rebuilt on a shared `VolumeSample {density, dust, detail}`:

- the same hierarchical shape, threshold and detail terms as 2D, times a ×1.9
  normalization;
- the domain warp doubles as a spatial mask, so the mass is lobed rather than one
  round ball;
- `ridged3` veils supply internal filigree without aliasing into threads;
- two soft dust shells absorb internally;
- a mask-displaced spherical envelope ends the gas before the cube face;
- gas and dust extinguish separately (coefficients 1.15 and 2.6), and dust never
  emits.

Four debug views expose peak density, peak dust, first-hit depth and the analytic
`y = 0` field slice, so the model can be checked independently of the camera.

## Visual results

The 2D presets now separate into dark dust channels, a faint sheet, bright
connected filaments and small hot cores, with distinct temperature zones. The
volume reads as a lobed ionized mass with internal depth and dust lanes instead
of translucent smoke in a sphere.

Before/after frames are kept as `screenshots/baseline-*.jpg`; the current gallery
is `screenshots/gallery-*.jpg` (promoted to `screenshots/<preset>.jpg` for the
README). Fixed-seed references live in `screenshots/reference/*.png`.

## Computational results

Measured on Intel Graphics (0xA7AC), ANGLE D3D11, adaptive quality off, median of
24 synchronized frames:

| Workload | Before | After | Change |
|---|---:|---:|---:|
| 2D 1280×720 | 15.5 ms | 13.1 ms | −15% |
| 2D 1920×1080 | 31.7 ms | 26.6 ms | −16% |
| Volume 720p (48 steps) | 61.7 ms | 31.9 ms | −48% |
| Volume 1080p (48 steps) | 136.3 ms | 69.6 ms | −49% |

Volume 720p p95 tightened to 33.1 ms. Cost fits `4.3 ms + 0.59 ms × steps`; the
fixed term is the bloom/post chain. The gains come from exact work removal:

- an empty-space early-out returning after seven noise evaluations when the
  coarse fields cannot reach the threshold (about half the samples);
- 2.6× empty-space stepping below the thinnest resolved lobe;
- stopping at the intersected slab's exit;
- 0.012 transmittance termination;
- 48 steps instead of 56, verified visually equivalent.

The HUD noise estimate was corrected to include the fine and dust work and now
reports ≈346 evaluations/pixel at 48 steps (previously 308). It remains an
estimate; draw cost is the measured figure.

## Tests and references

`bench.html?test=suite` runs 53 dependency-free checks:

- parameter normalization, clamping and finiteness;
- JSON import/export round-trips for every field and palette;
- preset count, uniqueness, normalized values and distinct seeds;
- exact sRGB decode, encode inverse and palette luminance endpoints;
- shader compilation, program/uniform availability and initialization;
- 2D and volume reproducibility and seed response;
- volume density bounds, mass fraction, empty corners and envelope closure;
- forced context loss and restore.

`bench.html?test=compare` renders through the same `renderFrame` path as captures
and compares against `screenshots/reference/orion-deep-2d.png`,
`carina-core-2d.png` and `orion-deep-volume.png`. All three match exactly (mean
difference 0.00/255).

## Tradeoffs

- **Display-space bloom** stays 8-bit and cheap; the hue-preserving shoulder
  protects cores but this is not HDR-correct bloom.
- **48 steps** trades a small amount of volume smoothness for a large cost
  reduction; 56 remains available in the UI.
- **Lossless PNG references** (≈1 MB total) make comparisons exact but enlarge
  the repository slightly.
- **Volume cost** is still high on integrated GPUs; adaptive quality is the
  default mitigation.
- **2D is screen-space**, so rotation and warp have no parallax, and stars are a
  screen-space layer that does not rotate with the volume camera.
- **Temperature zones are artistic**, not a radiative-transfer solution.

## Unresolved

- The GPU timer extension is unavailable on the development driver, so "GPU
  time" here is synchronized draw cost rather than a hardware counter.
- 1440p was not remeasured after the optimization; only 720p and 1080p are
  reported.
- The volume still shows stable stochastic grain in extreme close-ups from the
  per-pixel ray offset.
- Cross-vendor floating-point differences are tolerated by the comparison
  thresholds rather than eliminated; references were generated on this driver.
- Emission, extinction and step counts remain artistic controls, not a
  physically calibrated model.
