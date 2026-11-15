// The field: the space the two faces share.
//
// Two bodies of smoke, one behind each face. Joy's is warm and rises;
// Sorrow's is cold and sinks. Each swells while its face is speaking
// and breathes with the voice. When a face lets something slip, its
// own light gutters for an instant and a ring of the *other*
// temperature escapes outward: the background briefly tells the truth
// that the face is hiding.
//
// Rendered at low resolution (it is all low-frequency) and upscaled;
// grain and vignette go on afterwards, over the faces too, so the whole
// image sits in one piece of film.

import * as THREE from 'three';

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FIELD_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uAspect;
  uniform float uRadius;      // face radius, in screen heights
  uniform vec2 uJoy;          // face centres, uv
  uniform vec2 uSorrow;
  uniform vec2 uPhase;        // accumulated flow (joy, sorrow)
  uniform vec2 uEnergy;       // how present each face is, 0..1
  uniform vec2 uVoice;        // mouth openness, 0..1
  uniform vec4 uLeak;         // joy age, joy strength, sorrow age, sorrow strength
  uniform float uFloor;       // darkening toward the captions

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = m * p; a *= 0.5; }
    return s;
  }
  // Domain-warped smoke, drifting along dir.
  float smoke(vec2 p, float phase, vec2 dir) {
    vec2 a = p + dir * phase;
    vec2 q = vec2(fbm(a + vec2(0.0, phase * 0.31)),
                  fbm(a + vec2(5.2, 1.3) - vec2(phase * 0.23, 0.0)));
    return fbm(a + 2.3 * q);
  }

  // One escaping ring. d is distance from the face in face radii.
  float ring(float d, float age, float strength) {
    float front = 0.8 + age * 2.4;
    float band = exp(-pow((d - front) * 3.6, 2.0));
    return band * exp(-age * 2.1) * strength;
  }

  void main() {
    vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
    vec2 pj = vec2((uJoy.x - 0.5) * uAspect, uJoy.y - 0.5);
    vec2 ps = vec2((uSorrow.x - 0.5) * uAspect, uSorrow.y - 0.5);

    float fj = smoke(p * 2.3, uPhase.x, vec2(0.0, -1.0));
    float fs = smoke(p * 1.9 + 7.31, uPhase.y, vec2(0.12, 1.0));

    // Smoke bends the distance, so the halos have torn edges.
    float dj = length(p - pj + 0.07 * (fj - 0.5)) / uRadius;
    float ds = length(p - ps + 0.07 * (fs - 0.5)) / uRadius;

    float haloJ = exp(-pow(dj * 0.52, 2.0));
    float haloS = exp(-pow(ds * 0.5, 2.0));

    // The slip: the face's own light gutters.
    float gutterJ = 1.0 - 0.7 * uLeak.y * exp(-uLeak.x * 4.0);
    float gutterS = 1.0 - 0.7 * uLeak.w * exp(-uLeak.z * 4.0);

    float warm = haloJ * (0.2 + 0.8 * uEnergy.x) * (0.25 + 1.5 * pow(fj, 1.6))
               * (1.0 + 0.55 * uVoice.x) * gutterJ;
    float cool = haloS * (0.2 + 0.8 * uEnergy.y) * (0.25 + 1.5 * pow(fs, 1.6))
               * (1.0 + 0.55 * uVoice.y) * gutterS;

    vec3 warmCol = mix(vec3(0.50, 0.11, 0.03), vec3(1.0, 0.62, 0.24), smoothstep(0.25, 0.85, fj));
    vec3 coolCol = mix(vec3(0.04, 0.09, 0.36), vec3(0.46, 0.68, 1.0), smoothstep(0.25, 0.85, fs));

    vec3 col = vec3(0.020, 0.019, 0.034);
    col += vec3(0.022, 0.018, 0.040) * (fj + fs);        // the room itself
    col += warmCol * warm * 0.60;
    col += coolCol * cool * 0.66;

    // ...and what it was hiding gets out, in the other temperature.
    float ringJ = ring(dj, uLeak.x, uLeak.y) * (0.35 + 1.3 * fj);
    float ringS = ring(ds, uLeak.z, uLeak.w) * (0.35 + 1.3 * fs);
    col += vec3(0.42, 0.62, 1.0) * ringJ * 0.5;
    col += vec3(1.0, 0.50, 0.20) * ringS * 0.5;

    // Keep the lower half quiet enough to read by.
    col *= mix(uFloor, 1.0, smoothstep(0.05, 0.62, vUv.y));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const BLIT_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uMap;
  void main() {
    gl_FragColor = vec4(texture2D(uMap, vUv).rgb, 1.0);
  }
`;

// Multiplicative grain and vignette. Blended as 2 * src * dst, so a
// mid-grey source leaves the image untouched.
const FILM_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uAspect;
  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  void main() {
    float t = floor(uTime * 24.0);
    float n = hash(gl_FragCoord.xy + t * 17.13) - 0.5;
    vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
    float vig = 1.0 - 0.42 * smoothstep(0.25, 1.15, length(p));
    gl_FragColor = vec4(vec3((0.5 + n * 0.085) * vig), 1.0);
  }
`;

function fullscreen(material) {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return scene;
}

export class Field {
  constructor(renderer) {
    this.renderer = renderer;
    this.camera = new THREE.Camera();
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false
    });

    this.uniforms = {
      uAspect: { value: 1 },
      uRadius: { value: 0.2 },
      uJoy: { value: new THREE.Vector2(0.3, 0.6) },
      uSorrow: { value: new THREE.Vector2(0.7, 0.6) },
      uPhase: { value: new THREE.Vector2(0, 0) },
      uEnergy: { value: new THREE.Vector2(0.2, 0.2) },
      uVoice: { value: new THREE.Vector2(0, 0) },
      uLeak: { value: new THREE.Vector4(99, 0, 99, 0) },
      uFloor: { value: 0.5 }
    };
    const plain = { depthTest: false, depthWrite: false };
    this.fieldScene = fullscreen(new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FIELD_FRAG, uniforms: this.uniforms, ...plain
    }));
    this.blitScene = fullscreen(new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLIT_FRAG,
      uniforms: { uMap: { value: this.target.texture } }, ...plain
    }));
    this.filmUniforms = { uTime: { value: 0 }, uAspect: { value: 1 } };
    this.filmScene = fullscreen(new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FILM_FRAG, uniforms: this.filmUniforms,
      ...plain,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.SrcColorFactor
    }));
  }

  resize(width, height, quality = 1) {
    // Roughly a third of a megapixel is plenty for smoke, and less
    // will do on a machine that is struggling.
    const scale = Math.min(0.5, 640 / Math.max(width, 1)) * Math.max(0.35, quality);
    this.target.setSize(Math.max(2, Math.round(width * scale)),
                        Math.max(2, Math.round(height * scale)));
    this.uniforms.uAspect.value = width / Math.max(height, 1);
    this.filmUniforms.uAspect.value = this.uniforms.uAspect.value;
  }

  renderBackground() {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(this.fieldScene, this.camera);
    r.setRenderTarget(null);
    r.render(this.blitScene, this.camera);
  }

  renderFilm(time) {
    this.filmUniforms.uTime.value = time % 1000;
    this.renderer.render(this.filmScene, this.camera);
  }
}
