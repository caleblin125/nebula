# How the image is made

The renderer keeps three concerns separate: **structure** (a scalar density
field), **light** (emission and absorption derived from that field) and
**presentation** (palette, tone mapping, bloom). Nothing in the density stage
knows about RGB, and the color stage never samples noise directly. That split is
what makes the look controllable: density changes shape, emission changes
brightness, palette changes color.

Two samplers share the same parameter model:

- `sampleDensity2D` — a screen-space field, used by `nebula.frag`;
- `sampleDensity3D` — a unit-cube field sampled by the raymarcher in
  `volume.frag`.

They return different structs but are conceptually the same gas: large sheets,
zero-crossing filaments, a density hierarchy and separate dust.

## Noise and fractals

All noise is analytic and hash-based. There is no RNG state and there are no
noise textures.

| Function | Description |
|---|---|
| `gnoise2` | Quintic-interpolated 2D gradient noise with a 16-entry unit-gradient table and an integer cell hash. |
| `gnoise3` | The same construction on a 3D lattice with the 12 cube-edge gradients. |
| `gnoise3v` | Three independent values from one 3D lattice pass; used by the volume warp. |
| `fbm2` / `fbm3` | Normalized octave sums with a rotation between octaves to break axis alignment. |
| `fbm3v` | Three interleaved 3D fBm fields from one lattice pass, for the vector warp. |
| `ridged2` / `ridged3` | `1 - abs(N)`, squared and weighted by the previous octave, producing creases instead of blobs. |

Because the hash is integer-based and the octave rotation is fixed, the field is
exactly reproducible for a given seed.

## 2D density

The field is built from three scales, each cheap to sample:

1. **Domain warp.** Two levels: `w = p + k·(A(p), B(p))`, the second at a higher
   frequency and smaller amplitude. Slow drift animates each level independently.
2. **Scale separation.** Large structure is sampled from the **unwarped**
   coordinate so cloud masses stay coherent; medium and fine detail live in the
   warped domain. The signed sheet is built from the two largest scales only:

   ```glsl
   shape = (0.70*nLarge + 0.28*nMedium + 0.02*nFine) * 1.9;
   ```

   Fine noise belongs in erosion and filaments, not in the silhouette; folding it
   into the sheet turned every iso-contour into a ribbon.

3. **Soft threshold.** Density moves a threshold rather than scaling the noise:

   ```glsl
   threshold = mix(0.32, -0.12, dn) + mask*0.16 - (nBack*0.5 + 0.5)*0.08;
   band      = mix(0.38, 0.52, dn);
   cloud     = smoothstep(threshold, threshold + band, shape);
   ```

   Raising density thickens existing clouds instead of filling negative space
   with noise. The broad envelope and the spatial mask lower the local threshold
   in places, connecting masses through a faint medium rather than leaving
   isolated islands.

4. **Modulation.** Spatially gated turbulence (`churn`) and clump masks multiply
   the cloud body, then a high-frequency erosion field feathers its edges. All
   three reuse fields already sampled; none adds a noise evaluation.

5. **Filaments as iso-lines.** The bright network is the **zero-crossing contour**
   of two crossing gradient-noise fields:

   ```glsl
   line = 1.0 - smoothstep(0.0, width, abs(gnoise2(w * freq + offset)));
   ```

   An iso-line is inherently thin and connected, whereas a thresholded ridged fBm
   gives broad, disconnected blobs. Crossing two families produces junctions, so
   the web branches. A second family doubles as fine **lace** at pixel scale.

6. **Dust is separate.** Foreground lanes come from a wider crease family and are
   returned as an absorption term. Dust never deletes density: it attenuates what
   is behind it, which is what makes it read as a dark channel through gas rather
   than a hole.

The final optical density is a weighted sum (`cloud`, `core`, `filament`, `lace`,
`veil`), independent of color.

## Emission and color in 2D

Density is never mapped directly to RGB as noise. The shader derives:

- `radiance = tint * (gas + coreGlow) * uEmission`, plus small highlight
  contributions from ridge crests, ionization rims (`fwidth` of the density, so
  resolution-independent) and lace;
- a low-frequency `zone` term that splits the scene into cold and hot gas, so the
  whole cloud does not drift toward one flat hue;
- `gasIndex` and `ionization` index the palette ramp, while a `grit` term from the
  fine field granulates emission without adding density;
- dust absorption applied to background, envelope, ambient and radiance, with a
  fraction of the front radiance surviving thin lanes;
- a dark background, sparse stars, vignette and ACES filmic tone mapping, then
  exact sRGB encoding and ordered dithering against banding.

Palettes are defined in sRGB and converted to linear on the CPU, so interpolation
happens in a physically sensible space.

### Highlight shoulder

A hue-preserving shoulder compresses only the top of the accumulated radiance,
scaling all channels together:

```glsl
vec3 compressHighlights(vec3 color, float knee, float range, float softness)
```

