// ---------------------------------------------------------------------------
// density.glsl — the nebula model
//
// The visual is derived from a scalar density field, never from noise mapped
// directly to RGB. Two samplers share the same parameter model:
//   sampleDensity2D — screen-space field used by nebula.frag
//   sampleDensity3D — unit-cube field used by volume.frag
// ---------------------------------------------------------------------------

uniform uint uSeed;
uniform float uDensity;
uniform float uScale;
uniform float uWarp;
uniform int uOctaves;
uniform float uDetail;
uniform float uLacunarity;
uniform float uPersistence;
uniform float uAnimationSpeed;
uniform float uTime;
uniform float uRotation;

struct DensityField {
  float density;   // final optical density, roughly [0, 1.4]
  float cloud;     // billowy base component [0, 1]
  float filament;  // ridged contribution [0, 1]
  float shape;     // pre-threshold signed field, used for ambient haze
  float mask;      // low-frequency spatial mask
};

vec2 rotate2(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c) * p;
}

/** Aspect-correct, rotated nebula coordinates; y spans ±uScale. */
vec2 nebulaCoordinates(vec2 fragCoord, vec2 resolution) {
  vec2 centered = (fragCoord - 0.5 * resolution) / resolution.y * 2.0;
  vec2 p = centered * uScale;
  return rotate2(p, uTime * uRotation * 0.06);
}

/** Two-level domain warp with independent slow evolution per level. */
vec2 warpPoint(vec2 p, float t) {
  vec2 drift = vec2(t * 0.035, -t * 0.022);

  vec2 q = p * 0.52 + drift;
  float w1 = fbm2(q + vec2(0.0, t * 0.012), 3, 2.0, 0.55, uSeed + 11u);
  float w2 = fbm2(q + vec2(4.7, 1.9) - vec2(t * 0.014, 0.0), 3, 2.0, 0.55, uSeed + 29u);
  vec2 warped = p + uWarp * 0.78 * vec2(w1, w2);

  // The second level is evaluated in the warped space so fine detail follows
  // the large folds instead of sliding across them.
  vec2 r = warped * 0.9;
  float w3 = fbm2(r + vec2(8.3, 2.1) + t * 0.018, 2, 2.0, 0.5, uSeed + 53u);
  float w4 = fbm2(r + vec2(1.7, 6.4) - t * 0.016, 2, 2.0, 0.5, uSeed + 71u);
  return warped + uWarp * 0.32 * vec2(w3, w4);
}

DensityField sampleDensity2D(vec2 p, float t) {
  uint seed = uSeed;
  vec2 w = warpPoint(p, t);
  vec2 flow = vec2(t * 0.021, -t * 0.014);

  int octaves = clamp(uOctaves, 3, MAX_OCTAVES);
  int largeOctaves = min(octaves, 6);

  float nLarge = fbm2(w * 0.62 + flow, largeOctaves, uLacunarity, uPersistence, seed + 101u);
  float nMedium = fbm2(w * 1.45 - flow * 0.7 + vec2(2.3, 7.9), octaves, uLacunarity, uPersistence, seed + 211u);
  float nFine = fbm2(w * 3.35 + flow * 1.3, 3, uLacunarity, uPersistence, seed + 307u);
  float mask = fbm2(p * 0.33 + vec2(11.7, 4.1) + flow * 0.2, 3, 2.0, 0.5, seed + 401u);

  float shape = 0.62 * nLarge + 0.27 * nMedium + 0.13 * nFine;

  // Density moves a soft threshold rather than scaling the noise, so raising
  // it thickens existing clouds instead of filling empty space with noise.
  float dn = clamp((uDensity - 0.15) / 1.65, 0.0, 1.0);
  float threshold = mix(0.34, -0.02, dn) + mask * 0.24;
  float band = mix(0.34, 0.62, dn);
  float cloud = smoothstep(threshold, threshold + band, shape);

  // Ridged filaments: thin creases, only where the cloud body already exists.
  float ridge = ridged2(
    w * 2.05 + vec2(6.7, 2.9) + flow * 0.8,
    4, uLacunarity, uPersistence, seed + 503u
  );
  float filamentSupport = smoothstep(-0.02, 0.4, shape + mask * 0.1);
  float filament = smoothstep(0.42, 0.9, ridge) * filamentSupport;

  float d = cloud * 0.85 + filament * uDetail * 0.55;
  d = pow(clamp(d, 0.0, 1.4), 0.92);

  return DensityField(d, cloud, filament, shape, mask);
}

// ---------------------------------------------------------------------------
// 3D field for the raymarcher
// ---------------------------------------------------------------------------

/** Interleaved 3D fBm: three noise fields from one lattice pass. */
vec3 fbm3v(vec3 p, int octaves, float lacunarity, float gain, uint seed) {
  vec3 sum = vec3(0.0);
  float amplitude = 1.0;
  float norm = 0.0;

  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    sum += amplitude * gnoise3v(p, seed + uint(i) * 0x9E3779B9u);
    norm += amplitude;
    p = mat3(
      0.84403, 0.44938, -0.29340,
      -0.29340, 0.84403, 0.44938,
      0.44938, -0.29340, 0.84403
    ) * p * lacunarity + vec3(1.3, 7.1, 3.7);
    amplitude *= gain;
  }
  return sum / max(norm, 1e-5);
}

float sampleDensity3D(vec3 p, float t) {
  vec3 drift = vec3(t * 0.028, -t * 0.019, t * 0.011);
  vec3 q = p * (0.65 + 0.55 * uScale) + drift;

  vec3 warp = fbm3v(q * 1.15 + vec3(1.1, 5.3, 2.7), 2, 2.0, 0.5, uSeed + 13u);
  vec3 w = q + uWarp * 0.42 * warp;

  int octaves = clamp(uOctaves, 3, 6);
  float base = fbm3(w * 0.78 + vec3(0.0, 2.0, 4.0), octaves, uLacunarity, uPersistence, uSeed + 101u);
  float medium = fbm3(w * 1.75 - vec3(3.0, 1.0, 5.0), min(octaves, 4), uLacunarity, uPersistence, uSeed + 211u);
  float ridge = ridged3(w * 2.15 + vec3(5.5, 1.2, 8.4), 2, uLacunarity, uPersistence, uSeed + 503u);

  float shape = 0.7 * base + 0.3 * medium;
  float dn = clamp((uDensity - 0.15) / 1.65, 0.0, 1.0);
  float threshold = mix(0.24, -0.06, dn);
  float cloud = smoothstep(threshold, threshold + 0.42, shape);

  float filament = smoothstep(0.45, 0.92, ridge) * smoothstep(-0.1, 0.35, shape);
  return clamp(cloud * 0.9 + filament * uDetail * 0.7, 0.0, 1.5);
}
