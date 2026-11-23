#version 300 es
precision highp float;
precision highp int;

uniform vec2 uResolution;
uniform float uVignette;
uniform float uStarDensity;
uniform int uStepCount;

#include "noise.glsl"
#include "density.glsl"
#include "color.glsl"
#include "stars.glsl"

out vec4 fragColor;

/** Slab intersection of a ray with the [-extent, extent] cube. */
vec2 intersectCube(vec3 ro, vec3 rd, float extent) {
  vec3 inv = 1.0 / rd;
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
  vec2 sky = (frag - 0.5 * uResolution) / uResolution.y;
  float t = uTime * uAnimationSpeed;

  // Camera: slow orbit whose rate is nudged by the rotation parameter. The
  // framing is chosen so the gas sphere fills most of the frame at any aspect.
  float yaw = 1.15 + t * (0.012 + uRotation * 0.09);
  vec3 ro = vec3(cos(yaw) * 1.56, 0.2 + 0.12 * sin(t * 0.021), sin(yaw) * 1.56);
  vec3 forward = normalize(-ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
  vec3 up = cross(forward, right);

  const float FOV = 0.72;
  vec3 rd = normalize(forward + (sky.x * 2.0) * FOV * right + (sky.y * 2.0) * FOV * up);

  vec2 hit = intersectCube(ro, rd, 0.98);
  vec3 accum = vec3(0.0);
  float transmittance = 1.0;

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

    // Emission is an integral over the segment, so it must scale with the step
    // length. Without this the same gas gets brighter as the step count rises.
    // The constant restores the calibration of the original 56-step default.
    float stepWeight = stepSize * 30.0;

    for (int i = 0; i < 128; i++) {
      if (i >= steps || transmittance < 0.012) break;

      vec3 pos = ro + rd * travel;
      float density = sampleDensity3D(pos, t);

      if (density > 0.004) {
        float extinction = 1.0 - exp(-1.15 * density * stepSize);
        // Ionization is reserved for the densest peaks. A low threshold turns
        // every moderately dense region into the pale core stop, which reads as
        // a broad white plate instead of a small bright nucleus.
        float hot = smoothstep(1.0, 1.45, density);
        vec3 source = emissionColor(clamp(density * 0.85, 0.0, 1.0), hot)
                    * (uEmission * 1.25 * density * stepWeight);
        accum += transmittance * extinction * source;
        transmittance *= 1.0 - extinction;
        travel += stepSize;
      } else {
        // Empty space contributes nothing; advance faster through it. 2.2 is a
        // compromise between skipping thin wisps and wasting samples on voids.
        travel += stepSize * 2.2;
      }
    }
  }

  // Front-to-back integration through a dense core can produce radiance far
  // above what the display can show; ACES then flattens the whole core to a
  // featureless white plate. Compress only the top end, scaling all channels
  // together so the core keeps its hue and the faint gas is untouched.
  float peak = max(accum.r, max(accum.g, accum.b));
  if (peak > 0.7) {
    float shoulder = 0.7 + 0.25 * (1.0 - exp(-(peak - 0.7) / 0.9));
    accum *= shoulder / peak;
  }

  // Background stars sit behind the volume and are absorbed by it.
  vec3 stars = starfield(sky * 2.0, uStarDensity, uSeed, transmittance, uTime)
             * 0.55;
  vec3 color = uBackground + accum + stars;

  float vignette = 1.0 - uVignette * smoothstep(0.38, 1.28, length(sky * 2.0));
  color *= vignette;

  vec3 srgb = presentColor(color, uExposure);
  float dither = (ign(frag + 17.0) - 0.5) * (1.0 / 255.0);
  fragColor = vec4(srgb + dither, 1.0);
}
