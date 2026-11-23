// ---------------------------------------------------------------------------
// color.glsl — palette, emission ramps, tone mapping
//
// Color is deliberately downstream of density. The density field knows
// nothing about palettes; this module maps density / ionization to radiance.
// ---------------------------------------------------------------------------

uniform vec3 uColor0;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec3 uColor4;
uniform vec3 uBackground;
uniform float uEmission;
uniform float uExposure;

/** Five-stop palette ramp, smooth across every segment. */
vec3 paletteRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) {
    return mix(uColor0, uColor1, smoothstep(0.0, 0.25, t));
  }
  if (t < 0.5) {
    return mix(uColor1, uColor2, smoothstep(0.25, 0.5, t));
  }
  if (t < 0.78) {
    return mix(uColor2, uColor3, smoothstep(0.5, 0.78, t));
  }
  return mix(uColor3, uColor4, smoothstep(0.78, 1.0, t));
}

/**
 * Nebular radiance: faint gas keeps the cold outer color, dense cores pick up
 * the ionized stop. `hot` is a localized ionization signal in [0, 1].
 */
vec3 emissionColor(float density, float hot) {
  float t = pow(clamp(density, 0.0, 1.0), 1.25);
  float ionization = clamp(hot, 0.0, 1.0);
  vec3 cool = paletteRamp(t * 0.82);
  vec3 core = paletteRamp(0.72 + 0.28 * t);
  return mix(cool, core, ionization * smoothstep(0.35, 0.95, density));
}

/** ACES filmic curve — rolls off hot nebulae without clipping to white. */
vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/** Linear radiance → display sRGB. */
vec3 presentColor(vec3 linearColor, float exposure) {
  vec3 mapped = acesFilm(linearColor * exposure);
  return pow(mapped, vec3(1.0 / 2.2));
}
