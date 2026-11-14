// One face, performed.
//
// A Performer owns a head and composes its expression every frame from
// independent layers, the way a face actually works:
//
//   mask     the performed affect (smile / grief), held and breathing
//   leak     a micro-expression: the concealed emotion breaking the mask
//   mouth    visemes for the words being spoken
//   lids     blinks, and lids that follow the eyes
//   gaze     saccades between the viewer, the other face, and elsewhere
//   head     posture, drift, nods on words, recoil on a leak
//
// Layers never write to the rig directly; they write into a scratch
// array that is clamped and applied once at the end of update().

import * as THREE from 'three';
import { MASKS, LEAKS, REPERTOIRE, REST } from './affect.js';
import { approach, clamp01, drift, lerp, pick, rand, smooth } from './noise.js';

// How each face carries itself. Joy is quick and buoyant; Sorrow is
// slow, bowed, and looks at the floor.
const TEMPERAMENT = {
  HappyAvatar: {
    restLevel: 0.36, listenLevel: 0.5, performLevel: 0.86,
    articulation: 1.12, headPitch: 0.035, headTempo: 0.55, headAmp: 0.032,
    nod: 1.0, blinkEvery: [2.2, 5.2], blinkSpeed: 1.0,
    gaze: {
      speaking:  { viewer: 6.5, other: 1.4, down: 0.5, away: 1.2 },
      listening: { viewer: 3, other: 5.5, down: 0.6, away: 0.9 },
      idle:      { viewer: 4.5, other: 2.2, down: 1, away: 2 }
    },
    fixation: [0.5, 2.4]
  },
  SadAvatar: {
    restLevel: 0.4, listenLevel: 0.52, performLevel: 0.84,
    articulation: 0.78, headPitch: -0.075, headTempo: 0.26, headAmp: 0.024,
    nod: 0.45, blinkEvery: [3.2, 7.5], blinkSpeed: 0.62,
    gaze: {
      speaking:  { viewer: 4, other: 1, down: 4, away: 1 },
      listening: { viewer: 2, other: 4.5, down: 3, away: 0.6 },
      idle:      { viewer: 3, other: 1.6, down: 4, away: 1.2 }
    },
    fixation: [0.9, 3.6]
  }
};

const EYE_YAW_MAX = 0.42;
const EYE_PITCH_MAX = 0.28;

export class Performer {
  // `towardOther` is +1 if the other face is to this one's screen-right,
  // -1 if it is to the left.
  constructor(id, pivot, towardOther) {
    this.id = id;
    this.pivot = pivot;
    this.towardOther = towardOther;
    this.temper = TEMPERAMENT[id];
    this.mask = MASKS[id];
    this.rest = REST[id];
    this.seed = id === 'HappyAvatar' ? 1.7 : 8.3;

    // Rig discovery: the mesh that carries the blendshapes, and the two
    // eyeballs, which are separate nodes we turn by hand.
    this.mesh = null;
    pivot.traverse((node) => {
      if (!node.isMesh || !node.morphTargetDictionary) return;
      if (!this.mesh || 'jawOpen' in node.morphTargetDictionary) this.mesh = node;
    });
    this.dict = this.mesh ? this.mesh.morphTargetDictionary : {};
    this.influences = this.mesh ? this.mesh.morphTargetInfluences : [];
    this.scratch = new Float32Array(this.influences.length);
    this.eyes = ['eyeLeft', 'eyeRight']
      .map((name) => pivot.getObjectByName(name))
      .filter(Boolean)
      .map((node) => ({ node, base: node.quaternion.clone() }));

    this.role = 'idle';
    this.intensity = 0.6;      // sentiment strength of the current reading
    this.level = this.temper.restLevel;
    this.rebound = 0;          // over-performing right after a slip
    this.voice = 0;            // smoothed mouth openness, for the stage

    this.mouthA = null; this.mouthB = null; this.mouthMix = 0;
    this.mouthGain = 0; this.mouthGainTarget = 0;

    this.leakNow = null;
    this.lastLeakEnd = -1e9;
    this.leakStretch = 1;      // > 1 slows slips down for study
    this.onLeak = null;

    this.gaze = { x: 0, y: 0, fromX: 0, fromY: 0, toX: 0, toY: 0,
                  t0: 0, dur: 0.05, next: 0, headX: 0, headY: 0 };
    this.blink = { at: rand(1, 3), t0: -1, again: false, value: 0 };
    this.nod = { pos: 0, vel: 0 };
    this.recoil = { pitch: 0, roll: 0 };
    this.clock = 0;

    this._euler = new THREE.Euler();
    this._quat = new THREE.Quaternion();
    this.baseYaw = towardOther * 0.085;
  }

