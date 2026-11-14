// Affect data: what each face performs, and what slips out.
//
// Everything here is expressed as ARKit blendshape name → weight, the
// rig the face scan ships with. Unknown names are ignored at runtime, so
// this file survives a model swap.
//
// Two layers matter to the piece:
//
//   MASKS  the performed affect. Joy beams, Sorrow grieves, whatever
//          the words say. Held for the whole reading.
//   LEAKS  micro-expressions. Following Ekman, a concealed emotion
//          escapes as a full-face flash lasting well under half a
//          second before the mask closes over it again. Here the
//          concealed emotion is simply the one the comment actually
//          carries.
//
// Leak shapes follow the FACS action units for each universal emotion,
// translated to the nearest ARKit shapes.

const both = (name, v, skew = 0) => ({
  [name + '_L']: v * (1 - skew),
  [name + '_R']: v * (1 + skew)
});

// What a face looks like with nothing on it. The scan's neutral pose is
// wide-eyed; a person at rest has heavier lids than that, and each of
// these two has a little of their habit left even off duty.
export const REST = {
  HappyAvatar: {
    ...both('eyeBlink', 0.1), ...both('eyeSquint', 0.12),
    ...both('mouthSmile', 0.07)
  },
  SadAvatar: {
    ...both('eyeBlink', 0.17), ...both('eyeSquint', 0.06),
    browInnerUp: 0.14, ...both('mouthFrown', 0.08)
  }
};

export const MASKS = {
  // A Duchenne smile: lip corners (AU12) and, crucially, the cheek
  // raise that reaches the eyes (AU6). Slightly lopsided, like a person.
  HappyAvatar: {
    ...both('mouthSmile', 0.74, 0.04),
    ...both('mouthDimple', 0.3),
    ...both('cheekSquint', 0.55),
    ...both('eyeSquint', 0.34),
    ...both('browOuterUp', 0.1),
    ...both('mouthUpperUp', 0.08),
    browInnerUp: 0.1
  },
  // Grief: inner brows drawn up and together (AU1+4), lip corners down
  // (AU15), chin pushed up (AU17), heavy lids.
  SadAvatar: {
    browInnerUp: 0.85,
    ...both('browDown', 0.16),
    ...both('mouthFrown', 0.64, -0.05),
    mouthShrugLower: 0.34,
    ...both('mouthPress', 0.12),
    ...both('eyeSquint', 0.14),
    ...both('eyeBlink', 0.06)
  }
};

export const LEAKS = {
  // Unilateral lip-corner tighten and raise (AU12+14, one side only).
  contempt: {
    shape: {
      mouthDimple_L: 0.85, mouthSmile_L: 0.38, mouthPress_L: 0.45,
      noseSneer_L: 0.22, eyeSquint_L: 0.3, eyeSquint_R: 0.12,
      mouthFrown_R: 0.12
    },
    head: { roll: 0.035, pitch: 0.03 }
  },
  // Nose wrinkle and raised upper lip (AU9+10), brows pulled down.
  disgust: {
    shape: {
      ...both('noseSneer', 0.9), ...both('mouthUpperUp', 0.62),
      ...both('browDown', 0.6), ...both('eyeSquint', 0.5),
      ...both('cheekSquint', 0.3), ...both('mouthFrown', 0.3),
      mouthShrugLower: 0.3
    },
    head: { pitch: 0.04 }
  },
  // Lowered brows, glare, tightened and pressed lips (AU4+5+7+23/24).
  anger: {
    shape: {
      ...both('browDown', 1), ...both('eyeWide', 0.2),
      ...both('eyeSquint', 0.7), ...both('noseSneer', 0.5),
      ...both('mouthPress', 0.6), ...both('mouthFrown', 0.38),
      ...both('mouthUpperUp', 0.16), ...both('mouthStretch', 0.2),
      mouthRollUpper: 0.2, mouthRollLower: 0.15, jawForward: 0.35
    },
    head: { pitch: -0.045 }
  },
  // Brows raised and drawn together, upper lids up, lips stretched
  // back (AU1+2+4+5+20).
  fear: {
    shape: {
      browInnerUp: 0.95, ...both('browOuterUp', 0.5),
      ...both('browDown', 0.22), ...both('eyeWide', 0.85),
      ...both('mouthStretch', 0.7), ...both('mouthLowerDown', 0.2),
      jawOpen: 0.14
    },
    head: { pitch: 0.035 }
  },
  // AU1+4+15+17: the thing Sorrow performs, but real.
  sadness: {
    shape: {
      browInnerUp: 0.95, ...both('browDown', 0.25),
      ...both('mouthFrown', 0.8), mouthShrugLower: 0.45,
      ...both('eyeBlink', 0.22), ...both('mouthPress', 0.2)
    },
    head: { pitch: -0.05 }
  },
  // AU6+12: the thing Joy performs, but real.
  happiness: {
    shape: {
      ...both('mouthSmile', 0.9), ...both('cheekSquint', 0.8),
      ...both('eyeSquint', 0.5), ...both('mouthDimple', 0.3),
      ...both('mouthUpperUp', 0.12)
    },
    head: { pitch: 0.035 }
  },
  // AU1+2+5+26: everything opens.
  surprise: {
    shape: {
      browInnerUp: 0.75, ...both('browOuterUp', 0.85),
      ...both('eyeWide', 0.75), jawOpen: 0.28, mouthFunnel: 0.14
    },
    head: { pitch: 0.045 }
  }
};

