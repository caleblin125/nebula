#version 300 es
precision highp float;
precision highp int;

// ---------------------------------------------------------------------------
// post.frag — bloom for both renderers.
//
// One program, three passes selected by uPass:
//   0  bright extraction + downsample from the scene colour buffer
//   1  separable gaussian blur (uDirection is one texel step)
//   2  composite: scene + bloom * strength, plus dither
//
// The scene is already tonemapped and gamma-encoded by the nebula shaders, so
// bloom is added in display space. That is a deliberate trade: it avoids an
// HDR intermediate and keeps the pipeline to two extra passes.
// ---------------------------------------------------------------------------

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uSceneTexel;
uniform vec2 uDirection;
uniform float uThreshold;
uniform float uStrength;
uniform int uPass;

in vec2 vUv;
out vec4 fragColor;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 brightSample(vec2 uv) {
  vec3 color = texture(uScene, uv).rgb;
  float l = luminance(color);
  float knee = max(0.0001, uThreshold * 0.5);
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float weight = max(soft, l - uThreshold) / max(l, 0.0001);
  return color * weight;
}

vec3 blurSample(vec2 uv) {
  // Nine-tap gaussian: two taps per weight on both sides of centre.
  const float w0 = 0.2270270270;
  const float w1 = 0.1945945946;
  const float w2 = 0.1216216216;
  const float w3 = 0.0540540541;
  const float w4 = 0.0162162162;

  vec3 sum = texture(uBloom, uv).rgb * w0;
  sum += texture(uBloom, uv + uDirection * 1.0).rgb * w1;
  sum += texture(uBloom, uv - uDirection * 1.0).rgb * w1;
  sum += texture(uBloom, uv + uDirection * 2.0).rgb * w2;
  sum += texture(uBloom, uv - uDirection * 2.0).rgb * w2;
  sum += texture(uBloom, uv + uDirection * 3.0).rgb * w3;
  sum += texture(uBloom, uv - uDirection * 3.0).rgb * w3;
  sum += texture(uBloom, uv + uDirection * 4.0).rgb * w4;
  sum += texture(uBloom, uv - uDirection * 4.0).rgb * w4;
  return sum;
}

void main() {
  if (uPass == 0) {
    // Four scene taps averaged into one bloom texel doubles as the downsample.
    vec3 a = brightSample(vUv + uSceneTexel * vec2(-1.0, -1.0));
    vec3 b = brightSample(vUv + uSceneTexel * vec2(1.0, -1.0));
    vec3 c = brightSample(vUv + uSceneTexel * vec2(-1.0, 1.0));
    vec3 d = brightSample(vUv + uSceneTexel * vec2(1.0, 1.0));
    fragColor = vec4((a + b + c + d) * 0.25, 1.0);
    return;
  }

  if (uPass == 1) {
    fragColor = vec4(blurSample(vUv), 1.0);
    return;
  }

  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 color = scene + bloom * uStrength;

  // Dither again after the bloom add so dark gradients stay smooth.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  color += (n - 0.5) / 255.0;

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
