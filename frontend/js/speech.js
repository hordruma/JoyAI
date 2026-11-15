// Speech: turning a comment into a timed performance.
//
// A comment can be voiced three ways, tried in this order:
//
//   a recording  made by the backend's voice service, which arrives
//                with the exact time of every word. Played through Web
//                Audio, so the audio clock itself drives the captions
//                and the mouth opens with the real loudness.
//   the browser  Web Speech voices: free and offline, but they tell us
//                very little, at best a "boundary" event as each word
//                starts. The reading is planned in advance and pulled
//                into line whenever a boundary arrives.
//   silence      with sound off, or no voice at all, the plan simply
//                runs on its own clock and the face reads silently.

import { VISEMES, loadedWord, visemesFor } from './affect.js';

const MAX_CHUNK = 190;   // long utterances get cut off by some engines
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const SOFT_BREAK = /[,;:—–]["'”’)\]]*$/;

// Split text into speakable chunks of whole words, each word annotated
// with its mouth shapes, its estimated duration (at rate 1) and any
// emotional load.
export function buildScript(text) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    const letters = token.replace(/[^\p{L}\p{N}]/gu, '').length;
    const keys = visemesFor(token);
    const total = keys.reduce((sum, k) => sum + k.w, 0) || 1;
    let at = 0;
    for (const k of keys) { k.at = at / total; at += k.w; k.end = at / total; }
    words.push({
      text: token,
      index: words.length,
      start: m.index,
      dur: letters ? 0.055 * Math.min(letters, 14) + 0.11 : 0.05,
      pause: SENTENCE_END.test(token) ? 0.42 : SOFT_BREAK.test(token) ? 0.2 : 0,
      keys,
      loaded: loadedWord(token)
    });
  }

  const chunks = [];
  let current = null;
  for (const word of words) {
    if (!current) current = { words: [], start: word.start, length: 0 };
    current.words.push(word);
    current.length = word.start + word.text.length - current.start;
    const sentenceDone = SENTENCE_END.test(word.text) && current.length >= 50;
    const tooLong = current.length >= MAX_CHUNK ||
      (current.length >= MAX_CHUNK * 0.7 && SOFT_BREAK.test(word.text));
    if (sentenceDone || tooLong) { chunks.push(current); current = null; }
  }
  if (current) chunks.push(current);
  for (const chunk of chunks) {
    chunk.text = text.slice(chunk.start, chunk.start + chunk.length);
  }
  return { text, words, chunks };
}

let cachedVoice;
function englishVoice() {
  if (cachedVoice !== undefined) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;   // not loaded yet; ask again later
  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  // Local voices report word boundaries and don't cut out mid-sentence.
  cachedVoice = english.find((v) => v.localService && v.default) ||
    english.find((v) => v.localService) || english[0] || null;
  return cachedVoice;
}
if ('speechSynthesis' in window && speechSynthesis.addEventListener) {
  speechSynthesis.addEventListener('voiceschanged', () => { cachedVoice = undefined; });
}

export const canSpeak = () => 'speechSynthesis' in window &&
  typeof SpeechSynthesisUtterance !== 'undefined';

// --- Recordings ------------------------------------------------------------

let audio = null;

// Browsers only start audio from a gesture; call this from one.
export function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!audio && Ctx) {
    try { audio = new Ctx(); } catch (e) { audio = null; }
  }
  if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}

// Loudness over time, 50 values a second, scaled so ordinary speech
// sits near 1. This is what opens and closes the mouth.
function envelopeOf(buffer) {
  const data = buffer.getChannelData(0);
  const hop = Math.max(1, Math.round(buffer.sampleRate / 50));
  const out = new Float32Array(Math.ceil(data.length / hop));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    const end = Math.min(data.length, (i + 1) * hop);
    for (let j = i * hop; j < end; j++) sum += data[j] * data[j];
    out[i] = Math.sqrt(sum / hop);
  }
  const sorted = Float32Array.from(out).sort();
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1e-6;
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i] / loud);
  return out;
}

const clips = new Map();   // url -> Promise<{ buffer, envelope }>

// Fetch and decode a recording. Safe to call early, to have it ready.
export function loadClip(url) {
  if (!audio) return Promise.reject(new Error('audio is locked'));
  if (!clips.has(url)) {
    const loading = fetch(url)
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.arrayBuffer(); })
      .then((bytes) => audio.decodeAudioData(bytes))
      .then((buffer) => ({ buffer, envelope: envelopeOf(buffer) }));
    loading.catch(() => clips.delete(url));
    clips.set(url, loading);
    if (clips.size > 12) clips.delete(clips.keys().next().value);
  }
  return clips.get(url);
}