// What each mask is able to let slip, and how often when nothing in the
// text prompts it. A face can only leak what it is hiding.
export const REPERTOIRE = {
  HappyAvatar: { contempt: 3, disgust: 3, anger: 2.5, fear: 1.5, sadness: 1 },
  SadAvatar:   { happiness: 4, surprise: 2 }
};

// Loaded words. When one is spoken, the matching emotion is far more
// likely to break through at that instant. Entries are stems, matched
// against the start of the lower-cased word.
const LEXICON = {
  disgust: ['garbage', 'slop', 'soulless', 'gross', 'disgust', 'trash',
            'vomit', 'sludge', 'ugly', 'rot', 'filth', 'nause', 'sick',
            'crap', 'shit', 'junk', 'plagiar'],
  anger:   ['steal', 'stole', 'theft', 'thie', 'asham', 'shame', 'hate',
            'fuck', 'damn', 'ban', 'destroy', 'ruin', 'kill', 'exploit',
            'rob', 'outrag', 'furious', 'disgrace', 'unforgiv', 'evil',
            'lie', 'lying', 'liar'],
  contempt: ['lol', 'pathetic', 'joke', 'hype', 'grift', 'scam', 'bros',
             'lazy', 'fake', 'useless', 'stupid', 'dumb', 'idiot',
             'clown', 'cringe', 'mediocr', 'talentless', 'laugh',
             'gimmick', 'bubble', 'toy'],
  fear:    ['scar', 'terrif', 'danger', 'threat', 'afraid', 'fear',
            'doom', 'replac', 'obsolete', 'extinct', 'job', 'surveil',
            'dystopi', 'collapse', 'apocal', 'worr', 'unemploy'],
  sadness: ['sad', 'lost', 'loss', 'dying', 'dead', 'death', 'grie',
            'mourn', 'lonel', 'hopeless', 'empty', 'heartbr', 'depress',
            'miss', 'gone'],
  happiness: ['love', 'great', 'better', 'best', 'wonderful', 'happy',
              'joy', 'excit', 'beautiful', 'fun', 'delight', 'thank',
              'grateful', 'helpful', 'brillian', 'awesome', 'good',
              'enjoy', 'glad', 'hope', 'optimis', 'empower', 'free',
              'cure', 'solve'],
  surprise: ['amaz', 'incred', 'wow', 'mindbl', 'unbeliev', 'magic',
             'astonish', 'insane', 'revolution', 'miracle', 'stunn',
             'breakthrough', 'imagine', 'overnight']
};

