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
 *
 * `density` is a raymarched optical density: most of the visible body sits
 * between 0.5 and 0.9 while a few knots exceed 1. Mapping the raw value onto
 * the ramp put the entire nebula on the magenta stop, so the range is
 * compressed here rather than at every call site.
 */
vec3 emissionColor(float density, float hot) {
  float d = clamp(density, 0.0, 1.5);
  float ionization = clamp(hot, 0.0, 1.0);
  // The ramp index tracks the 2D model: tenuous gas sits on the blue stop, the
  // body on cyan, and only the knots reach the violet/pink stops. Mapping the
  // raw density here put the entire cloud on the pale stops at once.
  vec3 cool = paletteRamp(0.06 + 0.45 * d);
  vec3 core = paletteRamp(0.72 + 0.20 * d);
  return mix(cool, core, ionization * smoothstep(0.35, 0.90, d));
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

/**
 * Hue-preserving highlight shoulder. Compresses only values above `knee`,
 * scaling all channels by the same factor so a bright core keeps its colour
 * and internal structure instead of clipping to a flat white plate before the
 * bloom pass. `range` controls how much headroom remains above the knee.
 */
vec3 compressHighlights(vec3 color, float knee, float range, float softness) {
  float peak = max(color.r, max(color.g, color.b));
  if (peak <= knee) return color;
  float shoulder = knee + range * (1.0 - exp(-(peak - knee) / softness));
  return color * (shoulder / max(peak, 1e-5));
}

/** Linear radiance → display sRGB using the exact piecewise transfer. */
vec3 linearToSrgb(vec3 linearColor) {
  vec3 c = clamp(linearColor, 0.0, 1.0);
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}

/** Linear radiance → display sRGB. */
vec3 presentColor(vec3 linearColor, float exposure) {
  vec3 mapped = acesFilm(linearColor * exposure);
  return linearToSrgb(mapped);
}
