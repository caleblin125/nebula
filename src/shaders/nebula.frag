#version 300 es
precision highp float;
precision highp int;

uniform vec2 uResolution;
uniform float uVignette;
uniform float uStarDensity;

#include "noise.glsl"
#include "density.glsl"
#include "color.glsl"
#include "stars.glsl"

out vec4 fragColor;

void main() {
  vec2 frag = gl_FragCoord.xy;
  float t = uTime * uAnimationSpeed;

  vec2 p = nebulaCoordinates(frag, uResolution);
  DensityField field = sampleDensity2D(p, t);

  vec2 sky = (frag - 0.5 * uResolution) / uResolution.y * 2.0;

  float density = field.density;
  float cloud = field.cloud;
  float filament = field.filament;

  // Localized ionization: dense cloud body plus the crease of a filament.
  float core = smoothstep(0.42, 0.95, cloud) * (0.5 + 0.6 * filament);
  float densityForColor = clamp(density * 0.92 + 0.08 * core, 0.0, 1.0);
  vec3 radiance = emissionColor(densityForColor, core);
  radiance *= pow(clamp(density, 0.0, 1.35), 1.7) * uEmission;

  // Cold outer gas: enough light to reveal volume without flattening contrast.
  vec3 body = paletteRamp(0.1 + 0.32 * density) * density * 0.1;

  // Very faint haze in the negative space, modulated by the low-frequency mask.
  float haze = smoothstep(-0.12, 0.58, field.shape + field.mask * 0.28);
  vec3 ambient = paletteRamp(0.2) * haze * 0.028;

  // Background tint shifts slowly with the spatial mask.
  vec3 background = uBackground * (0.6 + 0.5 * smoothstep(-0.2, 0.6, field.mask));
  background += paletteRamp(0.05) * 0.006;

  float absorption = exp(-max(density, 0.0) * 3.4);
  vec3 stars = starfield(sky, uStarDensity, uSeed, absorption, uTime);

  vec3 color = background + ambient + body + radiance + stars;

  float vignette = 1.0 - uVignette * smoothstep(0.38, 1.28, length(sky));
  color *= vignette;

  vec3 srgb = presentColor(color, uExposure);

  // Dither before 8-bit quantization to prevent banding in the dark gradients.
  float dither = (ign(frag) - 0.5) * (1.0 / 255.0);
  fragColor = vec4(srgb + dither, 1.0);
}
