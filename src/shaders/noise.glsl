// ---------------------------------------------------------------------------
// noise.glsl — deterministic gradient noise, fBm, ridged multifractal
//
// All fields are evaluated analytically. No textures, no RNG state: a cell
// coordinate and an integer seed fully determine every value, which makes the
// output reproducible on any GPU (barring floating-point rounding).
// ---------------------------------------------------------------------------

const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
const int MAX_OCTAVES = 10;

// Rotation applied between octaves to break axis alignment.
const mat2 OCTAVE_ROT = mat2(0.8, 0.6, -0.6, 0.8);

// 16 evenly spaced unit gradients (avoids per-corner trigonometry).
const vec2 GRAD2[16] = vec2[16](
  vec2( 1.0000,  0.0000), vec2( 0.9239,  0.3827),
  vec2( 0.7071,  0.7071), vec2( 0.3827,  0.9239),
  vec2( 0.0000,  1.0000), vec2(-0.3827,  0.9239),
  vec2(-0.7071,  0.7071), vec2(-0.9239,  0.3827),
  vec2(-1.0000,  0.0000), vec2(-0.9239, -0.3827),
  vec2(-0.7071, -0.7071), vec2(-0.3827, -0.9239),
  vec2( 0.0000, -1.0000), vec2( 0.3827, -0.9239),
  vec2( 0.7071, -0.7071), vec2( 0.9239, -0.3827)
);

// The 12 edge directions of a cube give an isotropic 3D gradient set.
const vec3 GRAD3[12] = vec3[12](
  vec3( 1, 1, 0), vec3(-1, 1, 0), vec3( 1,-1, 0), vec3(-1,-1, 0),
  vec3( 1, 0, 1), vec3(-1, 0, 1), vec3( 1, 0,-1), vec3(-1, 0,-1),
  vec3( 0, 1, 1), vec3( 0,-1, 1), vec3( 0, 1,-1), vec3( 0,-1,-1)
);

uint hashCell(ivec2 cell, uint seed) {
  uint h = uint(cell.x) * 0x9E3779B1u
         ^ uint(cell.y) * 0x85EBCA77u
         ^ seed * 0xC2B2AE3Du;
  h ^= h >> 15u;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12u;
  h *= 0x297A2D39u;
  h ^= h >> 15u;
  return h;
}

uint hashCell3(ivec3 cell, uint seed) {
  uint h = uint(cell.x) * 0x9E3779B1u
         ^ uint(cell.y) * 0x85EBCA77u
         ^ uint(cell.z) * 0xC2B2AE3Du
         ^ seed * 0x27D4EB2Fu;
  h ^= h >> 15u;
  h *= 0x2C1B3C6Du;
  h ^= h >> 12u;
  h *= 0x297A2D39u;
  h ^= h >> 15u;
  return h;
}

// ---------------------------------------------------------------------------
// 2D gradient noise, quintic interpolation
// ---------------------------------------------------------------------------

