// CRT-flavored ShaderMaterial for the TV plane. Slight barrel curvature,
// scanlines, a soft aperture grille, and a corner vignette. Tuned to feel
// like an old consumer trinitron from across a small room, not so heavy
// that pixel art becomes illegible.

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform float uCurvature;
uniform float uScanlineCount;
uniform float uScanlineIntensity;
uniform float uVignette;
uniform float uMaskIntensity;
uniform float uMaskCount;
varying vec2 vUv;

vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 offset = abs(uv.yx) / vec2(5.0, 4.0) * uCurvature;
  uv = uv + uv * offset * offset;
  uv = uv * 0.5 + 0.5;
  return uv;
}

void main() {
  vec2 uv = curve(vUv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec3 col = texture2D(tDiffuse, uv).rgb;

  // Horizontal scanlines, intensity controllable.
  float scan = sin(uv.y * uScanlineCount * 3.14159) * 0.5 + 0.5;
  col *= mix(1.0, scan, uScanlineIntensity);

  // Aperture grille (RGB phosphor cells) — tinted slightly per column so
  // the screen has a faint trinitron shimmer at close range.
  float cell = mod(uv.x * uMaskCount, 3.0);
  vec3 mask = vec3(1.0);
  if (cell < 1.0) mask = vec3(1.15, 0.92, 0.92);
  else if (cell < 2.0) mask = vec3(0.92, 1.15, 0.92);
  else mask = vec3(0.92, 0.92, 1.15);
  col *= mix(vec3(1.0), mask, uMaskIntensity);

  // Vignette — corners darker than center.
  vec2 vc = (vUv - 0.5) * 2.0;
  float vig = 1.0 - dot(vc, vc) * uVignette;
  col *= clamp(vig, 0.0, 1.0);

  // Very mild bloom-ish brightening on near-white to fake CRT phosphor
  // glow at hotspots. Cheap one-tap.
  float bright = max(max(col.r, col.g), col.b);
  col += pow(bright, 6.0) * 0.15;

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createCrtMaterial(screenTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: screenTexture },
      uCurvature: { value: 0.18 },
      uScanlineCount: { value: 240.0 },
      uScanlineIntensity: { value: 0.22 },
      uVignette: { value: 0.35 },
      uMaskIntensity: { value: 0.15 },
      uMaskCount: { value: 600.0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    toneMapped: false,
  });
}