  // --- Direction from the dramaturgy ------------------------------------

  setRole(role, intensity) {
    this.role = role;
    if (typeof intensity === 'number') this.intensity = clamp01(intensity);
    if (role !== 'speaking') this.mouthGainTarget = 0;
    this.gaze.next = Math.min(this.gaze.next, this.clock + rand(0.1, 0.5));
  }

  // The speech driver hands over two mouth shapes and how far between
  // them we are. Passing null closes the mouth.
  setMouth(a, b, mix) {
    this.mouthA = a; this.mouthB = b; this.mouthMix = mix;
    this.mouthGainTarget = a || b ? 1 : 0;
  }

  // A word begins: mark it with the head, as people do.
  stress(amount) {
    this.nod.vel -= (0.22 + 0.2 * amount) * this.temper.nod * rand(0.6, 1.2);
  }

  // Let an emotion slip. Returns false while the face is still
  // recovering from the previous one.
  leak(kind, strength) {
    const spec = LEAKS[kind];
    if (!spec || this.leakNow) return false;
    if (this.clock - this.lastLeakEnd < 1.3) return false;
    const k = this.leakStretch;
    const onset = rand(0.055, 0.085) * k;
    const hold = rand(0.05, 0.16) * k;
    const offset = rand(0.14, 0.23) * k;
    this.leakNow = {
      kind, spec, onset, hold, offset,
      strength: clamp01(strength === undefined ? 0.85 : strength),
      t0: this.clock, env: 0
    };
    if (this.onLeak) this.onLeak(kind, (onset + hold + offset) * 1000);
    return true;
  }

  // Pick something this face is plausibly hiding and let it out.
  leakSpontaneously() {
    const kind = pick(REPERTOIRE[this.id]);
    return this.leak(kind, (0.62 + 0.38 * this.intensity) * rand(0.82, 1));
  }

  canLeak(kind) { return kind in REPERTOIRE[this.id]; }

  // --- Per-frame composition --------------------------------------------

  update(dt) {
    this.clock += dt;
    const t = this.clock;
    const w = this.scratch;
    w.fill(0);

    this._updateLeak(t, dt);
    this._updateMask(t, dt, w);
    this._updateMouth(dt, w);
    this._updateGaze(t, dt, w);
    this._updateBlink(t, w);
    this._updateHead(t, dt);

    for (let i = 0; i < w.length; i++) this.influences[i] = clamp01(w[i]);
  }

  _add(w, shape, gain) {
    for (const name in shape) {
      const i = this.dict[name];
      if (i !== undefined) w[i] += shape[name] * gain;
    }
  }

  _updateLeak(t, dt) {
    const leak = this.leakNow;
    if (leak) {
      const age = t - leak.t0;
      if (age < leak.onset) {
        leak.env = smooth(age / leak.onset);
      } else if (age < leak.onset + leak.hold) {
        leak.env = 1;
      } else if (age < leak.onset + leak.hold + leak.offset) {
        leak.env = 1 - smooth((age - leak.onset - leak.hold) / leak.offset);
      } else {
        // The mask closes back over it, a little too hard, and the eyes
        // tend to flinch: a blink, a glance away.
        this.leakNow = null;
        this.lastLeakEnd = t;
        this.rebound = 0.16;
        if (Math.random() < 0.65) this.blink.at = Math.min(this.blink.at, t + rand(0.08, 0.3));
        if (Math.random() < 0.5) this._lookAt(Math.random() < 0.6 ? 'down' : 'away', rand(0.45, 0.9));
      }
    }
    this.rebound = approach(this.rebound, 0, dt, 0.7);

    // Unprompted slips while performing. The stronger the feeling being
    // read against, the harder it is to hold the mask.
    if (this.role === 'speaking' && !this.leakNow) {
      const rate = 0.07 + 0.13 * this.intensity;
      if (Math.random() < rate * dt) this.leakSpontaneously();
    }
  }

