// Record the rehearsal material with the voice service, so the piece
// has its real voice even with no backend at all (static hosting,
// rehearsal mode).
//
//   PIPER_VOICE=/path/to/voice.onnx python tts/server.py &
//   node tools/render-rehearsal.mjs
//
// Writes frontend/assets/voice/NN.{mp3,wav} and rehearsal.json beside
// them. Uses ffmpeg to shrink the clips to MP3 when it is installed.

import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REHEARSAL } from '../frontend/js/rehearsal.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'frontend', 'assets', 'voice');
const endpoint = process.env.TTS_URL || 'http://127.0.0.1:5005/speak';

let haveFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { haveFfmpeg = false; }

mkdirSync(outDir, { recursive: true });
const manifest = [];
for (const [i, line] of REHEARSAL.entries()) {
  const text = line.englishTranslation || line.originalComment;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, avatar: line.targetAvatar })
  });
  if (!res.ok) throw new Error(`line ${i}: voice service answered ${res.status}`);
  const wordTimes = JSON.parse(res.headers.get('x-joyai-words') || '[]');
  const stem = String(i).padStart(2, '0');
  const wav = join(outDir, stem + '.wav');
  writeFileSync(wav, Buffer.from(await res.arrayBuffer()));
  let file = stem + '.wav';
  if (haveFfmpeg) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav,
      '-ac', '1', '-ar', '24000', '-b:a', '56k', join(outDir, stem + '.mp3')]);
    unlinkSync(wav);
    file = stem + '.mp3';
  }
  manifest.push({ audioUrl: 'assets/voice/' + file, wordTimes });
  console.log(`${file}  ${line.targetAvatar}  ${text.slice(0, 60)}`);
}
writeFileSync(join(outDir, 'rehearsal.json'), JSON.stringify(manifest) + '\n');
console.log(`wrote ${manifest.length} recordings and rehearsal.json to ${outDir}`);
