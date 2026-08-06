# Joy AI
An Art Project

Internet opinions about generative AI, read aloud **verbatim** by a real
animated human face — in the wrong voice. The words are never changed;
only the delivery is juxtaposed:

- **Anti-AI / negative comments** → read by **Joy**, beaming, in a
  gleeful high-pitched voice.
- **Pro-AI / positive comments** → read by **Sorrow**, grieving, in a
  slow mournful voice.

Comments that aren't in English are faithfully translated so the voices
can read them; everything else passes through untouched.

```
[ Tavily Search API ]
        │  raw JSON
        ▼
┌─────────────────────────────────────────────┐
│ Haskell backend (IO / exceptional bounds)   │
│  1. Ingest via http-conduit                 │
│  2. Parse strictly into Aeson ADTs          │
│  3. LLM annotation: sentiment (+ English)   │
│  4. Pure juxtaposition routing (Logic.hs)   │
│  5. Serialize CommentPayload to JSON        │
└─────────────────────────────────────────────┘
        │  WebSocket frames (port 8080)
        ▼
[ Frontend: two real 3D human faces + browser TTS ]
```

## Layout

| Module | Role |
|---|---|
| `src/Types.hs` | Algebraic data types (`SentimentScore`, `AvatarTarget`, `CommentPayload`) |
| `src/Logic.hs` | Pure logic core — intonation juxtaposition routing, no IO imports |
| `src/Network/Tavily.hs` | Tavily search ingestion + HTML/URL scrubbing, errors in `ExceptT` |
| `src/Network/LLM.hs` | LLM annotation engine (OpenAI-compatible chat completions, JSON-object mode) |
| `app/Main.hs` | WebSocket broadcast server (8080), frontend + health endpoint (8081), polling loop |
| `frontend/` | Self-hosted GUI: three.js, real human face model, browser TTS |

## Building

```sh
cabal build
```

## Running

```sh
export TAVILY_API_KEY=tvly-...
export LLM_API_KEY=...          # key for your chat-completions provider
cabal run joyai
```

Then open <http://localhost:8081/>. A **"rehearsal"** button
injects sample payloads so the GUI (faces, voices, feed) can be tested
with no API keys at all.

### LLM provider

Defaults to GLM (Z.ai) with `glm-4.5-air` — the cheapest tier that
handles this workload well. Any OpenAI-compatible provider can be
swapped in via environment variables:

| Variable | Default | Notes |
|---|---|---|
| `LLM_API_KEY` | *(required)* | Bearer token for the provider |
| `LLM_BASE_URL` | `https://api.z.ai/api/paas/v4/chat/completions` | Full chat-completions URL |
| `LLM_MODEL` | `glm-4.5-air` | e.g. `glm-4-flash` (free tier) |

Using Kimi (Moonshot) instead:

```sh
export LLM_BASE_URL=https://api.moonshot.ai/v1/chat/completions
export LLM_MODEL=kimi-k2-0905-preview
```

## Frontend

The page renders **two real 3D human faces** — the photogrammetry face
scan from the three.js examples (`facecap.glb`, captured with the Face
Cap app), driven through its 52 ARKit facial blendshapes:

- Joy holds a smile (warm lighting); Sorrow holds a frown with raised
  inner brows (cold lighting).
- While a comment is spoken the active face lip-syncs via the `jawOpen`
  blendshape; both faces blink and sway idly.
- All three.js modules, decoders, and the face model are **vendored in
  `frontend/vendor` / `frontend/assets`** — no CDN, works offline.

Speech is the free browser **Web Speech API**: Joy speaks at pitch 1.7 /
fast rate, Sorrow at pitch 0.5 / slow rate. The comment text is spoken
exactly as written — the juxtaposition is entirely in the delivery. For
consistent voices across visitors, the free self-hosted upgrade path is
[Piper TTS](https://github.com/rhasspy/piper) (MIT, CPU-only).

## Deploying

```sh
docker build -t joyai .
docker run -p 8080:8080 -p 8081:8081 \
  -e TAVILY_API_KEY=... -e LLM_API_KEY=... joyai
```

Any container host works (Fly.io, Railway, Render, a $0 Oracle free-tier
VM). Two notes for public deployment:

- If the frontend is served over HTTPS, browsers require the WebSocket
  to be `wss://` — put a TLS-terminating proxy (Caddy/nginx) in front of
  both ports.
- The page derives the WebSocket URL from its own hostname, so no
  configuration is needed as long as port 8080 is reachable on the same
  host.

## Safety constraints

- No `head`, `read`, `fromJust`, or `undefined` — partial failure paths
  use `Maybe` / `Either`.
- Network errors and rate limits are encapsulated in `ExceptT` so a
  failed poll cycle never kills the WebSocket server.

## Credits & License

- Face model: `facecap.glb` from the
  [three.js examples](https://github.com/mrdoob/three.js), captured with
  [Face Cap](https://bannaflak.com/face-cap/); three.js is MIT-licensed.
- Everything else: [WTFPL](LICENSE) — Do What The Fuck You Want To
  Public License, version 2.