  _updateMask(t, dt, w) {
    const temper = this.temper;
    const target = this.role === 'speaking'
      ? temper.performLevel + 0.26 * this.intensity
      : this.role === 'listening' ? temper.listenLevel : temper.restLevel;
    // The mask goes on quickly and wears off slowly.
    this.level = approach(this.level, target, dt, target > this.level ? 0.35 : 1.4);

    const leak = this.leakNow;
    const env = leak ? leak.env : 0;
    // A held expression is never still.
    const breath = 1 + 0.07 * drift(t * 0.31, this.seed);
    const maskGain = (this.level + this.rebound) * breath * (1 - 0.88 * env);
    // A slip opens the whole face, resting habits included.
    this._add(w, this.rest, 1 - 0.7 * env);
    this._add(w, this.mask, maskGain);
    if (leak) this._add(w, leak.spec.shape, env * leak.strength);

    // Small independent life in the brows and mouth corners.
    const j = (name, amp, seed) => {
      const i = this.dict[name];
      if (i !== undefined) w[i] += amp * drift(t * 0.43, this.seed + seed);
    };
    j('browInnerUp', 0.045, 1); j('browOuterUp_L', 0.03, 2); j('browOuterUp_R', 0.03, 3);
    j('mouthSmile_L', 0.025, 4); j('mouthSmile_R', 0.025, 5);
    j('mouthPress_L', 0.03, 6); j('mouthPress_R', 0.03, 7);
    j('eyeSquint_L', 0.03, 8); j('eyeSquint_R', 0.03, 9);
  }

  _updateMouth(dt, w) {
    this.mouthGain = approach(this.mouthGain, this.mouthGainTarget, dt, 0.06);
    const gain = this.mouthGain * this.temper.articulation *
      (0.85 + 0.25 * this.intensity);
    let open = 0;
    if (gain > 0.001) {
      const mix = smooth(this.mouthMix);
      if (this.mouthA) this._add(w, this.mouthA, gain * (1 - mix));
      if (this.mouthB) this._add(w, this.mouthB, gain * mix);
      const jaw = this.dict.jawOpen;
      if (jaw !== undefined) open = w[jaw];
    }
    this.voice = approach(this.voice, open, dt, 0.09);
  }

  _lookAt(where, holdFor) {
    const g = this.gaze;
    let x = 0; let y = 0;
    if (where === 'viewer') {
      x = rand(-0.035, 0.035); y = rand(-0.02, 0.03);
    } else if (where === 'other') {
      x = this.towardOther * rand(0.3, 0.4); y = rand(-0.03, 0.03);
    } else if (where === 'down') {
      x = rand(-0.12, 0.12); y = -rand(0.16, 0.26);
    } else {
      x = -this.towardOther * rand(0.16, 0.3); y = rand(-0.08, 0.1);
    }
    g.fromX = g.x; g.fromY = g.y; g.toX = x; g.toY = y;
    g.t0 = this.clock;
    // Saccades are fast, and bigger ones take a little longer.
    const travel = Math.hypot(x - g.x, y - g.y);
    g.dur = 0.03 + travel * 0.09;
    const fix = this.temper.fixation;
    g.next = this.clock + (holdFor || rand(fix[0], fix[1]));
  }

