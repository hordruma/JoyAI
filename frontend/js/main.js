// Joy AI: the dramaturgy.
//
// Comments arrive (from the backend's WebSocket, or from rehearsal),
// wait in two queues, and are performed one at a time, the two faces
// taking turns. This file decides who speaks when and keeps the page in
// step with the performance; the faces, the voice and the field each
// live in their own module.

import { Stage } from './stage.js';
import { Speaker, buildScript, canSpeak } from './speech.js';
import { REHEARSAL } from './rehearsal.js';
import { rand } from './noise.js';

const AVATARS = ['HappyAvatar', 'SadAvatar'];
const other = (id) => (id === 'HappyAvatar' ? 'SadAvatar' : 'HappyAvatar');

// The juxtaposition lives in the delivery: gleeful for Joy, mournful
// for Sorrow. The words themselves are never touched.
const speakers = {
  HappyAvatar: new Speaker({ pitch: 1.7, rate: 1.12 }),
  SadAvatar:   new Speaker({ pitch: 0.5, rate: 0.72 })
};

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const el = {
  status: $('status'), state: $('wsstate'),
  sound: $('sound'), demo: $('demo')
};

const queues = { HappyAvatar: [], SadAvatar: [] };
const history = [];            // everything performed, for reprises
const seen = new Set();
let lastSide = 'SadAvatar';    // so Joy opens
let performing = false;
let audible = false;
let idleSince = performance.now();
let repriseAfter = rand(14, 22) * 1000;
let cast = null;               // id -> { performer, ... } once the stage is up
let stage = null;

// --- The page ------------------------------------------------------------

function strengthOf(payload) {
  const s = payload.sentiment;
  return s && typeof s.contents === 'number' ? Math.min(1, Math.max(0, s.contents)) : 0.6;
}

// A caption: every word present from the start, dim, and lit as it is
// spoken. Newest sits directly under the face; older ones sink and fade.
function addLine(payload, script) {
  const column = $('lines-' + payload.targetAvatar);
  const lineEl = document.createElement('div');
  lineEl.className = 'line';
  const inner = document.createElement('div');
  inner.className = 'inner';

  if (payload.englishTranslation) {
    const original = document.createElement('p');
    original.className = 'original';
    original.textContent = payload.originalComment;
    inner.appendChild(original);
  }

  const spoken = document.createElement('p');
  spoken.className = 'spoken';
  const wordEls = script.words.map((word, i) => {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = word.text;
    spoken.appendChild(span);
    if (i < script.words.length - 1) spoken.appendChild(document.createTextNode(' '));
    return span;
  });
  inner.appendChild(spoken);

  if (payload.source) {
    const source = document.createElement('p');
    source.className = 'source';
    source.textContent = payload.source;
    inner.appendChild(source);
  }

  lineEl.appendChild(inner);
  column.prepend(lineEl);
  // Two frames, so the collapsed state is painted before it opens.
  requestAnimationFrame(() => requestAnimationFrame(() => lineEl.classList.add('in', 'current')));
  [...column.children].slice(3).forEach((old) => old.remove());
  return { lineEl, wordEls };
}

// The readout under a face after it slips: which emotion, for how long.
function annotateSlip(id, kind, ms) {
  const label = $('slip-' + id);
  if (!label) return;
  clearTimeout(label._t1); clearTimeout(label._t2);
  label._t1 = setTimeout(() => {
    label.textContent = kind + ' · ' + (ms / 1000).toFixed(2) + ' s';
    label.classList.add('on');
    label._t2 = setTimeout(() => label.classList.remove('on'), 2600);
  }, ms);
}

// --- Performance ---------------------------------------------------------

function nextPayload() {
  const alt = other(lastSide);
  const side = queues[alt].length ? alt : queues[lastSide].length ? lastSide : null;
  if (!side) return null;
  lastSide = side;
  return queues[side].shift();
}

function reprise() {
  if (history.length < 4) return null;
  const alt = other(lastSide);
  const pool = history.filter((h) => h.payload.targetAvatar === alt);
  const from = pool.length ? pool : history;
  const pickOne = from.reduce((a, b) => (a.last <= b.last ? a : b));
  lastSide = pickOne.payload.targetAvatar;
  return pickOne.payload;
}

async function perform(payload) {
  performing = true;
  const id = payload.targetAvatar;
  const strength = strengthOf(payload);
  const script = buildScript(payload.englishTranslation || payload.originalComment);
  const { lineEl, wordEls } = addLine(payload, script);
  const voiceEl = document.querySelector('.voice[data-avatar="' + id + '"]');
  const me = cast && cast[id] ? cast[id].performer : null;
  const them = cast && cast[other(id)] ? cast[other(id)].performer : null;

  let record = history.find((h) => h.payload === payload);
  if (!record) { record = { payload, last: 0 }; history.push(record); }
  if (history.length > 120) history.shift();
  record.last = performance.now();

  // The mask goes on a beat before the first word.
  voiceEl.classList.add('active');
  if (me) me.setRole('speaking', strength);
  if (them) them.setRole('listening');
  await wait(700);

  await new Promise((resolve) => {
    speakers[id].perform(script, audible, {
      onWord(word) {
        const span = wordEls[word.index];
        if (span) span.classList.add('said');
        if (!me) return;
        const letters = word.text.replace(/[^\p{L}]/gu, '').length;
        if (letters >= 4 || word.loaded) me.stress(Math.min(1, letters / 9));
        // A loaded word is where the mask is most likely to give. The
        // word that did it is marked, briefly, in the other temperature.
        if (word.loaded && me.canLeak(word.loaded) && Math.random() < 0.8 &&
            me.leak(word.loaded, 0.68 + 0.32 * strength) && span) {
          span.classList.add('slip');
          setTimeout(() => span.classList.remove('slip'), 900);
        }
      },
      onMouth(a, b, mix) { if (me) me.setMouth(a, b, mix); },
      onEnd: resolve
    });
  });

  // Hold the last expression a moment, then let it go.
  wordEls.forEach((span) => span.classList.add('said'));
  await wait(900);
  if (me) { me.setMouth(null, null, 0); me.setRole('idle'); }
  if (them) them.setRole('idle');
  voiceEl.classList.remove('active');
  lineEl.classList.remove('current');
  lineEl.classList.add('done');
  await wait(rand(900, 1900));

  performing = false;
  idleSince = performance.now();
  repriseAfter = rand(14, 22) * 1000;
  pump();
}