// Drives one voice. `update()` must be called every frame; everything
// the face and the caption need comes out through the callbacks.
export class Speaker {
  constructor({ pitch, rate, pan }) {
    this.pitch = pitch;
    this.rate = rate;
    this.pan = pan || 0;     // where a recording sits between the speakers
    // Learned correction between planned and actual speaking time, for
    // voices that never report word boundaries.
    this.tempo = 1;
    this.active = null;
  }

  // callbacks: onWord(word), onMouth(a, b, mix, level), onEnd()
  // voice: { audioUrl, wordTimes } when there is a recording, else null.
  perform(script, audible, voice, callbacks) {
    this.stop();
    const a = { script, audible, callbacks, chunk: -1, plan: null, mode: 'speech' };
    this.active = a;
    const now = performance.now();
    if (audible && voice && voice.audioUrl && audio) {
      a.mode = 'loading';
      a.asked = now;
      loadClip(voice.audioUrl).then(
        (clip) => { if (this.active === a && a.mode === 'loading') this._startClip(a, clip, voice); },
        () => { if (this.active === a && a.mode === 'loading') this._fallBack(a); });
      return;
    }
    this._nextChunk(now);
  }

  stop() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this._hush(a);
  }

  // Cut whatever is sounding, without ending the performance.
  _hush(a) {
    if (a.utterance) {
      a.utterance.onstart = a.utterance.onend = a.utterance.onerror =
        a.utterance.onboundary = null;
      a.utterance = null;
      if (canSpeak()) speechSynthesis.cancel();
    }
    if (a.source) {
      a.source.onended = null;
      try { a.source.stop(); } catch (e) { /* never started */ }
      a.source = null;
    }
  }

  // Sound was turned off mid-reading: drop the voice but keep the
  // performance, which carries on silently from where it is.
  silence() {
    const a = this.active;
    if (!a) return;
    a.audible = false;
    if (a.mode === 'loading') { this._fallBack(a); return; }
    if (a.mode === 'clip' && !a.muted) {
      a.muted = { at: performance.now(), from: audio.currentTime - a.t0 };
    } else if (a.mode === 'speech' && !a.silent) {
      a.silent = true;
      if (a.started === null) a.started = performance.now();
    }
    this._hush(a);
  }

  // No recording after all: let the browser's voice (or silence) read.
  _fallBack(a) {
    a.mode = 'speech';
    this._nextChunk(performance.now());
  }

  _startClip(a, clip, voice) {
    const words = a.script.words;
    const times = voice.wordTimes;
    if (Array.isArray(times) && times.length === words.length) {
      a.plan = words.map((word, i) => ({
        word, t0: times[i][0], dur: Math.max(0.04, times[i][1] - times[i][0])
      }));
    } else {
      // No usable timings: fit the estimate to the recording's length.
      const total = words.reduce((sum, w) => sum + w.dur + w.pause, 0) || 1;
      const scale = Math.max(0.1, clip.buffer.duration - 0.15) / total;
      let t = 0.05;
      a.plan = words.map((word) => {
        const entry = { word, t0: t, dur: word.dur * scale };
        t += (word.dur + word.pause) * scale;
        return entry;
      });
    }
    a.clip = clip;
    a.cursor = -1;
    a.ended = false;
    a.muted = null;

    const source = audio.createBufferSource();
    source.buffer = clip.buffer;
    let out = source;
    if (audio.createStereoPanner) {
      const panner = audio.createStereoPanner();
      panner.pan.value = this.pan;
      out.connect(panner);
      out = panner;
    }
    out.connect(audio.destination);
    source.onended = () => { if (this.active === a) a.ended = true; };
    a.t0 = audio.currentTime + 0.04;
    source.start(a.t0);
    a.source = source;
    a.mode = 'clip';
  }

  _updateClip(a, now) {
    // The audio clock is the truth; after a mute, carry on by the wall
    // clock from where the sound stopped.
    const t = a.muted
      ? a.muted.from + (now - a.muted.at) / 1000
      : audio.currentTime - a.t0;
    const plan = a.plan;
    while (a.cursor + 1 < plan.length && plan[a.cursor + 1].t0 <= t) {
      a.cursor++;
      a.callbacks.onWord(plan[a.cursor].word);
    }
    const length = a.clip.buffer.duration;
    if ((a.ended && !a.muted) || t >= length + 0.3) {
      while (a.cursor + 1 < plan.length) {
        a.cursor++;
        a.callbacks.onWord(plan[a.cursor].word);
      }
      this._hush(a);
      this.active = null;
      a.callbacks.onMouth(null, null, 0);
      a.callbacks.onEnd();
      return;
    }
    const env = a.clip.envelope;
    const level = t < 0 ? 0 : env[Math.min(env.length - 1, Math.floor(t * 50))] || 0;
    this._shape(a, t, level, false);
  }

  _nextChunk(now) {
    const a = this.active;
    a.chunk++;
    if (a.chunk >= a.script.chunks.length) {
      this.active = null;
      a.callbacks.onMouth(null, null, 0);
      a.callbacks.onEnd();
      return;
    }
    const chunk = a.script.chunks[a.chunk];
    const scale = this.tempo / this.rate;
    let t = 0.08;
    a.plan = chunk.words.map((word) => {
      const entry = { word, t0: t, dur: word.dur * scale };
      t += (word.dur + word.pause) * scale;
      return entry;
    });
    a.planned = t;
    a.cursor = -1;
    a.synced = false;
    a.ended = false;
    a.started = null;       // ms timestamp once the voice is really going
    a.asked = now;
    a.utterance = null;

    if (!(a.audible && canSpeak())) { a.started = now; a.silent = true; return; }

    a.silent = false;
    const u = new SpeechSynthesisUtterance(chunk.text);
    const voice = englishVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-US'; }
    u.pitch = this.pitch;
    u.rate = this.rate;
    u.onstart = () => { if (this.active === a) a.started = performance.now(); };
    u.onboundary = (ev) => {
      if (this.active !== a || (ev.name && ev.name !== 'word')) return;
      this._resync(a, ev.charIndex, performance.now());
    };
    u.onend = u.onerror = () => { if (this.active === a) a.ended = true; };
    a.utterance = u;
    speechSynthesis.speak(u);
  }

  // The voice just started a word: slide the rest of the plan so that
  // word begins now.
  _resync(a, charIndex, now) {
    if (a.started === null) a.started = now;
    const plan = a.plan;
    const base = a.script.chunks[a.chunk].start;
    let k = 0;
    while (k + 1 < plan.length && plan[k + 1].word.start - base <= charIndex) k++;
    const shift = (now - a.started) / 1000 - plan[k].t0;
    for (let i = k; i < plan.length; i++) plan[i].t0 += shift;
    a.synced = true;
  }

  update(now) {
    const a = this.active;
    if (!a) return;
    if (a.mode === 'loading') {
      // A recording that is slow to arrive should not hold the piece up.
      if (now - a.asked > 6000) this._fallBack(a);
      return;
    }
    if (a.mode === 'clip') { this._updateClip(a, now); return; }
    if (!a.plan) return;

    if (a.started === null) {
      // Waiting on the engine. If it never starts (blocked, broken),
      // carry on without it.
      if (now - a.asked > 2500) {
        this._hush(a);
        // Don't make every remaining sentence wait for it again.
        a.silent = true; a.audible = false; a.started = now;
      } else {
        return;
      }
    }

    const t = (now - a.started) / 1000;
    const plan = a.plan;
    while (a.cursor + 1 < plan.length && plan[a.cursor + 1].t0 <= t) {
      a.cursor++;
      a.callbacks.onWord(plan[a.cursor].word);
    }

    const last = plan[plan.length - 1];
    const planDone = !last || t >= last.t0 + last.dur;
    const finished = a.silent
      ? t >= a.planned
      : a.ended || t > a.planned * 2 + 4;   // watchdog for a stuck engine

    if (finished) {
      // Catch up on any words the plan had not reached yet.
      while (a.cursor + 1 < plan.length) {
        a.cursor++;
        a.callbacks.onWord(plan[a.cursor].word);
      }
      if (!a.silent && a.ended && !a.synced && a.planned > 0.5) {
        const actual = t / a.planned;
        this.tempo = Math.min(2, Math.max(0.5, this.tempo * (0.4 + 0.6 * actual)));
      }
      this._nextChunk(now);
      return;
    }

    this._shape(a, t, 1, planDone && !a.silent && !a.ended);
  }

  // Which mouth shapes the plan calls for at time t. `level` is how
  // loud the voice really is (when known); `overrun` means the voice
  // is still going after the plan ran out.
  _shape(a, t, level, overrun) {
    const say = a.callbacks.onMouth;
    if (a.cursor < 0) { say(null, null, 0, level); return; }
    const entry = a.plan[a.cursor];
    const p = (t - entry.t0) / entry.dur;
    const keys = entry.word.keys;
    if (p >= 1 || !keys.length) {
      if (overrun) {
        // Keep the mouth moving quietly rather than freezing shut.
        say(VISEMES.DD, VISEMES.EH, 0.5 + 0.5 * Math.sin(t * 17), level);
      } else {
        // Between words the last shape relaxes toward rest.
        const lastKey = keys.length ? VISEMES[keys[keys.length - 1].v] : null;
        say(lastKey, VISEMES.rest, Math.min(1, (p - 1) * 4), level);
      }
      return;
    }
    let i = 0;
    while (i + 1 < keys.length && keys[i].end <= p) i++;
    const key = keys[i];
    const span = key.end - key.at || 1;
    const local = (p - key.at) / span;
    const prev = i > 0 ? VISEMES[keys[i - 1].v] : VISEMES.rest;
    // Arrive at each shape in the first half of its slot, then hold.
    say(prev, VISEMES[key.v], Math.min(1, local * 2), level);
  }
}