float gnoise2(vec2 p, uint seed) {
  vec2 pf = floor(p);
  vec2 f = p - pf;
  ivec2 cell = ivec2(pf);

  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float a = dot(GRAD2[int(hashCell(cell, seed) & 15u)], f);
  float b = dot(GRAD2[int(hashCell(cell + ivec2(1, 0), seed) & 15u)], f - vec2(1.0, 0.0));
  float c = dot(GRAD2[int(hashCell(cell + ivec2(0, 1), seed) & 15u)], f - vec2(0.0, 1.0));
  float d = dot(GRAD2[int(hashCell(cell + ivec2(1, 1), seed) & 15u)], f - vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.55;
}

// ---------------------------------------------------------------------------
// 3D gradient noise
// ---------------------------------------------------------------------------

float gnoise3(vec3 p, uint seed) {
  vec3 pf = floor(p);
  vec3 f = p - pf;
  ivec3 cell = ivec3(pf);

  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n000 = dot(GRAD3[int(hashCell3(cell, seed) % 12u)], f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(GRAD3[int(hashCell3(cell + ivec3(1, 0, 0), seed) % 12u)], f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(GRAD3[int(hashCell3(cell + ivec3(0, 1, 0), seed) % 12u)], f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(GRAD3[int(hashCell3(cell + ivec3(1, 1, 0), seed) % 12u)], f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(GRAD3[int(hashCell3(cell + ivec3(0, 0, 1), seed) % 12u)], f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(GRAD3[int(hashCell3(cell + ivec3(1, 0, 1), seed) % 12u)], f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(GRAD3[int(hashCell3(cell + ivec3(0, 1, 1), seed) % 12u)], f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(GRAD3[int(hashCell3(cell + ivec3(1, 1, 1), seed) % 12u)], f - vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  return mix(mix(nx00, nx10, u.y), mix(nx01, nx11, u.y), u.z) * 1.8;
}

// Three independent gradient-noise values sharing one lattice evaluation.
// Used by the volume warp, where three displacement components are needed.
vec3 cornerNoise3v(ivec3 cell, vec3 offset, uint seed) {
  uint h = hashCell3(cell, seed);
  vec3 g0 = GRAD3[int(h % 12u)];
  vec3 g1 = GRAD3[int((h >> 9u) % 12u)];
  vec3 g2 = GRAD3[int((h >> 21u) % 12u)];
  return vec3(dot(g0, offset), dot(g1, offset), dot(g2, offset));
}

vec3 gnoise3v(vec3 p, uint seed) {
  vec3 pf = floor(p);
  vec3 f = p - pf;
  ivec3 cell = ivec3(pf);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  vec3 n000 = cornerNoise3v(cell + ivec3(0, 0, 0), f - vec3(0.0, 0.0, 0.0), seed);
  vec3 n100 = cornerNoise3v(cell + ivec3(1, 0, 0), f - vec3(1.0, 0.0, 0.0), seed);
  vec3 n010 = cornerNoise3v(cell + ivec3(0, 1, 0), f - vec3(0.0, 1.0, 0.0), seed);
  vec3 n110 = cornerNoise3v(cell + ivec3(1, 1, 0), f - vec3(1.0, 1.0, 0.0), seed);
  vec3 n001 = cornerNoise3v(cell + ivec3(0, 0, 1), f - vec3(0.0, 0.0, 1.0), seed);
  vec3 n101 = cornerNoise3v(cell + ivec3(1, 0, 1), f - vec3(1.0, 0.0, 1.0), seed);
  vec3 n011 = cornerNoise3v(cell + ivec3(0, 1, 1), f - vec3(0.0, 1.0, 1.0), seed);
  vec3 n111 = cornerNoise3v(cell + ivec3(1, 1, 1), f - vec3(1.0, 1.0, 1.0), seed);

  vec3 nx00 = mix(n000, n100, u.x);
  vec3 nx10 = mix(n010, n110, u.x);
  vec3 nx01 = mix(n001, n101, u.x);
  vec3 nx11 = mix(n011, n111, u.x);
  return mix(mix(nx00, nx10, u.y), mix(nx01, nx11, u.y), u.z) * 1.8;
}

// ---------------------------------------------------------------------------
// Fractal sums
// ---------------------------------------------------------------------------

float fbm2(vec2 p, int octaves, float lacunarity, float gain, uint seed) {
  float sum = 0.0;
  float amplitude = 1.0;
  float norm = 0.0;

  for (int i = 0; i < MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    sum += amplitude * gnoise2(p, seed + uint(i) * 0x9E3779B9u);
    norm += amplitude;
    p = OCTAVE_ROT * p * lacunarity + vec2(1.7, 9.2);
    amplitude *= gain;
  }
  return sum / max(norm, 1e-5);
}

/**
 * Ridged multifractal: fold the noise around zero to produce creases, then
 * weight each subsequent octave by the previous ridge so detail concentrates
 * on the filaments instead of everywhere.
 */
float ridged2(vec2 p, int octaves, float lacunarity, float gain, uint seed) {
  float sum = 0.0;
  float amplitude = 0.55;
  float norm = 0.0;
  float previous = 1.0;

  for (int i = 0; i < MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(gnoise2(p, seed + uint(i) * 0x85EBCA77u));
    n *= n;
    sum += n * amplitude * previous;
    norm += amplitude;
    previous = clamp(n * 1.6, 0.0, 1.0);
    p = OCTAVE_ROT * p * lacunarity + vec2(3.1, 7.7);
    amplitude *= gain;
  }
  return sum / max(norm, 1e-5);
}

float fbm3(vec3 p, int octaves, float lacunarity, float gain, uint seed) {
  float sum = 0.0;
  float amplitude = 1.0;
  float norm = 0.0;

  for (int i = 0; i < MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    sum += amplitude * gnoise3(p, seed + uint(i) * 0x9E3779B9u);
    norm += amplitude;
    // 3D octave rotation: 40° about the (1,1,1) axis (orthonormal).
    p = mat3(
      0.84403, 0.44938, -0.29340,
      -0.29340, 0.84403, 0.44938,
      0.44938, -0.29340, 0.84403
    ) * p * lacunarity + vec3(1.3, 7.1, 3.7);
    amplitude *= gain;
  }
  return sum / max(norm, 1e-5);
}

float ridged3(vec3 p, int octaves, float lacunarity, float gain, uint seed) {
  float sum = 0.0;
  float amplitude = 0.55;
  float norm = 0.0;
  float previous = 1.0;

  for (int i = 0; i < MAX_OCTAVES; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(gnoise3(p, seed + uint(i) * 0x85EBCA77u));
    n *= n;
    sum += n * amplitude * previous;
    norm += amplitude;
    previous = clamp(n * 1.5, 0.0, 1.0);
    p = mat3(
      0.84403, 0.44938, -0.29340,
      -0.29340, 0.84403, 0.44938,
      0.44938, -0.29340, 0.84403
    ) * p * lacunarity + vec3(4.7, 2.3, 8.9);
    amplitude *= gain;
  }
  return sum / max(norm, 1e-5);
}

// ---------------------------------------------------------------------------
// Utility noise
// ---------------------------------------------------------------------------

/** Interleaved gradient noise — used to dither gradients before quantization. */
float ign(vec2 pixel) {
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

float hash01(uint h) {
  h ^= h >> 16u;
  h *= 0x7FEB352Du;
  h ^= h >> 15u;
  h *= 0x846CA68Bu;
  h ^= h >> 16u;
  return float(h) * (1.0 / 4294967296.0);
}