function pump() {
  if (performing) return;
  const payload = nextPayload();
  if (payload) perform(payload);
}

function enqueue(payload) {
  if (!payload || typeof payload.originalComment !== 'string' ||
      !payload.originalComment.trim() || !(payload.targetAvatar in queues)) return;
  // The backend replays recent material to every new connection, and
  // connections drop and return; say each thing once.
  const key = payload.targetAvatar + '\u0000' + payload.originalComment;
  if (seen.has(key)) return;
  seen.add(key);
  queues[payload.targetAvatar].push(payload);
  pump();
}

// --- Live feed -----------------------------------------------------------

function feedUrl() {
  const override = params.get('ws');
  if (override) return override;
  const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return scheme + location.host + '/ws';
}

let retryIn = 2000;
function connect() {
  let ws;
  try { ws = new WebSocket(feedUrl()); } catch (e) { return scheduleRetry(); }
  ws.onopen = () => {
    retryIn = 2000;
    el.status.classList.add('live');
    el.state.textContent = 'live';
  };
  ws.onmessage = (ev) => {
    try { enqueue(JSON.parse(ev.data)); } catch (e) { /* not ours; ignore */ }
  };
  ws.onclose = () => {
    el.status.classList.remove('live');
    el.state.textContent = 'offline';
    scheduleRetry();
  };
  ws.onerror = () => ws.close();
}
function scheduleRetry() {
  setTimeout(connect, retryIn);
  retryIn = Math.min(retryIn * 1.7, 30000);
}

// --- Controls ------------------------------------------------------------

function setSound(on) {
  audible = on && canSpeak();
  el.sound.classList.remove('invite');
  el.sound.textContent = audible ? 'sound on' : 'sound off';
  el.sound.setAttribute('aria-pressed', String(audible));
  if (!audible && canSpeak()) speechSynthesis.cancel();
}

function rehearse() {
  REHEARSAL.forEach(enqueue);
  // Already seen once? Then just bring the next reprise forward.
  repriseAfter = 0;
}

function toggleSlowSlips() {
  if (!cast) return;
  const slow = !document.body.classList.contains('slow-slips');
  document.body.classList.toggle('slow-slips', slow);
  for (const id of AVATARS) cast[id].performer.leakStretch = slow ? 7 : 1;
}

if (!canSpeak()) {
  el.sound.disabled = true;
  el.sound.textContent = 'no voice here';
}
el.sound.addEventListener('click', () => setSound(!audible));
el.demo.addEventListener('click', rehearse);
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const key = ev.key.toLowerCase();
  if (key === 'm') setSound(!audible);
  else if (key === 'r') rehearse();
  else if (key === 's') toggleSlowSlips();
});
// Leaving the page mid-sentence should not leave a voice talking.
window.addEventListener('pagehide', () => { if (canSpeak()) speechSynthesis.cancel(); });

// --- Boot ----------------------------------------------------------------

function loop() {
  let before = performance.now();
  const tick = (now) => {
    requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - before) / 1000);
    before = now;
    for (const id of AVATARS) speakers[id].update(now);
    if (stage) stage.frame(dt);
    // Nothing new for a while: go back over something already said.
    if (!performing && now - idleSince > repriseAfter) {
      const again = reprise();
      idleSince = now;
      repriseAfter = rand(14, 22) * 1000;
      if (again) perform(again);
    }
  };
  requestAnimationFrame(tick);
}

async function boot() {
  try {
    stage = new Stage($('stage'));
    cast = await stage.cast({
      HappyAvatar: $('face-HappyAvatar'),
      SadAvatar: $('face-SadAvatar')
    });
    for (const id of AVATARS) {
      cast[id].performer.onLeak = (kind, ms) => {
        stage.pulse(id, 1);
        annotateSlip(id, kind, ms);
      };
    }
    if (params.get('slips') === 'slow') toggleSlowSlips();
    document.body.classList.add('ready');
    if (params.has('debug')) window.joyai = { stage, cast, speakers, enqueue, rehearse };
  } catch (err) {
    // No WebGL, or the model failed to load: the piece degrades to its
    // text and voices rather than to a blank page.
    console.error('stage unavailable', err);
    stage = null; cast = null;
    document.body.classList.add('no-stage');
  }
  loop();
  connect();
  if (params.has('rehearsal')) rehearse();
}

boot();