  _updateGaze(t, dt, w) {
    const g = this.gaze;
    if (t >= g.next && !this.leakNow) {
      this._lookAt(pick(this.temper.gaze[this.role] || this.temper.gaze.idle));
    }
    const p = smooth((t - g.t0) / g.dur);
    g.x = lerp(g.fromX, g.toX, p);
    g.y = lerp(g.fromY, g.toY, p);
    // The head trails the eyes, slowly, and takes part of the turn.
    g.headX = approach(g.headX, g.x, dt, 0.55);
    g.headY = approach(g.headY, g.y, dt, 0.7);

    // Eyeballs: what is left of the gaze after the head's share, plus
    // fixational tremor.
    const ex = THREE.MathUtils.clamp(
      g.x - g.headX * 0.35 + 0.006 * drift(t * 3.1, this.seed + 20),
      -EYE_YAW_MAX, EYE_YAW_MAX);
    const ey = THREE.MathUtils.clamp(
      g.y - g.headY * 0.3 + 0.005 * drift(t * 2.7, this.seed + 21),
      -EYE_PITCH_MAX, EYE_PITCH_MAX);
    // The rig is Z-up inside: local X pitches the eye, local Z yaws it.
    this._euler.set(-ey, 0, ex, 'XYZ');
    this._quat.setFromEuler(this._euler);
    for (const eye of this.eyes) {
      eye.node.quaternion.copy(eye.base).multiply(this._quat);
    }

    // Lids and the skin around the eye follow the eyeball.
    const set = (name, v) => {
      const i = this.dict[name];
      if (i !== undefined) w[i] += clamp01(v);
    };
    const up = ey / EYE_PITCH_MAX; const side = ex / EYE_YAW_MAX;
    set('eyeLookUp_L', up * 0.7); set('eyeLookUp_R', up * 0.7);
    set('eyeLookDown_L', -up * 0.85); set('eyeLookDown_R', -up * 0.85);
    // Looking toward screen-right turns the screen-left eye inward.
    set('eyeLookIn_R', side * 0.6); set('eyeLookOut_L', side * 0.6);
    set('eyeLookIn_L', -side * 0.6); set('eyeLookOut_R', -side * 0.6);
  }

  _updateBlink(t, w) {
    const b = this.blink;
    const speed = this.temper.blinkSpeed;
    const close = 0.065 / speed; const shut = 0.03 / speed; const open = 0.15 / speed;
    if (b.t0 < 0 && t >= b.at) { b.t0 = t; b.again = Math.random() < 0.14; }
    if (b.t0 >= 0) {
      const age = t - b.t0;
      if (age < close) b.value = smooth(age / close);
      else if (age < close + shut) b.value = 1;
      else if (age < close + shut + open) b.value = 1 - smooth((age - close - shut) / open);
      else {
        b.value = 0; b.t0 = -1;
        const every = this.temper.blinkEvery;
        b.at = t + (b.again ? rand(0.12, 0.25) : rand(every[0], every[1]));
      }
    }
    if (b.value > 0) {
      for (const name of ['eyeBlink_L', 'eyeBlink_R']) {
        const i = this.dict[name];
        if (i !== undefined) w[i] = Math.max(w[i], b.value);
      }
    }
  }

  _updateHead(t, dt) {
    const temper = this.temper;
    const speaking = this.role === 'speaking';
    const tempo = temper.headTempo * (speaking ? 1.5 : 1);
    const amp = temper.headAmp * (speaking ? 1.45 : 1);

    // Nods are a damped spring kicked by each word.
    const n = this.nod;
    n.vel += (-n.pos * 95 - n.vel * 13) * dt;
    n.pos += n.vel * dt;

    const leak = this.leakNow;
    const env = leak ? leak.env : 0;
    const head = leak ? leak.spec.head || {} : {};
    this.recoil.pitch = approach(this.recoil.pitch, (head.pitch || 0) * env, dt, 0.05);
    this.recoil.roll = approach(this.recoil.roll, (head.roll || 0) * env, dt, 0.05);

    const g = this.gaze;
    const yaw = this.baseYaw + g.headX * 0.35 +
      amp * drift(t * tempo, this.seed + 30);
    const pitchUp = temper.headPitch + g.headY * 0.3 +
      amp * 0.7 * drift(t * tempo * 0.83, this.seed + 31) +
      n.pos * 0.05 + this.recoil.pitch +
      (speaking ? 0.012 * this.intensity : 0);
    const roll = amp * 0.6 * drift(t * tempo * 0.61, this.seed + 32) +
      this.recoil.roll - this.towardOther * 0.012;

    this.pivot.rotation.set(-pitchUp, yaw, roll, 'YXZ');
    // Breathing.
    const breathRate = this.id === 'HappyAvatar' ? 1.45 : 0.95;
    this.pivot.position.y = this.pivot.userData.restY +
      this.pivot.userData.unit * 0.006 * Math.sin(t * breathRate + this.seed);
  }
}
