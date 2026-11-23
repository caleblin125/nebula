# Performance

These are integrated-graphics numbers. A discrete GPU has far more headroom.
The 2D field is the default and the mode tuned for interactive use on laptops;
the volume is intentionally the expensive mode.

## Method

Measured with the bundled harness on:

- **GPU:** Intel Graphics (0xA7AC), ANGLE Direct3D11
- **Browser:** Chromium-based, Windows
- **Method:** `bench.html` forces the WebGL buffer to an exact pixel size,
  draws frames synchronously with `renderer.renderOnce()`, and synchronizes each
  sample with `gl.finish()` plus a 1-pixel `readPixels`. This measures draw cost
  independently of the display refresh rate.

Adaptive quality is **off** for these tables, so they are full-resolution worst
cases.

## 2D field (full resolution)

| Buffer | Draw cost (median) | p95 | Draw ceiling |
|---|---:|---:|---:|
| 1280×720 | 15.1 ms | 18.9 ms | ~66 fps |
| 1920×1080 | 33.1 ms | 38.1 ms | ~30 fps |
| 2560×1440 | 55.7 ms | 60.5 ms | ~18 fps |

Estimated noise cost: **50 gradient-noise evaluations/pixel** at the default six
octaves. The HUD reports this live, including the warp and all detail fields.

## Volume (0.72 internal scale)

| Requested | Internal buffer | Draw cost (median) | Draw ceiling |
|---|---:|---:|---:|
| 1280×720 | 922×518 | 60.4 ms | ~17 fps |
| 1920×1080 | 1382×778 | 133.1 ms | ~8 fps |
| 2560×1440 | 1843×1037 | 237.6 ms | ~4 fps |

Estimated cost: **~308 noise evaluations/pixel** at 56 steps, after empty-space
skipping and early termination.

Shader compilation is 15–65 ms for the whole program set on a warm driver
cache; a cold cache can take over a second.

## Adaptive quality

`adaptiveQuality` (on by default) targets ~21 ms of GPU cost, or ~22 ms of
frame time when the GPU timer is unavailable. It scales the render buffer
between 1.0 and 0.55, solving for the scale that reaches the target rather than
stepping blindly. When a real GPU timer is present it can also recover
resolution; with only vsync-capped frame time it scales down and waits for a
mode or parameter change, which avoids oscillation.

On the iGPU above, 1080p 2D settles around 0.6–0.7 scale and the volume around
0.55 (≈25 fps).

The telemetry HUD shows FPS, frame time, GPU time when the timer extension
reports one, buffer resolution, noise evaluations per pixel and the active mode.

## Benchmark and capture

```text
/bench.html?w=1920&h=1080&preset=orion-deep          # draw-cost benchmark
/bench.html?mode=volume&w=1280&h=720                # volume benchmark
/bench.html?test=io                                 # JSON round-trip + clamping
/bench.html?test=contextloss                        # forced loss/restore
/bench.html?test=shot&w=2160&h=1350&preset=carina-core&name=shot.jpg
```

The shot mode posts the encoded frame to a development-only Vite endpoint and
writes it into `screenshots/`, which is how the images in the README were
produced. The endpoint exists only while `vite dev` runs and is not part of a
production build.
