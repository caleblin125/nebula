#version 300 es
precision highp float;
precision highp int;

uniform vec2 uResolution;
uniform float uVignette;
uniform float uStarDensity;
uniform int uStepCount;
uniform int uDebugView;

#include "noise.glsl"
#include "density.glsl"
#include "color.glsl"
#include "stars.glsl"

out vec4 fragColor;

/** Slab intersection of a ray with the [-extent, extent] cube. */
vec2 intersectCube(vec3 ro, vec3 rd, float extent) {
  // A raw 1.0 / rd makes zero components infinite, and 0 * inf is NaN. Clamp
  // each component away from zero and keep its sign: a ray exactly parallel to
  // a slab then produces a huge but finite interval, which the min/max reduce
  // to the unconstrained axis. This is the standard epsilon-safe slab test.
  vec3 safeRd = max(abs(rd), vec3(1e-6)) * sign(rd + vec3(1e-12));
  vec3 inv = 1.0 / safeRd;
  vec3 t0 = (-extent - ro) * inv;
  vec3 t1 = (extent - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float near = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float far = min(min(tmax.x, tmax.y), tmax.z);
  return vec2(near, far);
}

void main() {
  vec2 frag = gl_FragCoord.xy;

  // Field inspection view, independent of the camera: a slice through the
  // volume on the y = 0 plane, mapped so the cube's [-1, 1] extent fills the
  // frame. It exposes the analytic field itself (bounds, empty corners, ragged
  // envelope) rather than what one viewpoint happens to see.
  if (uDebugView == 4) {
    vec2 uv = frag / uResolution * 2.0 - 1.0;
    float fieldDensity = sampleDensity3D(vec3(uv.x, 0.0, uv.y), uTime * uAnimationSpeed).density;
    fragColor = vec4(vec3(clamp(fieldDensity / 1.5, 0.0, 1.0)), 1.0);
    return;
  }

  vec2 sky = (frag - 0.5 * uResolution) / uResolution.y;
  float t = uTime * uAnimationSpeed;

  // Camera: slow orbit whose rate is nudged by the rotation parameter. The
  // framing is chosen so the gas sphere fills most of the frame at any aspect
  // while leaving a margin of sky around it: a sphere that touches the frame
  // edge reads as a cut-out ball rather than gas in space.
  float yaw = 2.3 + t * (0.012 + uRotation * 0.09);
  vec3 ro = vec3(cos(yaw) * 1.88, 0.18 + 0.1 * sin(t * 0.021), sin(yaw) * 1.88);
  vec3 forward = normalize(-ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
  vec3 up = cross(forward, right);

  const float FOV = 0.66;
  vec3 rd = normalize(forward + (sky.x * 2.0) * FOV * right + (sky.y * 2.0) * FOV * up);

  vec2 hit = intersectCube(ro, rd, 0.98);
  vec3 accum = vec3(0.0);
  float transmittance = 1.0;
  // Debug channels: 1 peak density, 2 peak dust, 3 first-hit depth.
  float peakDensity = 0.0;
  float peakDust = 0.0;
  float firstHit = 0.0;

  if (hit.y > hit.x) {
    int steps = clamp(uStepCount, 16, 128);
    float span = hit.y - hit.x;
    float stepSize = span / float(steps);

    // Fixed per-pixel offset avoids structured wood-grain banding without the
    // shimmering that a per-frame random offset would introduce. A hash is used
    // rather than interleaved gradient noise: IGN's regular 4×4 weave shows up
    // as a cross-hatch across smooth volume gradients.
    float jitter = hash01(uint(frag.x) * 1973u ^ uint(frag.y) * 9277u ^ uSeed);
    float travel = hit.x + stepSize * jitter;

    // Emission–absorption integration: the extinction term already carries the
    // segment length (1 - exp(-σ Δs) ≈ σ Δs), so the source must not be scaled
    // by Δs as well. Doing that made total emission proportional to Δs² and
    // therefore dependent on the step count. Gas and dust are integrated
    // separately: dust attenuates what is behind it but never emits, so it must
    // not be allowed to brighten the sample it darkens.
    for (int i = 0; i < 128; i++) {
      // Stop when the ray has left the slab, when the opacity budget is spent,
      // or when the step budget is spent. Leaving the slab matters: without it
      // every ray ran its remaining iterations through empty space.
      if (i >= steps || transmittance < 0.012 || travel > hit.y) break;

      vec3 pos = ro + rd * travel;
      VolumeSample material = sampleDensity3D(pos, t);
      float density = material.density;

      peakDensity = max(peakDensity, density);
      peakDust = max(peakDust, material.dust);
      if (firstHit == 0.0 && density > 0.05) {
        firstHit = (travel - hit.x) / max(hit.y - hit.x, 1e-4);
      }

      if (density > 0.004) {
        float gasExtinction = 1.0 - exp(-1.15 * density * stepSize);
        // Dust is far more opaque per unit density than the gas: a lane only a
        // few tenths of a unit thick has to remove a visible fraction of the
        // light behind it, which is what makes it read as a dark lane.
        float dustExtinction = 1.0 - exp(-2.6 * material.dust * stepSize);
        float extinction = gasExtinction + dustExtinction * (1.0 - gasExtinction);

        // Ionization is reserved for the densest peaks. A low threshold turns
        // every moderately dense region into the pale core stop, which reads as
        // a broad white plate instead of a small bright nucleus.
        float hot = smoothstep(0.92, 1.10, density);
        // The fine field granulates the emission the same way the 2D shader's
        // grit term does, so a smooth optical-density gradient still reads as
        // gas rather than as a painted volume.
        float grit = 0.72 + 0.50 * smoothstep(-0.5, 0.5, material.detail * 2.0);
        // Emissivity rises faster than linearly with density: tenuous gas stays
        // faint while knots accumulate a bright, coloured core. A linear map
        // made the whole cloud uniformly pale because most samples are thin.
        vec3 source = emissionColor(density, hot)
                    * (uEmission * (0.08 + 1.30 * density * pow(density, 0.3)) * grit);
        accum += transmittance * gasExtinction * source;
        transmittance *= 1.0 - extinction;
        travel += stepSize;
      } else {
        // Empty space contributes nothing; advance faster through it. The
        // distance is deliberately below the scale of the thinnest resolved gas
        // (the medium field's lobes), so a skip cannot tunnel through a wisp;
        // it only stops the marcher from paying a full sample in the void for
        // every step of the way.
        travel += stepSize * 2.6;
      }
    }
  }

  // Front-to-back integration through a dense core can produce radiance far
  // above what the display can show; ACES then flattens the whole core to a
  // featureless white plate. Compress only the top end, scaling all channels
  // together so the core keeps its hue and the faint gas is untouched.
  accum = compressHighlights(accum, 0.7, 0.25, 0.9);

  if (uDebugView == 1) {
    fragColor = vec4(vec3(clamp(peakDensity, 0.0, 1.0)), 1.0);
    return;
  }
  if (uDebugView == 2) {
    fragColor = vec4(vec3(clamp(peakDust, 0.0, 1.0)), 1.0);
    return;
  }
  if (uDebugView == 3) {
    fragColor = vec4(vec3(fract(firstHit * 4.0)), 1.0);
    return;
  }

  // Background stars sit behind the volume and are absorbed by it, as is the
  // background tint itself: light emitted behind the gas must be attenuated by
  // the accumulated optical depth, not added unconditionally.
  vec3 stars = starfield(sky * 2.0, uStarDensity, uSeed, transmittance, t) * 0.55;
  vec3 color = uBackground * transmittance + accum + stars;

  float vignette = 1.0 - uVignette * smoothstep(0.38, 1.28, length(sky * 2.0));
  color *= vignette;

  vec3 srgb = presentColor(color, uExposure);
  float dither = (ign(frag + 17.0) - 0.5) * (1.0 / 255.0);
  fragColor = vec4(srgb + dither, 1.0);
}
