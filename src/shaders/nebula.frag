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

  vec2 p = nebulaCoordinates(frag, uResolution, t);
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
  float core = pow(clamp(cloud, 0.0, 1.0), 4.0) * (0.45 + 0.55 * filament);
  float ionization = smoothstep(0.2, 0.85, 0.45 + field.mask * 0.4 + cloud * 0.35);

  // Temperature zones: the low-frequency mask splits the scene into cold
  // blue/cyan outer gas and hot violet/magenta inner gas. Without this the
  // whole cloud drifts toward one flat hue.
  float zone = smoothstep(-0.55, 0.55, field.mask);

  float gasIndex = clamp(0.04 + density * 0.46 + (zone - 0.5) * 0.22, 0.0, 1.0);
  vec3 gasColor = paletteRamp(gasIndex);
  vec3 coreColor = paletteRamp(0.6 + 0.28 * ionization);
  vec3 tint = mix(gasColor, coreColor, smoothstep(0.3, 0.9, cloud) * 0.6);

  // High-frequency modulation: the fine field is an emission texture, not extra
  // density. Kept below unity so it granulates patches without shredding them.
  float micro = smoothstep(-0.5, 0.55, field.fine * 2.6);
  float grit = 0.80 + 0.30 * micro;
  float gas = pow(clamp(density, 0.0, 1.3), 1.05) * 0.38 * grit;
  float coreGlow = core * 0.20;

  // Concentrated luminous veins: only the sharpest ridge crests, only inside
  // dense gas, warmed toward white at the hottest points. These were the
  // dominant white ribbons in the previous model; they are now a highlight.
  float vein = pow(smoothstep(0.70, 0.97, field.ridge), 1.15)
             * smoothstep(0.30, 0.68, cloud);
  vec3 hotTint = mix(paletteRamp(0.88 + 0.1 * ionization), vec3(1.0, 0.94, 0.9), 0.3);

  // Ionization rims: the density gradient lights up at cloud edges, where gas
  // meets the radiation field. fwidth keeps the effect resolution-independent.
  float rim = clamp(fwidth(density) * 4.5, 0.0, 0.8) * smoothstep(0.02, 0.3, cloud);
  vec3 rimTint = paletteRamp(0.5 + 0.2 * ionization);

  vec3 radiance = tint * (gas + coreGlow) * uEmission;
  radiance += hotTint * vein * 0.15 * uEmission;
  radiance += rimTint * rim * 0.14 * uEmission;

  // Fine lace filaments: emission only, so they read as glowing threads rather
  // than thickening the density model. Tinted by the cloud, never pure white.
  radiance += mix(tint, hotTint, 0.4) * field.lace * 0.15 * uEmission;

  // Slope shading derived from the density gradient adds a sense of relief
  // without another noise field. Kept low so gas never reads as a glossy sheet.
  vec2 densitySlope = vec2(dFdx(cloud), dFdy(cloud));
  float slope = clamp(dot(densitySlope, vec2(-0.6, 0.8)) * 13.0, -0.25, 0.25);
  radiance *= 1.0 + slope * smoothstep(0.08, 0.5, cloud) * 0.6;

  // Broad envelope behind the resolved cloud: dim, diffuse, slightly cooler.
  vec3 backGlow = paletteRamp(0.08 + 0.2 * field.back) * field.back * field.back * 0.16;

  // Cold outer gas: enough light to reveal volume without flattening contrast.
  vec3 body = paletteRamp(0.06 + 0.28 * density) * density * 0.14;

  // Soft halo from the pre-threshold field: gas just outside the resolved cloud
  // still scatters light, so masses fade into the dark instead of being cut out.
  float glow = smoothstep(-0.35, 0.6, field.shape + field.mask * 0.2);
  vec3 ambient = paletteRamp(0.22) * glow * 0.05;
  ambient += paletteRamp(0.3 + 0.18 * zone) * glow * glow * 0.045;

  // Wide atmospheric veil: a very dim, cool wash that keeps the negative space
  // from being pure black and gives the frame a sense of depth.
  float veil = smoothstep(-0.45, 0.6, field.mask + field.back * 0.5);
  ambient += paletteRamp(0.12 + 0.08 * zone) * veil * 0.045;

  // Background tint shifts slowly with the spatial mask.
  vec3 background = uBackground * (0.55 + 0.55 * smoothstep(-0.2, 0.6, field.mask));
  background += paletteRamp(0.05) * 0.008;

  // Dust lanes sit in front of the envelope and the diffuse body. They absorb
  // what is behind them rather than deleting density, so they read as dark
  // channels through the gas. A fraction of the front radiance survives so the
  // brightest knots still show through thin lanes.
  float dustSupport = smoothstep(-0.1, 0.5, cloud + field.back * 0.35);
  float dustDepth = field.dust * (0.35 + 0.9 * dustSupport);
  float dustTrans = exp(-dustDepth * 1.35);
  float absorption = exp(-max(density, 0.0) * 1.6) * dustTrans;
  vec3 behind = background + backGlow + ambient;
  vec3 color = behind * absorption + body * mix(0.3, 1.0, dustTrans);
  color += radiance * mix(0.55, 1.0, dustTrans);

  // Keep the brightest cores from clipping to a flat plate before bloom.
  color = compressHighlights(color, 0.78, 0.50, 0.6);

  vec3 stars = starfield(sky, uStarDensity, uSeed, absorption, t) * 0.85;
  color += stars;

  float vignette = 1.0 - uVignette * smoothstep(0.38, 1.28, length(sky));
  color *= vignette;

  vec3 srgb = presentColor(color, uExposure);

  // Dither before 8-bit quantization to prevent banding in the dark gradients.
  float dither = (ign(frag) - 0.5) * (1.0 / 255.0);
  fragColor = vec4(srgb + dither, 1.0);
}
