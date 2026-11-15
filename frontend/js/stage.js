// The stage: one canvas behind the page.
//
// Everything is drawn by a single WebGL context: the field first, then
// each head into the rectangle its placeholder element occupies in the
// page layout, then film grain over all of it. The DOM decides where
// things are; the canvas only paints.

import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { KTX2Loader } from '../vendor/KTX2Loader.js';
import { MeshoptDecoder } from '../vendor/meshopt_decoder.module.js';
import { Field } from './field.js';
import { Performer } from './performer.js';
import { approach } from './noise.js';

const MODEL_URL = new URL('../assets/facecap.glb', import.meta.url).href;
const TRANSCODER_URL = new URL('../vendor/', import.meta.url).href;

// The head is drawn into a rectangle larger than its placeholder so it
// can turn and nod without being cut off at the edge.
const BLEED = 1.5;
const FOV = 21;
// Fraction of the placeholder's height the head occupies.
const FILL = 0.9;

// Each face has a soft key of its own, a glow from its own smoke behind
// it, and a "spill" on the cheek that faces the other head, in the
// other's colour: the two light each other across the gap.
const WARM = 0xff8f33;
const COOL = 0x4a7dff;
const LIGHTS = {
  HappyAvatar: {
    key:   { color: 0xffe9d2, intensity: 2.3, at: [-0.8, 1.0, 1.7] },
    fill:  { color: 0x8f96c8, intensity: 0.3, at: [1.1, -0.6, 1.2] },
    own:   { color: WARM, intensity: 3.4, at: [-1.3, 0.5, -2.2] },
    spill: { color: COOL, intensity: 2.6, at: [1.5, 0.15, -1.5] },
    tint: 0xfff1e4, sky: 0x54433c, ground: 0x0b0806, ambient: 0.75
  },
  SadAvatar: {
    key:   { color: 0xd3def7, intensity: 1.9, at: [0.8, 1.2, 1.6] },
    fill:  { color: 0x6c5f78, intensity: 0.24, at: [-1.1, -0.6, 1.2] },
    own:   { color: COOL, intensity: 3.6, at: [1.3, 0.5, -2.2] },
    spill: { color: WARM, intensity: 2.6, at: [-1.5, 0.15, -1.5] },
    tint: 0xeef2ff, sky: 0x333c52, ground: 0x06070b, ambient: 0.75
  }
};

