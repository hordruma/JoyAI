#!/bin/sh
# Start the voice service (when the image carries a voice and no other
# service was named), wait for it to load, then hand over to the backend.
set -e

VOICE="/app/voices/${PIPER_VOICE}.onnx"
if [ -z "$TTS_URL" ] && [ -n "$PIPER_VOICE" ] && [ -f "$VOICE" ]; then
  PIPER_VOICE="$VOICE" python /app/tts/server.py &
  export TTS_URL="http://127.0.0.1:${TTS_PORT:-5005}/speak"
  # Loading the model takes a moment; the first comments should not
  # miss their recording because of it.
  python - <<PY || echo "[joyai] voice service did not come up; using the browser's voice"
import sys, time, urllib.request
for _ in range(60):
    try:
        urllib.request.urlopen("http://127.0.0.1:${TTS_PORT:-5005}/health", timeout=2)
        sys.exit(0)
    except Exception:
        time.sleep(0.5)
sys.exit(1)
PY
fi

exec /app/joyai
