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

/** One raymarch sample: emitting gas plus the dust that absorbs behind it. */
struct VolumeSample {
  float density;
  float dust;
  float detail;  // high-frequency field, used to granulate emission
};

vec2 rotate2(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c) * p;
}

/** Aspect-correct, rotated nebula coordinates; y spans ±uScale. */
vec2 nebulaCoordinates(vec2 fragCoord, vec2 resolution, float t) {
  vec2 centered = (fragCoord - 0.5 * resolution) / resolution.y * 2.0;
  vec2 p = centered * uScale;
  // `t` is already scaled by uAnimationSpeed, so rotation obeys the same clock
  // as every other motion term. Using raw uTime here let the field drift while
  // the animation speed was zero.
  return rotate2(p, t * uRotation * 0.06);
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
  int mediumOctaves = min(octaves, 6);

  // Large structure is sampled from the unwarped coordinates so the main
  // cloud masses stay coherent; only detail lives in the warped domain.
  float nLarge = fbm2(p * 0.55 + flow * 0.45, largeOctaves, uLacunarity, uPersistence, seed + 101u);
  float nMedium = fbm2(w * 1.32 - flow * 0.7 + vec2(2.3, 7.9), mediumOctaves, uLacunarity, uPersistence, seed + 211u);
  float nFine = fbm2(w * 3.4 + flow * 1.3, 3, uLacunarity, uPersistence, seed + 307u);
  float nMicro = fbm2(w * 6.8 + flow * 1.9, 2, uLacunarity, uPersistence, seed + 601u);
  // One high-frequency field supplies both pixel-scale grain and the emission
  // texture; the former nDetail/nGrain split cost two extra fBm evaluations for
  // detail the eye could not separate.
  float nGrain = fbm2(w * 16.0 + flow * 3.6, 2, 2.0, 0.5, seed + 877u);
  float mask = fbm2(p * 0.33 + vec2(11.7, 4.1) + flow * 0.2, 2, 2.0, 0.5, seed + 401u);
  // Broad envelope sampled at very low frequency: a dim veil of gas that the
  // bright structure sits inside, so the nebula is embedded rather than cut out.
  float nBack = fbm2(p * 0.30 + vec2(5.1, -3.7) - flow * 0.18, 2, 2.0, 0.55, seed + 809u);

  // Large-scale activity: some regions are quiescent sheets, others are churned.
  // Derived from fields already sampled, so the spatial variation is free.
  float activity = smoothstep(-0.55, 0.55, mask * 0.65 + nBack * 0.45);

  // Normalized fBm has a small standard deviation; stretch it so thresholds
  // operate over a predictable [-1, 1] range. The sheet is deliberately built
  // from the two largest scales: fine noise belongs in erosion and filaments,
  // not in the silhouette, or every iso-contour becomes a ribbon.
  float shape = (0.70 * nLarge + 0.28 * nMedium + 0.02 * nFine) * 1.9;

  // Density moves a soft threshold rather than scaling the noise, so raising
  // it thickens existing clouds instead of filling empty space with noise. The
  // broad envelope lowers the local threshold slightly, connecting the resolved
  // masses through a faint medium instead of leaving isolated islands.
  float dn = clamp((uDensity - 0.15) / 1.65, 0.0, 1.0);
  float threshold = mix(0.32, -0.12, dn) + mask * 0.16 - (nBack * 0.5 + 0.5) * 0.08;
  float band = mix(0.38, 0.52, dn);
  float cloud = smoothstep(threshold, threshold + band, shape);

  // Turbulence is spatially gated: active regions break into lobes and holes,
  // quiet regions stay smooth. A constant multiplier everywhere was the main
  // reason the field read as one uniform marbled sheet. The modulation is kept
  // close to unity so it carves the cloud instead of shredding it.
  float churn = smoothstep(-0.6, 0.55, nMedium * 1.2 + nFine * 0.35);
  float turbulence = mix(0.88, 1.05, activity) * mix(0.93, 1.05, churn);
  cloud = clamp(cloud * turbulence, 0.0, 1.0);

  // Clump scale reuses the medium field: no extra noise, but lobes and knots
  // where real clouds stop looking smooth.
  float clumps = smoothstep(-0.4, 0.6, nMedium * 1.2 + nFine * 0.6);
  cloud *= mix(0.85, 1.04, clumps);

  // High-frequency erosion: creases eat into the body where gas already exists,
  // so surfaces are feathered at the scale the eye reads as gas.
  float erosion = abs(fbm2(w * 12.0 + flow * 3.0, 2, uLacunarity, uPersistence, seed + 1013u));
  cloud *= 1.0 - 0.20 * erosion * smoothstep(0.08, 0.55, cloud);
  cloud = pow(clamp(cloud, 0.0, 1.0), 1.05);

  // A few dense cores: the top of the cloud distribution, broken by fine noise
  // so the brightest knots do not form a smooth plateau.
  float core = smoothstep(0.58, 0.92, cloud)
             * (0.55 + 0.45 * smoothstep(-0.3, 0.5, nFine));

  // Two crossing crease families supply the veils and the dust lanes. The
  // emitting network itself is built below from iso-lines, not from these.
  float ridge = ridged2(
    w * 1.65 + vec2(6.7, 2.9) + flow * 0.8,
    2, uLacunarity, uPersistence, seed + 503u
  );
  vec2 w2 = rotate2(w, 1.05);
  float ridge2 = ridged2(
    w2 * 2.1 + vec2(-4.2, 7.6) - flow * 0.6,
    2, uLacunarity, uPersistence, seed + 907u
  );

  // Thin filament network: the zero-crossing contours of two gradient-noise
  // fields. An iso-line is inherently thin and connected across the whole
  // cloud, where a thresholded ridged fBm gives broad, disconnected blobs.
  // Crossing two families produces junctions, so the web branches.
  float lineA = 1.0 - smoothstep(
    0.0, 0.10, abs(gnoise2(w * 2.55 + vec2(3.3, 8.1) + flow * 0.9, seed + 1301u))
  );
  vec2 fw = rotate2(w, 1.05);
  float lineB = 1.0 - smoothstep(
    0.0, 0.085, abs(gnoise2(fw * 3.15 + vec2(-6.1, 2.4) - flow * 0.7, seed + 1409u))
  );
  float network = max(lineA, 0.78 * lineB);

  float iso = threshold + band * 0.42;
  float edgeBand = 1.0 - smoothstep(0.0, 0.22, abs(shape - iso));
  float filament = network
                 * smoothstep(0.12, 0.45, cloud)
                 * (0.55 + 0.45 * edgeBand)
                 * mix(0.55, 1.0, activity);

  // The second family doubles as fine lace: the smallest threads that keep the
  // picture alive at full resolution. Emission-only, so it never thickens the
  // density model.
  float lace = lineB * smoothstep(0.12, 0.45, cloud) * mix(0.35, 0.9, activity);

  // Foreground dust: a separate, wider crease family. It is not applied to the
  // density here — dust absorbs light from behind, it does not delete gas.
  float dust = max(smoothstep(0.48, 0.86, ridge2), 0.55 * smoothstep(0.58, 0.92, ridge))
             * smoothstep(-0.35, 0.45, shape + mask * 0.18)
             * mix(0.45, 1.0, activity);

  // Diffuse envelope: broad, low-contrast gas behind the resolved structure.
  float back = smoothstep(-0.32, 0.58, nBack * 1.1 + nLarge * 0.45 + mask * 0.15);
  float veil = 0.13 * smoothstep(-0.2, 0.6, nBack) * smoothstep(-0.45, 0.5, nLarge + mask * 0.3);

  float d = cloud * 0.90 + core * 0.30 + filament * uDetail * 0.48
          + lace * uDetail * 0.08 + veil;
  d = pow(clamp(d, 0.0, 1.5), 0.95);

  return DensityField(
    d, cloud, filament, shape, mask,
    nFine * 0.35 + nMicro * 0.30 + nGrain * 0.35,
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

VolumeSample sampleDensity3D(vec3 p, float t) {
  // The gas is a sphere inside the unit cube; reject the corner samples before
  // touching the noise. The cutoff sits outside the envelope's support, so it
  // never truncates a non-zero density: a cutoff inside the support would leave
  // a faint shell of constant value at exactly that radius, which is a hard
  // sphere edge — the one artifact the envelope exists to prevent.
  float radius2 = dot(p, p);
  if (radius2 > 1.0) return VolumeSample(0.0, 0.0, 0.0);

  vec3 drift = vec3(t * 0.028, -t * 0.019, t * 0.011);
  vec3 q = p * (0.85 + 0.45 * uScale) + drift;

  // One warp octave is enough to bend the volume; the displacement is kept
  // below one noise cell, because a large warp turns the large masses into
  // smeared, fabric-like sheets that no longer read as gas.
  vec3 warp = fbm3v(q * 1.25 + vec3(1.1, 5.3, 2.7), 1, 2.0, 0.5, uSeed + 13u);
  vec3 w = q + uWarp * 0.22 * warp;
  // The warp is a low-frequency field already paid for, so it doubles as the
  // spatial mask that splits the scene into dense and quiescent regions. Without
  // it the gas settles into one round mass with a sphere-shaped silhouette.
  float mask = warp.x;

  // Spherical envelope on the original cube coordinates: gas fades out before
  // the slab boundary, so no hard cube faces are ever visible. The mask makes
  // the fade ragged, which keeps the mass from reading as a sphere. The outer
  // edge is clamped inside the rejection radius above, so the field is exactly
  // zero on the shell where sampling stops. Written in the ascending-edge form
  // because smoothstep(edge0 > edge1) is undefined in GLSL. Computed before the
  // early-out below, because the haze it scales must be enveloped too: an
  // unattenuated haze would put a faint constant shell exactly at the cutoff.
  float radius = sqrt(radius2);
  float edge = clamp(0.90 + 0.08 * mask, 0.72, 0.975);
  float envelope = 1.0 - smoothstep(edge - 0.32, edge, radius);

  int octaves = clamp(uOctaves, 3, 7);
  // Four base octaves carry the mass, two medium octaves the lobes, and a fine
  // field the internal texture. The same three-level hierarchy as the 2D field.
  float base = fbm3(w * 0.98 + vec3(0.0, 2.0, 4.0), min(octaves, 4), uLacunarity, uPersistence, uSeed + 101u);
  float medium = fbm3(w * 2.20 - vec3(3.0, 1.0, 5.0), min(octaves, 2), uLacunarity, uPersistence, uSeed + 211u);

  // The stretch factor matches the 2D field. Normalized fBm has a narrow
  // distribution, so without it every sample sits inside the smoothstep
  // transition: the result is uniform translucent smoke filling the sphere
  // instead of a cloud with an edge, a body and empty space between masses.
  float dn = clamp((uDensity - 0.15) / 1.65, 0.0, 1.0);
  float threshold = mix(0.32, -0.14, dn) + mask * 0.12;
  float band = mix(0.26, 0.40, dn);

  // Cheap exact early-out. Normalized fBm never leaves [-1, 1], so the fine
  // contribution of the shape field is bounded. When the two fields already
  // sampled cannot reach the smoothstep's lower edge even with a maximal fine
  // term, every cloud-gated component (cloud, core, veils, dust) is exactly
  // zero, and only the haze survives. The test costs nothing extra and removes
  // six of the thirteen noise evaluations for the empty half of the volume,
  // which is where a raymarcher spends most of its samples.
  float coarse = (0.68 * base + 0.24 * medium) * 1.9;
  float fineWeight = (0.03 + 0.06 * uDetail) * 1.9;
  if (coarse + fineWeight < threshold) {
    float ambient = 0.07 * smoothstep(-0.5, 0.30, coarse) * envelope;
    return VolumeSample(ambient, 0.0, 0.0);
  }

  float fine = fbm3(w * 4.60 + vec3(2.2, 6.4, 1.7), 2, uLacunarity, uPersistence, uSeed + 307u);
  float shape = coarse + fineWeight * fine;
  float cloud = smoothstep(threshold, threshold + band, shape);

  // Large-scale activity, derived from the fields already sampled: quiescent
  // sheets stay smooth, active regions churn. The modulation stays close to
  // unity so it carves the cloud instead of shredding it.
  float activity = smoothstep(-0.5, 0.5, base * 0.7 + medium * 0.4);
  cloud *= mix(0.88, 1.06, activity);

  float clumps = smoothstep(-0.4, 0.6, medium * 1.2 + fine * 0.6);
  cloud *= mix(0.84, 1.04, clumps);

  // Erosion reuses the fine field: creases eat into the body where gas already
  // exists, feathering surfaces at the scale the eye reads as gas. No extra
  // noise evaluation.
  cloud *= 1.0 - (0.10 + 0.30 * uDetail) * abs(fine) * smoothstep(0.10, 0.55, cloud);
  cloud = pow(clamp(cloud, 0.0, 1.0), 1.06);

  // A few dense cores, broken by the medium field so they form knots.
  float core = smoothstep(0.68, 0.97, cloud)
             * (0.55 + 0.45 * smoothstep(-0.2, 0.6, medium));

  // Thin veils inside the body. The crease of a low-frequency ridged field is a
  // sheet, not a thread, but at this weight and frequency it reads as the
  // filigree that real nebulae show, and its thickness stays above the raymarch
  // step so it does not sparkle. Gated by the cloud and scaled by `detail`.
  float veils = ridged3(w * 1.35 + vec3(4.1, -2.6, 6.8), 2, uLacunarity, uPersistence, uSeed + 1801u);
  float veil = smoothstep(0.62, 0.94, veils)
             * smoothstep(0.06, 0.40, cloud)
             * uDetail;

  // Dust absorbs without emitting: two low-frequency shells form dark lanes
  // that cross the gas. The bands are wide enough to be resolved by ~50
  // raymarch steps — a thinner shell is hit only intermittently and speckles
  // instead of darkening — and the absorption per unit density is moderate, so
  // a lane seen face-on dims the gas behind it instead of punching a hole.
  float dustA = 1.0 - smoothstep(
    0.0, 0.22, abs(gnoise3(w * 1.05 + vec3(-2.0, 4.6, 1.3), uSeed + 1601u))
  );
  float dustB = 1.0 - smoothstep(
    0.0, 0.20, abs(gnoise3(w * 1.45 + vec3(6.4, -1.7, 3.8), uSeed + 1709u))
  );
  float dust = max(dustA, 0.65 * dustB)
             * smoothstep(0.02, 0.36, cloud)
             * mix(0.5, 1.0, activity);

  // A thin ambient haze surrounds the resolved cloud, so the volume reads as
  // gas embedded in space rather than a solid object with a cut edge.
  float haze = 0.10 * smoothstep(-0.5, 0.30, shape);

  float density = (cloud * 0.75 + core * 0.22 + veil * 0.20 + haze * 0.7) * envelope;
  return VolumeSample(clamp(density, 0.0, 1.5), clamp(dust * envelope, 0.0, 1.0), fine);
}
