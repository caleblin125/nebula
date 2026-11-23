# How the image is made

The renderer keeps three concerns separate: **structure** (a scalar density
field), **light** (emission derived from that field) and **presentation**
(palette, tone mapping, bloom). Nothing in the density stage knows about RGB,
and the color stage never samples noise directly. That split is what makes the
look controllable: density changes shape, emission changes brightness, palette
changes color.

## Noise and fractals

All noise is analytic and hash-based. There is no RNG state and there are no
noise textures.

| Function | Description |
|---|---|
| `gnoise2` | Quintic-interpolated 2D gradient noise with a 16-entry unit-gradient table and an integer cell hash. |
| `gnoise3` | The same construction on a 3D lattice with the 12 cube-edge gradients. |
| `gnoise3v` | Three independent values from one 3D lattice pass; used by the volume warp. |
| `fbm2` / `fbm3` | Normalized octave sums with a rotation between octaves to break axis alignment. |
| `ridged2` / `ridged3` | `1 - abs(N)`, squared and weighted by the previous octave, producing creases instead of blobs. |

Because the hash is integer-based and the octave rotation is fixed, the field is
exactly reproducible for a given seed.

## 2D density

For screen coordinate `p`:

1. **Domain warp.** Two levels: `w = p + k·(A(p), B(p))`, the second at a higher
   frequency and smaller amplitude. Slow time drift animates each level
   independently.
2. **Scale separation.** Large structure is sampled from the **unwarped**
   coordinate so cloud masses stay coherent; medium and fine detail live in the
   warped domain.
3. **Soft threshold.** A signed `shape` combines large, medium, fine and micro
   fields. Density moves a threshold rather than scaling the noise:

   ```glsl
   cloud = smoothstep(t0, t0 + band, shape);
   ```

   Raising density therefore thickens existing clouds instead of filling
   negative space.
4. **Modulation.** Turbulence and clump masks multiply the cloud body; a
   high-frequency erosion field feathers its edges.
5. **Filaments.** Two crossing ridged fields carve dust lanes and produce the
   bright filament layer; a third, stretched ridge field supplies pixel-scale
   lace.
6. **Envelope.** A low-frequency envelope keeps faint gas around the resolved
   structure. A spherical mask (volume) or vignette (2D) removes hard
   boundaries.

## Emission and color

Density is never mapped directly to RGB as noise. The shader derives:

- `emission = f(cloud, filament, lace, density²)`, so only structured gas glows;
- a `hot` ionization term that shifts dense cores toward the bright palette
  stop;
- a five-stop sRGB palette converted to linear on the CPU, so interpolation
  happens in a physically sensible space;
- a dark, noise-dithered background, sparse stars, vignette and ACES filmic
  tone mapping, then sRGB encoding and ordered dithering against banding.

Bloom is a separate three-pass display-space effect: bright extract with a
4× downsample, two separable 9-tap blurs at quarter resolution, then
`scene + bloom * strength`. Working in display space avoids an HDR intermediate
at the cost of slightly clipping very bright cores before they bloom.

| Mode | Threshold | Strength |
|---|---:|---:|
| 2D field | 0.32 | 0.90 |
| Volume | 0.52 | 0.42 |

The volume uses the gentler profile because front-to-back integration already
builds a broad bright core; the 2D profile flattened it to a white plate.

## Volume

The camera ray is intersected with a cube and marched front to back:

```text
T = 1
for each sample:
    σ = density(p)
    α = 1 - exp(-k σ Δs)
    C += T α emission(σ) Δs
    T *= 1 - α
```

Emission is scaled by the step length, so the image does not brighten when the
step count rises. A constant folded into the source preserves the calibration
of the original 56-step default. Empty samples advance 2.2× faster, samples
outside the gas sphere return immediately, the ridge field is skipped when the
base shape cannot support a filament, and the loop exits when transmittance
drops below 0.012.

A hue-preserving shoulder compresses only the top of the accumulated radiance
(`peak > 0.7`), scaling all channels together. A dense core therefore keeps its
color and internal structure instead of clipping to flat white before bloom.

The ray offset is a per-pixel hash rather than interleaved gradient noise, whose
regular 4×4 weave was visible across smooth gradients. The volume uses one warp
octave, up to five base octaves and three medium octaves; those limits came from
measurements, not guesses.

## Reproducibility

A seed plus a parameter set determines the still image. Animation is a pure
function of elapsed time (`uTime`) and the animation speed; pausing stops time.
There is no per-frame randomness in density or color, and the volume's per-pixel
sample offset depends only on the pixel and the seed, so it is stable when
frozen.

Floating-point results can differ in the last bits across GPU vendors, but the
structure is defined entirely by the seed and parameters.