// The scan is a head with no body. Rather than show the cut, the head
// fades into the field below the jaw and behind the ears. Only front
// faces are drawn and depth is still written, so a single convex-ish
// head blends correctly without any sorting.
function dissolve(material, fade) {
  material.side = THREE.FrontSide;
  material.transparent = true;
  material.depthWrite = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeY = fade.y;
    shader.uniforms.uFadeZ = fade.z;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vStagePos;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvStagePos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vStagePos;
        uniform vec2 uFadeY;
        uniform vec2 uFadeZ;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float stageFade = smoothstep(uFadeY.x, uFadeY.y, vStagePos.y)
                        * smoothstep(uFadeZ.x, uFadeZ.y, vStagePos.z);
        if (stageFade < 0.004) discard;
        gl_FragColor.a *= stageFade;`);
  };
  material.customProgramCacheKey = () => 'joyai-dissolve';
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance'
    });
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.field = new Field(this.renderer);
    this.faces = [];
    this.byId = {};
    this.time = 0;
    this.calm = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Resolution is given up before smoothness: if frames run long for
    // a few seconds the canvas is rendered smaller and scaled up.
    this.quality = 1;
    this.frameMs = 16;
    this.slowFor = 0;
    this.lastFrameAt = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth; const h = window.innerHeight;
    this.width = w; this.height = h;
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * this.quality;
    this.renderer.setPixelRatio(Math.max(0.5, ratio));
    this.renderer.setSize(w, h, false);
    this.field.resize(w, h, this.quality);
  }

  // Watch the real frame time and step the resolution down when the
  // machine cannot keep up. It never steps back up: a display that
  // struggled once will struggle again, and hunting looks worse than
  // softness.
  _pace() {
    const now = performance.now();
    const ms = now - this.lastFrameAt;
    this.lastFrameAt = now;
    // Long gaps are a hidden tab or a stall, not a slow GPU.
    if (ms > 1000 || document.hidden) { this.slowFor = 0; return; }
    this.frameMs += (ms - this.frameMs) * 0.06;
    this.slowFor = this.frameMs > 28 ? this.slowFor + ms : 0;
    if (this.slowFor > 2500 && this.quality > 0.3) {
      this.quality *= 0.72;
      this.slowFor = 0;
      this.frameMs = 16;
      this.resize();
    }
  }

  // Load the scan once and stand up a head for each placeholder.
  async cast(placeholders) {
    const ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER_URL).detectSupport(this.renderer);
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(MODEL_URL);
    ktx2.dispose();

    const source = gltf.scene;
    source.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(source, true);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.headHeight = size.y;

    const fade = {
      y: { value: new THREE.Vector2(box.min.y + size.y * 0.02, box.min.y + size.y * 0.24) },
      z: { value: new THREE.Vector2(box.min.z + size.z * 0.1, box.min.z + size.z * 0.5) }
    };

    const ids = Object.keys(placeholders);
    ids.forEach((id, index) => {
      const scene = new THREE.Scene();
      const root = source.clone(true);
      // The scan ships one fully matte material. Skin wants a little
      // sheen, and eyes are dead without a catchlight.
      const rig = LIGHTS[id];
      const skin = source.getObjectByProperty('isMesh', true).material.clone();
      skin.roughness = 0.6;
      skin.color.set(rig.tint);
      const eye = skin.clone();
      eye.roughness = 0.06;
      eye.color.set(0xffffff);
      const teeth = skin.clone();
      teeth.roughness = 0.35;
      for (const material of [skin, eye, teeth]) dissolve(material, fade);
      root.traverse((node) => {
        if (!node.isMesh) return;
        const part = (node.parent && node.parent.name) || '';
        node.material = /eye/i.test(part) ? eye : /teeth/i.test(part) ? teeth : skin;
        node.frustumCulled = false;   // morphs move it; the cull box doesn't know
      });

      // Turn about the top of the neck, not the middle of the skull.
      const pivot = new THREE.Group();
      const neck = new THREE.Vector3(center.x, center.y - size.y * 0.3, center.z - size.z * 0.12);
      pivot.position.copy(neck);
      root.position.sub(neck);
      pivot.add(root);
      pivot.userData.restY = neck.y;
      pivot.userData.unit = size.y;
      scene.add(pivot);

      const lamps = {};
      for (const name of ['key', 'fill', 'own', 'spill']) {
        const spec = rig[name];
        const lamp = new THREE.DirectionalLight(spec.color, spec.intensity);
        lamp.position.set(spec.at[0], spec.at[1], spec.at[2]).add(center);
        lamp.target.position.copy(center);
        scene.add(lamp, lamp.target);
        lamps[name] = { lamp, base: spec.intensity };
      }
      scene.add(new THREE.HemisphereLight(rig.sky, rig.ground, rig.ambient));

      const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
      const visible = (size.y * BLEED) / FILL;
      const distance = visible / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
      const eyeLine = center.y + size.y * 0.02;
      camera.position.set(center.x, eyeLine, center.z + distance);
      camera.lookAt(center.x, eyeLine, center.z);

      // Joy stands to the left, so Sorrow is to its screen-right.
      const performer = new Performer(id, pivot, index === 0 ? 1 : -1);
      const face = {
        id, scene, camera, performer, lamps,
        element: placeholders[id],
        energy: 0.2, leakAge: 99, leakStrength: 0, phase: index * 40
      };
      this.faces.push(face);
      this.byId[id] = face;
    });
    return this.byId;
  }

  // A slip: tell the field.
  pulse(id, strength) {
    const face = this.byId[id];
    if (!face) return;
    face.leakAge = 0;
    face.leakStrength = strength;
  }

  frame(dt) {
    this._pace();
    this.time += dt;
    const r = this.renderer;
    const u = this.field.uniforms;
    const W = this.width; const H = this.height;

    this.faces.forEach((face, i) => {
      const p = face.performer;
      p.update(dt);

      const speaking = p.role === 'speaking';
      face.energy = approach(face.energy, speaking ? 1 : p.role === 'listening' ? 0.3 : 0.24,
        dt, speaking ? 0.9 : 2.2);
      face.leakAge += dt;
      // Joy's smoke hurries; Sorrow's barely moves. Both quicken a
      // little when their face has the floor.
      const pace = (i === 0 ? 0.075 : 0.034) * (0.55 + 0.9 * face.energy) *
        (this.calm ? 0.25 : 1);
      face.phase += dt * pace;

      const rect = face.element.getBoundingClientRect();
      face.rect = rect;
      const cx = (rect.left + rect.width / 2) / W;
      const cy = 1 - (rect.top + rect.height / 2) / H;
      (i === 0 ? u.uJoy : u.uSorrow).value.set(cx, cy);
      if (i === 0) {
        u.uRadius.value = (rect.height * 0.5) / H;
        u.uPhase.value.x = face.phase; u.uEnergy.value.x = face.energy;
        u.uVoice.value.x = p.voice * 2;
        u.uLeak.value.x = face.leakAge; u.uLeak.value.y = face.leakStrength;
      } else {
        u.uPhase.value.y = face.phase; u.uEnergy.value.y = face.energy;
        u.uVoice.value.y = p.voice * 2;
        u.uLeak.value.z = face.leakAge; u.uLeak.value.w = face.leakStrength;
      }

      // The lamps lean in while a face performs, and gutter on a slip.
      const gutter = 1 - 0.4 * face.leakStrength * Math.exp(-face.leakAge * 5);
      const lamps = face.lamps;
      lamps.key.lamp.intensity = lamps.key.base * (0.7 + 0.3 * face.energy) * gutter;
      lamps.own.lamp.intensity = lamps.own.base *
        (0.35 + 0.65 * face.energy + 0.5 * p.voice) * gutter;
    });

    // What the other face is giving off lands on this one's near cheek.
    this.faces.forEach((face, i) => {
      const them = this.faces[1 - i];
      if (!them) return;
      face.lamps.spill.lamp.intensity = face.lamps.spill.base *
        (0.12 + 0.88 * them.energy + 0.5 * them.performer.voice);
    });

    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    r.clear();
    this.field.renderBackground();

    r.setScissorTest(true);
    for (const face of this.faces) {
      const rect = face.rect;
      if (!rect || rect.width < 2) continue;
      const side = rect.height * BLEED;
      const x = rect.left + rect.width / 2 - side / 2;
      const y = H - (rect.top + rect.height / 2) - side / 2;
      r.setViewport(x, y, side, side);
      r.setScissor(x, y, side, side);
      r.clearDepth();
      r.render(face.scene, face.camera);
    }

    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    this.field.renderFilm(this.time);
  }
}
