"""Joy AI voice service.

A small HTTP wrapper around Piper (a local neural text-to-speech
engine) that gives the two faces one consistent voice in two
deliveries. The backend posts each comment here before broadcasting it:

    POST /speak   {"text": "...", "avatar": "HappyAvatar" | "SadAvatar"}
      -> 200 audio/wav
         X-Joyai-Words: [[start, end], ...]   seconds, one pair per
                                              whitespace-separated word

    GET /health   -> {"status": "ok"}

Both faces are the same scan, so both use the same voice. What differs
is the delivery (see DELIVERY). Word timings come from the model's own
phoneme alignments, so captions and lips can follow the audio exactly.

Configuration (environment):
    PIPER_VOICE   path to the voice's .onnx file (its .onnx.json beside it)
    TTS_HOST      default 127.0.0.1
    TTS_PORT      default 5005
"""

import io
import json
import logging
import os
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from piper import PiperVoice, SynthesisConfig

LOG = logging.getLogger("joyai.tts")

# The juxtaposition, as sound. `pitch` shifts the voice by resampling
# (1.12 is about two semitones up), `tempo` is the resulting speaking
# rate relative to the voice's natural one, `noise` is how much the
# intonation is allowed to move (lively against flat), `rhythm` how
# uneven the timing is, and `gap` the silence left after a sentence.
DELIVERY = {
    "HappyAvatar": {"pitch": 1.13, "tempo": 1.08, "noise": 0.82, "rhythm": 0.95, "gap": 0.16},
    "SadAvatar": {"pitch": 0.87, "tempo": 0.78, "noise": 0.38, "rhythm": 0.55, "gap": 0.6},
}

MAX_CHARS = 700
SENTENCE_BREAK = re.compile(r"(?<=[.!?…])[\"'”’)\]]*\s+")
# Phonemes that separate words rather than belong to one.
BREAKS = set(" ^$_,.;:!?—–…\"'()[]")


def split_sentences(text):
    """Whole sentences, each ending where a reader would breathe."""
    parts, last = [], 0
    for match in SENTENCE_BREAK.finditer(text):
        parts.append(text[last:match.end()])
        last = match.end()
    parts.append(text[last:])
    return [p for p in (part.strip() for part in parts) if p]


def spread(tokens, start, end):
    """Fallback timing: share a span among words by their length."""
    weights = [0.11 + 0.055 * min(14, sum(c.isalnum() for c in t)) for t in tokens]
    total = sum(weights) or 1.0
    spans, at = [], float(start)
    for weight in weights:
        width = (end - start) * weight / total
        spans.append((at, at + width))
        at += width
    return spans


def aligned_words(chunk, offset):
    """Word spans (in samples) from one chunk's phoneme alignments."""
    alignments = chunk.phoneme_alignments
    if not alignments:
        return None
    produced = len(chunk.audio_float_array)
    claimed = sum(int(a.num_samples) for a in alignments) or 1
    scale = produced / claimed
    spans, begun, at = [], None, 0.0
    for alignment in alignments:
        if alignment.phoneme in BREAKS:
            if begun is not None:
                spans.append((offset + begun, offset + at))
                begun = None
        elif begun is None:
            begun = at
        at += int(alignment.num_samples) * scale
    if begun is not None:
        spans.append((offset + begun, offset + at))
    return spans


class Voice:
    def __init__(self, model_path):
        self.voice = PiperVoice.load(model_path, include_alignments=True)
        self.rate = self.voice.config.sample_rate
        self.lock = threading.Lock()

    def speak(self, text, avatar):
        """Returns (wav bytes, [(start, end), ...] in seconds)."""
        style = DELIVERY[avatar]
        config = SynthesisConfig(
            # Resampling for pitch also changes speed; undo that here so
            # `tempo` means what it says.
            length_scale=style["pitch"] / style["tempo"],
            noise_scale=style["noise"],
            noise_w_scale=style["rhythm"],
        )
        pieces, spans, cursor = [], [], 0
        gap = np.zeros(int(self.rate * style["gap"] * style["pitch"]), dtype=np.int16)

        with self.lock:
            for sentence in split_sentences(text):
                tokens = sentence.split()
                start, words, exact = cursor, [], True
                for chunk in self.voice.synthesize(sentence, config, include_alignments=True):
                    found = aligned_words(chunk, cursor)
                    if found is None:
                        exact = False
                    else:
                        words.extend(found)
                    audio = chunk.audio_int16_array
                    pieces.append(audio)
                    cursor += len(audio)
                # The model pronounces "3am" as three words and we see
                # one; when the counts disagree, estimate instead.
                if exact and len(words) == len(tokens):
                    spans.extend(words)
                else:
                    spans.extend(spread(tokens, start, cursor))
                pieces.append(gap)
                cursor += len(gap)

        pcm = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.int16)
        # Declaring a different sample rate than the audio was made at is
        # the whole pitch shift: no processing, no artefacts.
        rate = int(round(self.rate * style["pitch"]))
        out = io.BytesIO()
        with wave.open(out, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(pcm.tobytes())
        times = [(round(a / rate, 3), round(b / rate, 3)) for a, b in spans]
        return out.getvalue(), times


class Handler(BaseHTTPRequestHandler):
    voice = None

    def log_message(self, fmt, *args):
        LOG.debug(fmt, *args)

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"status": "ok"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/speak":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length) or b"{}")
            text = " ".join(str(request.get("text", "")).split())
            avatar = request.get("avatar")
        except (ValueError, AttributeError):
            return self._json(400, {"error": "expected a JSON object"})
        if avatar not in DELIVERY:
            return self._json(400, {"error": "unknown avatar"})
        if not text or len(text) > MAX_CHARS:
            return self._json(400, {"error": "text must be 1-%d characters" % MAX_CHARS})
        try:
            audio, times = self.voice.speak(text, avatar)
        except Exception:  # the voice must never take the service down
            LOG.exception("synthesis failed")
            return self._json(500, {"error": "synthesis failed"})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Joyai-Words", json.dumps(times, separators=(",", ":")))
        self.end_headers()
        self.wfile.write(audio)


def main():
    logging.basicConfig(level=logging.INFO, format="[joyai-tts] %(message)s")
    model = os.environ.get("PIPER_VOICE")
    if not model or not os.path.exists(model):
        raise SystemExit("PIPER_VOICE must point at a Piper .onnx voice file")
    Handler.voice = Voice(model)
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "5005"))
    LOG.info("voice %s ready on %s:%d", os.path.basename(model), host, port)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
