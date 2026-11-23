#version 300 es
precision highp float;
precision highp int;

uniform vec2 uResolution;
uniform float uVignette;
uniform float uStarDensity;
uniform int uDebugView;

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

  if (uDebugView == 1) {
    fragColor = vec4(vec3(clamp(density, 0.0, 1.0)), 1.0);
    return;
  }
  if (uDebugView == 2) {
    fragColor = vec4(vec3(cloud), 1.0);
    return;
  }
  if (uDebugView == 3) {
    fragColor = vec4(vec3(clamp(filament, 0.0, 1.0)), 1.0);
    return;
  }
  if (uDebugView == 4) {
    fragColor = vec4(vec3(clamp(field.shape * 0.5 + 0.5, 0.0, 1.0)), 1.0);
    return;
  }
  if (uDebugView == 5) {
    fragColor = vec4(vec3(clamp(field.mask * 0.5 + 0.5, 0.0, 1.0)), 1.0);
    return;
  }

  // Localized ionization: dense cloud body plus the crease of a filament.
  float core = pow(clamp(cloud, 0.0, 1.0), 5.0) * (0.35 + 0.9 * filament);
  float ionization = smoothstep(0.25, 0.9, 0.4 + field.mask * 0.5 + cloud * 0.4);

  // Temperature zones: the low-frequency mask splits the scene into cold
  // blue/cyan outer gas and hot violet/magenta inner gas. Without this the
  // whole cloud drifts toward one flat hue.
  float zone = smoothstep(-0.55, 0.55, field.mask);

  float gasIndex = clamp(0.02 + density * 0.5 + (zone - 0.5) * 0.26, 0.0, 1.0);
  vec3 gasColor = paletteRamp(gasIndex);
  vec3 coreColor = paletteRamp(0.58 + 0.3 * ionization);
  vec3 tint = mix(gasColor, coreColor, smoothstep(0.3, 0.95, cloud) * 0.7);

  // High-frequency modulation: the fine field is an emission texture, not extra
  // density. It breaks flat patches of color into granular gas.
  float micro = smoothstep(-0.6, 0.6, field.fine * 3.0);
  float grit = 0.42 + 0.9 * micro;
  float gas = pow(clamp(density, 0.0, 1.3), 0.95) * 0.55 * grit;
  float coreGlow = core * 0.6;

  // Concentrated luminous veins: only the sharpest ridge crests, only inside
  // dense gas, warmed toward white at the hottest points.
  float vein = pow(smoothstep(0.5, 0.95, field.ridge), 1.1)
             * smoothstep(0.15, 0.6, cloud);
  vec3 hotTint = mix(paletteRamp(0.86 + 0.12 * ionization), vec3(1.0, 0.93, 0.88), 0.35);

  // Ionization rims: the density gradient lights up at cloud edges, where gas
  // meets the radiation field. fwidth keeps the effect resolution-independent.
  float rim = clamp(fwidth(density) * 5.5, 0.0, 1.0) * smoothstep(0.02, 0.35, cloud);
  vec3 rimTint = paletteRamp(0.5 + 0.25 * ionization);

  vec3 radiance = tint * (gas + coreGlow) * uEmission;
  radiance += hotTint * vein * 1.15 * uEmission;
  radiance += rimTint * rim * 0.5 * uEmission;

  // Fine lace filaments: emission only, so they read as glowing threads rather
  // than thickening the density model. Tinted by the cloud, never pure white.
  radiance += mix(tint, hotTint, 0.45) * field.lace * 0.45 * uEmission;

  // Slope shading derived from the density gradient adds a sense of relief
  // without another noise field. Kept low so gas never reads as a glossy sheet.
  vec2 densitySlope = vec2(dFdx(cloud), dFdy(cloud));
  float slope = clamp(dot(densitySlope, vec2(-0.6, 0.8)) * 13.0, -0.25, 0.25);
  radiance *= 1.0 + slope * smoothstep(0.05, 0.5, cloud);

  // Broad envelope behind the resolved cloud: dim, diffuse, slightly cooler.
  vec3 backGlow = paletteRamp(0.1 + 0.22 * field.back) * field.back * field.back * 0.2;

  // Cold outer gas: enough light to reveal volume without flattening contrast.
  vec3 body = paletteRamp(0.06 + 0.3 * density) * density * 0.2;

  // Soft halo from the pre-threshold field: gas just outside the resolved cloud
  // still scatters light, so masses fade into the dark instead of being cut out.
  float glow = smoothstep(-0.3, 0.55, field.shape + field.mask * 0.2);
  vec3 ambient = paletteRamp(0.22) * glow * 0.075;
  ambient += paletteRamp(0.3 + 0.2 * zone) * glow * glow * 0.05;

  // Wide atmospheric veil: a very dim, cool wash that keeps the negative space
  // from being pure black and gives the frame a sense of depth.
  float veil = smoothstep(-0.4, 0.65, field.mask + field.back * 0.45);
  ambient += paletteRamp(0.13 + 0.1 * zone) * veil * 0.05;

  // Background tint shifts slowly with the spatial mask.
  vec3 background = uBackground * (0.55 + 0.55 * smoothstep(-0.2, 0.6, field.mask));
  background += paletteRamp(0.05) * 0.006;

  // Dust lanes sit in front of the envelope and the diffuse body, but behind
  // the resolved emission, so they carve dark channels through the gas.
  float dustSupport = smoothstep(0.08, 0.55, cloud);
  float absorption = exp(-max(density, 0.0) * 2.6 - field.dust * 1.05 * dustSupport);
  vec3 behind = background + backGlow + ambient;
  vec3 color = behind * absorption + body + radiance;
  color *= exp(-field.dust * 0.55 * dustSupport);

  vec3 stars = starfield(sky, uStarDensity, uSeed, absorption * exp(-field.dust), uTime) * 0.85;
  color += stars;

  float vignette = 1.0 - uVignette * smoothstep(0.38, 1.28, length(sky));
  color *= vignette;

  vec3 srgb = presentColor(color, uExposure);

  // Dither before 8-bit quantization to prevent banding in the dark gradients.
  float dither = (ign(frag) - 0.5) * (1.0 / 255.0);
  fragColor = vec4(srgb + dither, 1.0);
}