export function loadedWord(word) {
  const w = word.toLowerCase().replace(/[^a-z']/g, '');
  if (w.length < 3) return null;
  for (const kind in LEXICON) {
    const stems = LEXICON[kind];
    for (let i = 0; i < stems.length; i++) {
      const stem = stems[i];
      // Short stems must match the whole word ("ban", "rob", "lie").
      if (stem.length <= 3 ? w === stem : w.startsWith(stem)) return kind;
    }
  }
  return null;
}

// --- Visemes ---------------------------------------------------------------
// Mouth shapes for speech. The browser's speech engine gives us words,
// not phonemes, so spelling stands in for sound: crude, but it puts lip
// closures on m/b/p and rounding on o/u, which is most of what reads as
// "that mouth is saying those words".

export const VISEMES = {
  rest: {},
  PP: { ...both('mouthPress', 0.5), mouthRollLower: 0.18, mouthRollUpper: 0.14 },
  FF: { mouthRollLower: 0.5, ...both('mouthUpperUp', 0.26), jawOpen: 0.07 },
  TH: { jawOpen: 0.15, tongueOut: 0.22, ...both('mouthLowerDown', 0.12) },
  DD: { jawOpen: 0.15, ...both('mouthLowerDown', 0.16), ...both('mouthUpperUp', 0.1) },
  KK: { jawOpen: 0.22, ...both('mouthLowerDown', 0.1) },
  CH: { jawOpen: 0.12, mouthFunnel: 0.48, mouthPucker: 0.2 },
  SS: { jawOpen: 0.06, ...both('mouthStretch', 0.3), ...both('mouthLowerDown', 0.16) },
  RR: { jawOpen: 0.14, mouthPucker: 0.36, mouthFunnel: 0.2 },
  WW: { jawOpen: 0.12, mouthPucker: 0.66, mouthFunnel: 0.26 },
  AA: { jawOpen: 0.56, ...both('mouthLowerDown', 0.22) },
  EH: { jawOpen: 0.32, ...both('mouthStretch', 0.28), ...both('mouthLowerDown', 0.16) },
  IH: { jawOpen: 0.18, ...both('mouthStretch', 0.44), ...both('mouthLowerDown', 0.1) },
  OH: { jawOpen: 0.4, mouthFunnel: 0.56, mouthPucker: 0.16 },
  UH: { jawOpen: 0.2, mouthPucker: 0.6, mouthFunnel: 0.36 }
};

const DIGRAPHS = {
  th: 'TH', sh: 'CH', ch: 'CH', ph: 'FF', wh: 'WW', ck: 'KK', ng: 'KK',
  qu: 'WW', oo: 'UH', ee: 'IH', ea: 'IH', ou: 'OH', ow: 'OH', ai: 'EH',
  ay: 'EH', oi: 'OH', oy: 'OH', au: 'AA', aw: 'AA'
};
const LETTERS = {
  a: 'AA', e: 'EH', i: 'IH', o: 'OH', u: 'UH', y: 'IH',
  b: 'PP', p: 'PP', m: 'PP', f: 'FF', v: 'FF',
  t: 'DD', d: 'DD', n: 'DD', l: 'DD',
  k: 'KK', g: 'KK', c: 'KK', q: 'KK', x: 'KK', h: 'KK',
  j: 'CH', s: 'SS', z: 'SS', r: 'RR', w: 'WW'
};
const VOWELS = new Set(['AA', 'EH', 'IH', 'OH', 'UH']);

// Spell a word out as a sequence of { viseme, weight } keys. Weight is
// the relative time the shape is held: vowels linger, consonants don't.
export function visemesFor(word) {
  // Fold accents so "vergüenza" still moves the mouth.
  const w = word.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  const out = [];
  if (!w) return out;
  if (/^[0-9]+$/.test(w)) {
    // Digits are read as words we can't see; mumble plausibly.
    for (let i = 0; i < w.length; i++) {
      out.push({ v: 'DD', w: 0.7 }, { v: i % 2 ? 'OH' : 'IH', w: 1.3 });
    }
    return out;
  }
  let i = 0;
  while (i < w.length) {
    const pair = w.slice(i, i + 2);
    let v = DIGRAPHS[pair];
    if (v) { i += 2; } else {
      const ch = w[i];
      // Silent final e ("shame", "love").
      if (ch === 'e' && i === w.length - 1 && w.length > 3 && out.length) { i++; continue; }
      v = LETTERS[ch];
      i++;
    }
    if (!v) continue;
    const last = out[out.length - 1];
    if (last && last.v === v) { last.w += 0.35; continue; }
    out.push({ v, w: VOWELS.has(v) ? 1.35 : 0.75 });
  }
  return out;
}
