// ---------------------------------------------------------------------------
// stars.glsl — sparse procedural star field
//
// Stars are drawn on a hashed screen-space lattice, independent of the nebulae
// so they never inherit cloud motion. Two layers give a mix of faint dust and
// a few bright points. Dense gas absorbs them, which ties the layers together.
// ---------------------------------------------------------------------------

float starPresence(ivec2 cell, uint salt) {
  return hash01(hashCell(cell, salt));
}

vec3 starLayer(
  vec2 sky,
  float cellSize,
  float probability,
  uint seed,
  float brightness,
  float absorption,
  float time
) {
  vec2 grid = sky / cellSize;
  vec2 cellF = floor(grid);
  ivec2 cell = ivec2(cellF);
  vec2 f = grid - cellF;

  if (starPresence(cell, seed) > probability) return vec3(0.0);

  float rx = hash01(hashCell(cell, seed + 17u));
  float ry = hash01(hashCell(cell, seed + 31u));
  float magnitude = hash01(hashCell(cell, seed + 47u));
  float temperature = hash01(hashCell(cell, seed + 59u));

  vec2 local = (f - vec2(0.16 + 0.68 * rx, 0.16 + 0.68 * ry)) * cellSize;
  float dist = length(local);

  // Small, sharply resolved cores. Brightness lives in the intensity term, not
  // in the radius, so stars read as points of light rather than fuzzy blobs.
  float radius = 0.0011 + 0.0019 * pow(magnitude, 6.0);
  float aa = max(fwidth(dist), 0.0004);
  float disc = 1.0 - smoothstep(radius - aa, radius + aa, dist);
  float halo = exp(-dist * dist / (radius * radius * 5.0)) * 0.06;

  // Faint four-point diffraction cross on the brightest few percent.
  float cross = 0.0;
  if (magnitude > 0.82) {
    vec2 axis = abs(local);
    float streak = exp(-axis.y / (aa * 1.4)) * exp(-axis.x / (radius * 7.0))
                 + exp(-axis.x / (aa * 1.4)) * exp(-axis.y / (radius * 7.0));
    cross = streak * 0.08;
  }

  float intensity = brightness * (0.1 + 2.3 * pow(magnitude, 8.0));

  // Slow atmospheric twinkle, never a strobe.
  float flicker = 0.92 + 0.08 * sin(time * 0.55 + magnitude * 41.0);

  vec3 cool = vec3(0.62, 0.76, 1.0);
  vec3 warm = vec3(1.0, 0.80, 0.58);
  vec3 tint = mix(cool, warm, temperature * temperature);

  return tint * (disc + halo + cross) * intensity * flicker * absorption;
}

vec3 starfield(vec2 sky, float density, uint seed, float absorption, float time) {
  if (density <= 0.001) return vec3(0.0);

  vec3 stars = vec3(0.0);
  stars += starLayer(sky, 0.075, density * 0.42, seed + 7001u, 0.55, absorption, time);
  stars += starLayer(sky, 0.15, density * 0.17, seed + 9109u, 1.0, absorption, time);
  stars += starLayer(sky, 0.30, density * 0.05, seed + 11213u, 1.7, absorption, time);
  return stars;
}
