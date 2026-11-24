# Performance

These are integrated-graphics numbers. A discrete GPU has far more headroom.
The 2D field is the default and the mode tuned for interactive use on laptops;
the volume is intentionally the expensive mode.

## Method

Measured with the bundled harness on:

- **GPU:** Intel Graphics (0xA7AC), ANGLE Direct3D11
- **Browser:** Chromium-based, Windows
- **Resolution:** reported as the requested CSS size and the real WebGL buffer
  (volume mode renders below display resolution)
- **Mode / quality:** the mode and effective scale shown in each table; adaptive
  quality **off**, so these are full-resolution worst cases

`bench.html` forces the WebGL buffer to an exact pixel size, draws frames
synchronously with `renderer.renderOnce()`, and synchronizes each sample with
`gl.finish()` plus a 1-pixel `readPixels`. That measures draw cost independently
of the display refresh rate. Each figure is the **median of 24 synced frames**;
p95 is reported where it matters, because a loose tail is what a viewer notices
as a stutter.

Only one benchmark tab may be open at a time. A second tab re-runs on hot reload
and halves measured throughput, which produced a spurious 39 → 66 ms reading
during this pass.

The GPU timer extension is unavailable on this driver, so "GPU time" is the
synchronized draw cost above rather than a hardware counter. Presentation FPS is
not reported: background tabs throttle `requestAnimationFrame` to zero, so draw
cost is the meaningful, reproducible number.

## 2D field (full resolution)

| Buffer | Draw cost (median) | p95 | Draw ceiling |
|---|---:|---:|---:|
| 1280×720 | 13.1 ms | 22.3 ms | ~76 fps |
| 1920×1080 | 26.6 ms | 35.2 ms | ~38 fps |

Estimated noise cost: **50 gradient-noise evaluations/pixel** at the default six
octaves. The HUD reports this live, including the warp and all detail fields.

Before this pass the same measurements were 15.5 ms and 31.7 ms, so the 2D path
is about **15% faster** at both sizes. The gain comes from dropping wasted work,
not from lowering quality: the sheet is built from the two largest scales, the
clump, erosion and turbulence terms reuse fields already sampled, and the
highlight shoulder keeps cores from triggering the brightest bloom path.

## Volume (0.72 internal scale)

| Requested | Internal buffer | Steps | Draw cost (median) | p95 | Draw ceiling |
|---|---|---:|---:|---:|---:|
| 1280×720 | 922×518 | 48 | 31.9 ms | 33.1 ms | ~31 fps |
| 1920×1080 | 1382×778 | 48 | 69.6 ms | 81.6 ms | ~14 fps |

Before this pass the same sizes took 61.7 ms and 136.3 ms at 56 steps, so the
volume is about **48% faster**, with a much tighter tail at 720p (p95 33.1 ms).

Cost model, fitted to measurements at 24, 40 and 48 steps:

```text
draw cost ≈ 4.3 ms (fixed: bloom and post) + 0.59 ms × steps
```

The fixed term explains why 24 steps is not half of 48: the post chain does not
scale with the raymarch. The optimizations behind the reduction are exact rather
than cosmetic:

- an early-out that returns after seven noise evaluations when the coarse fields
  cannot reach the density threshold (about half of all samples);
- empty-space stepping at `2.6×`;
- stopping when the ray leaves the intersected slab;
- stopping at 0.012 transmittance;
- 48 steps instead of 56, verified visually equivalent.

The HUD's noise estimate now models the real sampler: one warp, up to four base
octaves, two medium, two fine and two dust shells, mixed with the seven-evaluation
empty branch and multiplied by the 0.70 average number of steps per march. At the
default 48 steps that reports **≈346 evaluations/pixel**, up from the older 308,
because the previous figure ignored the fine and dust work.

Shader compilation is 44–55 ms for the whole program set on a warm driver cache;
a cold cache can take over two seconds. Compile time is measured separately by
the harness and is not part of draw cost.

## Adaptive quality

`adaptiveQuality` (on by default) targets ~21 ms of GPU cost, or ~22 ms of frame
time when the GPU timer is unavailable. It scales the render buffer between 1.0
and 0.55, solving for the scale that reaches the target rather than stepping
blindly. When a real GPU timer is present it can also recover resolution; with
only vsync-capped frame time it scales down and waits for a mode or parameter
change, which avoids oscillation.

On the iGPU above, 1080p 2D settles around 0.6–0.7 scale and the volume around
0.55.

The telemetry HUD shows FPS, frame time, GPU time when the timer extension
reports one, buffer resolution, noise evaluations per pixel and the active mode.

## Benchmark, tests and capture

```text
/bench.html?w=1920&h=1080&preset=orion-deep          # draw-cost benchmark
/bench.html?mode=volume&w=1280&h=720                # volume benchmark
/bench.html?test=suite                              # 96 self-checks
/bench.html?test=compare&ref=orion-deep-2d.png&preset=orion-deep&w=640&h=400
/bench.html?test=compare&ref=orion-deep-volume.png&mode=volume&steps=32&preset=orion-deep&w=640&h=400
/bench.html?test=io                                 # JSON round-trip + clamping
/bench.html?test=contextloss                        # forced loss/restore
/bench.html?test=shot&w=1600&h=1000&preset=carina-core&name=shot.jpg
/bench.html?test=gallery&w=1600&h=1000&prefix=final
```

`test=suite` and `test=compare` are dependency-free: they run in the same page as
the renderer and need no browser automation. `test=compare` fetches the reference
from `screenshots/reference/` through the dev server, so it only runs under
`vite dev`.

Shot, gallery and compare all go through one `renderFrame` helper that reads the
real buffer back, so the test path and the screenshot path cannot drift apart.
Shot mode posts the encoded frame to a development-only Vite endpoint and writes
it into `screenshots/`, which is how the images in the README were produced. The
endpoint exists only while `vite dev` runs and is not part of a production build.