A dense core therefore keeps its color and internal structure instead of
clipping to a flat white plate before bloom. 2D uses `(0.78, 0.50, 0.6)`; the
volume uses `(0.70, 0.25, 0.9)`.

Bloom is a separate three-pass display-space effect: bright extract with a 4×
downsample, two separable 9-tap blurs at quarter resolution, then
`scene + bloom * strength`. Working in display space avoids an HDR intermediate
at the cost of slightly clipping very bright cores before they bloom.

| Mode | Threshold | Strength |
|---|---:|---:|
| 2D field | 0.36 | 0.72 |
| Volume | 0.52 | 0.42 |

The volume uses the gentler profile because front-to-back integration already
builds a broad bright core; the 2D profile flattened it to a white plate.

## Volume

The camera ray is intersected with the unit cube and marched front to back.
Each sample is an emitting **gas** term plus an absorbing **dust** term, returned
by `sampleDensity3D` as `VolumeSample {density, dust, detail}`:

```text
T = 1
for each sample:
    σg, σd = density, dust
    αg = 1 - exp(-1.15 σg Δs)
    αd = 1 - exp(-2.6  σd Δs)
    α  = αg + αd (1 - αg)
    C += T · αg · emission(σg)   // extinction already carries Δs
    T *= 1 - α
```

The extinction term already contains the segment length
(`1 - exp(-σ Δs) ≈ σ Δs`), so the source is **not** scaled by `Δs` as well.
Doing both made total emission proportional to `Δs²` and therefore dependent on
the step count. Gas and dust are integrated separately: dust attenuates what is
behind it but never emits, so it cannot brighten the sample it darkens. A dense
dust lane is far more opaque per unit density than the gas (coefficient 2.6 vs
1.15), which is what lets a thin lane read as dark.

### Field

`sampleDensity3D` mirrors the 2D model in three dimensions:

- one warp octave from `fbm3v`, whose displacement stays below one noise cell;
- the warp's `x` channel doubles as the spatial mask, so the mass is not one
  round blob;
- four base octaves carry the mass, two medium octaves form lobes, two fine
  octaves add internal texture, and `ridged3` creases supply thin veils;
- the same `cloud` / `core` / veil / haze hierarchy and the same density-driven
  threshold as 2D, times a ×1.9 normalization;
- two soft dust shells returned separately as `dust`.

The gas fades inside the cube boundary through a shell-shaped envelope whose
edge is displaced by the mask, so no hard cube face or perfect sphere is visible.
The rejection radius sits outside the envelope's support, so the field is exactly
zero where sampling stops: a cutoff inside the support would leave a faint
constant shell at that radius.

### Optimization

All of these are exact or visually verified, not approximations made by taste:

- **Empty-space early-out.** Normalized fBm stays in `[-1, 1]`, so if the two
  coarsest fields cannot reach the smoothstep's lower edge even with a maximal
  fine term, every cloud-gated component is exactly zero. The sample then costs
  seven noise evaluations instead of thirteen.
- **Empty-space stepping.** True zeros advance the ray `2.6×` a step. The skip is
  smaller than the thinnest resolved lobe, so it cannot tunnel through a wisp.
- **Slab exit.** The loop stops when the ray leaves the intersected slab, not
  only when opacity is spent, so remaining iterations are not run through void.
- **Opacity budget.** The loop stops when transmittance falls below `0.012`.
- **Per-pixel jitter.** A fixed hash offset breaks banding without per-frame
  shimmer, and the volume's offset depends only on pixel and seed, so it is
  stable when frozen. Interleaved gradient noise was rejected: its regular 4×4
  weave showed as a cross-hatch across smooth gradients.

The default is 48 steps. Measured draw cost was within run-to-run noise of 56
steps while looking the same, so 48 became the default.

### Debug views

The volume shader exposes field-inspection views that do not depend on the
camera: 1 peak density, 2 peak dust, 3 first-hit depth, and 4 the analytic field
on the `y = 0` slice. View 4 is what the test suite uses to check bounds, mass
fraction and the envelope, because it shows the model itself rather than one
viewpoint.

## Reproducibility

A seed plus a parameter set determines the still image. Animation is a pure
function of elapsed time (`uTime`) and the animation speed; pausing stops time.
Rotation and twinkle are scaled by the animation speed, so they cannot drift while
animation is paused. There is no per-frame randomness in density or color.

Floating-point results can differ in the last bits across GPU vendors, but the
structure is defined entirely by the seed and parameters.

## Tests

`npm run dev`, then open `/bench.html?test=suite`. The suite checks
normalization, import/export, presets, exact sRGB conversion, shader compilation
and initialization, reproducibility, density bounds and envelope, and context
loss/restore — 53 checks, no external dependencies.

`/bench.html?test=compare&ref=orion-deep-2d.png&preset=orion-deep&w=640&h=400`
renders a fixed-seed frame and compares it against the lossless PNG reference in
`screenshots/reference/`. References exist for two 2D presets and the volume, and
the comparison is tolerant enough to catch a changed look, not a rounding path.
