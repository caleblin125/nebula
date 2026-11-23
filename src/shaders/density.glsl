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
  float density;   // final optical density, roughly [0, 1.5]
  float cloud;     // billowy base component [0, 1]
  float filament;  // ridged contribution [0, 1]
  float shape;     // pre-threshold signed field, used for ambient haze
  float mask;      // low-frequency spatial mask
  float fine;      // high-frequency detail field, for emission texture
  float ridge;     // raw ridged field, for localized highlights
  float back;      // broad, dim gas envelope behind the main cloud
  float dust;      // foreground absorption lanes [0, 1]
  float lace;      // fine filamentary texture, visible at pixel scale
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

  // The first warp runs near the base frequency and bends cloud edges; the
  // second is finer and only perturbs detail, avoiding large-scale smearing.
  vec2 q = p * 1.05 + drift;
  float w1 = fbm2(q + vec2(0.0, t * 0.012), 3, 2.0, 0.55, uSeed + 11u);
  float w2 = fbm2(q + vec2(4.7, 1.9) - vec2(t * 0.014, 0.0), 3, 2.0, 0.55, uSeed + 29u);
  vec2 warped = p + uWarp * 0.38 * vec2(w1, w2);

  vec2 r = warped * 1.9;
  float w3 = fbm2(r + vec2(8.3, 2.1) + t * 0.018, 2, 2.0, 0.5, uSeed + 53u);
  float w4 = fbm2(r + vec2(1.7, 6.4) - t * 0.016, 2, 2.0, 0.5, uSeed + 71u);
  return warped + uWarp * 0.17 * vec2(w3, w4);
}

