// Speech: turning a comment into a timed performance.
//
// The words are spoken by the browser's own Web Speech voices, which
// are free, offline, and tell us very little: at best a "boundary"
// event as each word starts. So every reading is planned in advance
// (how long each word should take, which mouth shapes it passes
// through) and the plan is then pulled into line with the real voice
// whenever a boundary event arrives. With sound off, or with a voice
// that reports nothing, the plan simply runs on its own clock and the
// face reads silently.

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

// Drives one voice. `update()` must be called every frame; everything
// the face and the caption need comes out through the callbacks.
export class Speaker {
  constructor({ pitch, rate }) {
    this.pitch = pitch;
    this.rate = rate;
    // Learned correction between planned and actual speaking time, for
    // voices that never report word boundaries.
    this.tempo = 1;
    this.active = null;
  }

  // callbacks: onWord(word), onMouth(a, b, mix), onEnd()
  perform(script, audible, callbacks) {
    this.stop();
    this.active = { script, audible, callbacks, chunk: -1, plan: null };
    this._nextChunk(performance.now());
  }

  stop() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (a.utterance) {
      a.utterance.onstart = a.utterance.onend = a.utterance.onerror =
        a.utterance.onboundary = null;
      if (canSpeak()) speechSynthesis.cancel();
    }
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
    if (!a || !a.plan) return;

    if (a.started === null) {
      // Waiting on the engine. If it never starts (blocked, broken),
      // carry on without it.
      if (now - a.asked > 2500) {
        if (a.utterance) {
          a.utterance.onstart = a.utterance.onend = a.utterance.onerror =
            a.utterance.onboundary = null;
          speechSynthesis.cancel();
        }
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

    if (a.cursor < 0) { a.callbacks.onMouth(null, null, 0); return; }
    const entry = plan[a.cursor];
    const p = (t - entry.t0) / entry.dur;
    const keys = entry.word.keys;
    if (p >= 1 || !keys.length) {
      if (planDone && !a.silent && !a.ended) {
        // The voice is running longer than planned: keep the mouth
        // moving quietly rather than freezing shut.
        const wobble = 0.5 + 0.5 * Math.sin(t * 17);
        a.callbacks.onMouth(VISEMES.DD, VISEMES.EH, wobble);
      } else {
        // Between words the last shape relaxes toward rest.
        const lastKey = keys.length ? VISEMES[keys[keys.length - 1].v] : null;
        a.callbacks.onMouth(lastKey, VISEMES.rest, Math.min(1, (p - 1) * 4));
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
    a.callbacks.onMouth(prev, VISEMES[key.v], Math.min(1, local * 2));
  }
}
