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

  // Camera: slow orbit whose rate is nudged by the rotation parameter.
  float yaw = 0.4 + t * (0.012 + uRotation * 0.09);
  vec3 ro = vec3(cos(yaw) * 2.8, 0.28 + 0.16 * sin(t * 0.021), sin(yaw) * 2.8);
  vec3 forward = normalize(-ro);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
  vec3 up = cross(forward, right);

  const float FOV = 1.15;
  vec3 rd = normalize(forward + (sky.x * 2.0) * FOV * right + (sky.y * 2.0) * FOV * up);

  vec2 hit = intersectCube(ro, rd, 0.98);
  vec3 accum = vec3(0.0);
  float transmittance = 1.0;

  if (hit.y > hit.x) {
    int steps = clamp(uStepCount, 16, 128);
    float span = hit.y - hit.x;
    float stepSize = span / float(steps);

    // Fixed per-pixel offset avoids structured wood-grain banding without the
    // shimmering that a per-frame random offset would introduce.
    float jitter = ign(frag);
    float travel = hit.x + stepSize * jitter;

    for (int i = 0; i < 128; i++) {
      if (i >= steps || transmittance < 0.012) break;

      vec3 pos = ro + rd * travel;
      float density = sampleDensity3D(pos, t);

      if (density > 0.004) {
        float extinction = 1.0 - exp(-3.1 * density * stepSize);
        float hot = smoothstep(0.55, 1.25, density);
        vec3 source = emissionColor(clamp(density * 1.1, 0.0, 1.0), hot)
                    * (uEmission * 2.1 * density);
        accum += transmittance * extinction * source;
        transmittance *= 1.0 - extinction;
        travel += stepSize;
      } else {
        // Empty space contributes nothing; advance faster through it.
        travel += stepSize * 1.9;
      }
    }
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