DensityField sampleDensity2D(vec2 p, float t) {
  uint seed = uSeed;
  vec2 w = warpPoint(p, t);
  vec2 flow = vec2(t * 0.021, -t * 0.014);

  int octaves = clamp(uOctaves, 3, MAX_OCTAVES);
  int largeOctaves = min(octaves, 5);

  // Large structure is sampled from the unwarped coordinates so the main
  // cloud masses stay coherent; only detail lives in the warped domain.
  float nLarge = fbm2(p * 0.55 + flow * 0.45, largeOctaves, uLacunarity, uPersistence, seed + 101u);
  float nMedium = fbm2(w * 1.32 - flow * 0.7 + vec2(2.3, 7.9), octaves, uLacunarity, uPersistence, seed + 211u);
  float nFine = fbm2(w * 3.4 + flow * 1.3, 3, uLacunarity, uPersistence, seed + 307u);
  float nMicro = fbm2(w * 6.8 + flow * 1.9, 2, uLacunarity, uPersistence, seed + 601u);
  float nDetail = fbm2(w * 9.5 + flow * 2.6, 2, uLacunarity, uPersistence, seed + 733u);
  // Pixel-scale grain: wavelengths of a few dozen pixels give the cloud a
  // textured, gaseous surface instead of a smooth painted gradient.
  float nGrain = fbm2(w * 22.0 + flow * 5.0, 2, 2.0, 0.5, seed + 877u);
  float mask = fbm2(p * 0.33 + vec2(11.7, 4.1) + flow * 0.2, 3, 2.0, 0.5, seed + 401u);
  // Broad envelope sampled at very low frequency: a dim veil of gas that the
  // bright structure sits inside, so the nebula is embedded rather than cut out.
  float nBack = fbm2(p * 0.30 + vec2(5.1, -3.7) - flow * 0.18, 3, 2.0, 0.55, seed + 809u);

  // Normalized fBm has a small standard deviation; stretch it so thresholds
  // operate over a predictable [-1, 1] range. The detail term is added
  // directly to break up smooth boundaries with fine lace.
  float shape = (0.52 * nLarge + 0.26 * nMedium + 0.15 * nFine + 0.07 * nMicro) * 1.9
              + 0.22 * nDetail;

  // Density moves a soft threshold rather than scaling the noise, so raising
  // it thickens existing clouds instead of filling empty space with noise.
  float dn = clamp((uDensity - 0.15) / 1.65, 0.0, 1.0);
  float threshold = mix(0.42, 0.02, dn) + mask * 0.3;
  float band = mix(0.22, 0.4, dn);
  float cloud = smoothstep(threshold, threshold + band, shape);

  // Multiplicative turbulence: broad cloud masks become ragged gas with holes
  // instead of solid white shapes.
  float turbulence = 0.28 + 0.9 * smoothstep(-0.5, 0.6, nMedium * 2.2 + nFine * 0.7);
  cloud *= turbulence;

  // Clumpiness at an in-between frequency: patches of density that break the
  // sheet into lobes and knots, the scale where real clouds stop looking smooth.
  float nClump = fbm2(w * 2.9 + flow * 1.1 + vec2(9.1, 3.3), 3, uLacunarity, uPersistence, seed + 971u);
  float clumpMask = smoothstep(-0.45, 0.6, nClump * 1.7 + nFine * 0.5);
  cloud *= 0.52 + 0.6 * clumpMask;

  // High-frequency erosion: thin noise creases eat into the body, so cloud
  // surfaces are feathered at a scale the eye reads as gas, not gradients.
  float erosion = abs(fbm2(w * 13.0 + flow * 3.0, 2, uLacunarity, uPersistence, seed + 1013u));
  cloud *= 1.0 - 0.3 * erosion * smoothstep(0.05, 0.55, cloud);

  cloud = pow(clamp(cloud, 0.0, 1.0), 1.12);

  // Ridged filaments: thin creases, attached to the cloud body but allowed to
  // reach a little into the dark lanes. Moderate ridges carve dark dust;
  // only the sharpest crests emit.
  float ridge = ridged2(
    w * 1.85 + vec2(6.7, 2.9) + flow * 0.8,
    4, uLacunarity, uPersistence, seed + 503u
  );
  // A second ridge set is sampled in rotated coordinates at a different scale.
  // Two crossing crease families keep the cloud from reading as one flowing
  // sheet of fabric; they also give the dust lanes a direction of their own.
  vec2 w2 = rotate2(w, 1.05);
  float ridge2 = ridged2(
    w2 * 2.35 + vec2(-4.2, 7.6) - flow * 0.6,
    3, uLacunarity, uPersistence, seed + 907u
  );

  float filamentSupport = smoothstep(-0.15, 0.4, shape + mask * 0.12);
  float lane = smoothstep(0.30, 0.72, ridge);
  float lane2 = smoothstep(0.44, 0.84, ridge2);
  cloud *= 1.0 - 0.34 * lane * smoothstep(0.12, 0.6, cloud);

  float filament = max(smoothstep(0.68, 0.97, ridge), 0.7 * smoothstep(0.72, 0.98, ridge2))
                 * filamentSupport * smoothstep(0.05, 0.5, cloud);

  // A third, much finer ridge set supplies lace: the small filaments and
  // tendrils that keep the picture alive when viewed at full resolution. The
  // domain is stretched so the creases read as directional threads instead of
  // the closed cells an isotropic ridge field produces.
  vec2 lw = rotate2(w, 0.45);
  float laceRidge = ridged2(
    vec2(lw.x * 5.2, lw.y * 12.5) + flow * 2.0,
    2, uLacunarity, uPersistence, seed + 1201u
  );
  float lace = smoothstep(0.58, 0.92, laceRidge)
             * smoothstep(0.05, 0.45, cloud) * filamentSupport;

  // Foreground dust: sharp creases that absorb light rather than emit it.
  // Allowed to reach a little past the gas body so lanes cross its edges.
  float dust = max(lane2 * 0.85, lane * 0.3) * smoothstep(-0.4, 0.45, shape + mask * 0.15);
  cloud *= 1.0 - 0.45 * dust * smoothstep(0.1, 0.6, cloud);

  // Diffuse envelope: broad, low-contrast gas behind the resolved structure.
  float back = smoothstep(-0.35, 0.6, nBack) * smoothstep(-0.5, 0.55, nLarge + mask * 0.2);

  float d = cloud * 0.95 + filament * uDetail * 0.55 + lace * uDetail * 0.2;
  d = pow(clamp(d, 0.0, 1.5), 0.92);

  return DensityField(
    d, cloud, filament, shape, mask,
    nFine * 0.3 + nMicro * 0.22 + nDetail * 0.16 + nGrain * 0.32,
    ridge, back, dust, lace
  );
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
  // The gas is a sphere inside the unit cube; reject the corner samples before
  // touching the noise, which is roughly half of the cube volume.
  float radius2 = dot(p, p);
  if (radius2 > 0.952) return 0.0;

  vec3 drift = vec3(t * 0.028, -t * 0.019, t * 0.011);
  vec3 q = p * (0.65 + 0.55 * uScale) + drift;

  // One warp octave is enough to bend the volume; the extra octave only moved
  // sub-sample detail that the raymarcher cannot resolve anyway.
  vec3 warp = fbm3v(q * 1.15 + vec3(1.1, 5.3, 2.7), 1, 2.0, 0.5, uSeed + 13u);
  vec3 w = q + uWarp * 0.42 * warp;

  int octaves = clamp(uOctaves, 3, 5);
  float base = fbm3(w * 0.78 + vec3(0.0, 2.0, 4.0), octaves, uLacunarity, uPersistence, uSeed + 101u);
  float medium = fbm3(w * 1.75 - vec3(3.0, 1.0, 5.0), min(octaves, 3), uLacunarity, uPersistence, uSeed + 211u);

  float shape = 0.7 * base + 0.3 * medium;
  float dn = clamp((uDensity - 0.15) / 1.65, 0.0, 1.0);
  float threshold = mix(0.24, -0.06, dn);
  float cloud = smoothstep(threshold, threshold + 0.42, shape);

  // The ridge term is zero below shape -0.1, so skip four octaves of work in
  // the dark parts of the volume.
  float filament = 0.0;
  if (shape > -0.1) {
    float ridge = ridged3(w * 2.15 + vec3(5.5, 1.2, 8.4), 2, uLacunarity, uPersistence, uSeed + 503u);
    filament = smoothstep(0.45, 0.92, ridge) * smoothstep(-0.1, 0.35, shape);
  }

  // A thin ambient haze surrounds the resolved cloud, so the volume reads as
  // gas embedded in space rather than a solid object with a cut edge.
  float haze = 0.16 * smoothstep(-0.55, 0.28, shape);

  // Spherical envelope on the original cube coordinates: gas fades out before
  // the slab boundary, so no hard cube faces are ever visible.
  float envelope = smoothstep(0.98, 0.62, sqrt(radius2));

  return clamp((cloud * 0.8 + filament * uDetail * 1.0 + haze) * envelope, 0.0, 1.5);
}
