# JoyAI
An Art Project

## SadClown Pipeline

A purely functional Haskell backend that ingests internet commentary about
generative AI (via Tavily), inverts its sentiment through an LLM engine
(GLM by default; any OpenAI-compatible API works), translates the inversion
into Toki Pona, and streams structured payloads over WebSockets to a
dual-avatar frontend:

- **Anti-AI / negative comments** → inverted to manic, hyper-joyful text,
  read by the **Happy Avatar** in a cheerful voice.
- **Pro-AI / positive comments** → inverted to weeping, existential despair,
  read by the **Sad Avatar** in a somber voice.

```
[ Tavily Search API ]
        │  raw JSON
        ▼
┌────────────────────────────────────────────┐
│ Haskell backend (IO / exceptional bounds)  │
│  1. Ingest via http-conduit                │
│  2. Parse strictly into Aeson ADTs         │
│  3. LLM inversion + Toki Pona (GLM/Kimi/…) │
│  4. Pure monadic inversion (Logic.hs)      │
│  5. Serialize InvertedPayload to JSON      │
└────────────────────────────────────────────┘
        │  WebSocket frames (port 8080)
        ▼
[ Frontend AV routing (Happy / Sad avatars) ]
```

### Layout

| Module | Role |
|---|---|
| `src/Types.hs` | Algebraic data types (`SentimentScore`, `AvatarTarget`, `InvertedPayload`) with generic Aeson instances |
| `src/Logic.hs` | Pure logic core — sentiment inversion routing, no IO imports |
| `src/Network/Tavily.hs` | Tavily search ingestion + HTML/URL scrubbing, errors in `ExceptT` |
| `src/Network/LLM.hs` | LLM inversion engine (OpenAI-compatible chat completions, JSON-object mode) |
| `app/Main.hs` | WebSocket broadcast server (port 8080), frontend + health endpoint (port 8081), polling event loop |
| `frontend/index.html` | Dual-avatar GUI: SVG clowns, browser TTS, live WebSocket feed |

### Building

```sh
cabal build
```

### Running

```sh
export TAVILY_API_KEY=tvly-...
export LLM_API_KEY=...          # key for your chat-completions provider
cabal run sadclown-pipeline
```

By default the pipeline talks to GLM (Z.ai) with `glm-4.5-air` — the
cheapest tier that handles this workload well. Any OpenAI-compatible
provider can be swapped in via environment variables:

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

The server broadcasts one JSON frame per processed comment to every
connected WebSocket client:

```json
{
  "originalComment": "AI art is soulless garbage",
  "originalSentiment": { "tag": "Negative", "contents": 0.9 },
  "invertedText": "EVERY PIXEL SINGS! THE MACHINES DREAM IN COLOR AND SO CAN WE!",
  "tokiPonaTranslation": "sitelen ale li kalama musi a!",
  "targetAvatar": "HappyAvatar"
}
```

### Frontend

Open <http://localhost:8081/> — the server hosts a self-contained page with
both clown avatars. It connects to the WebSocket feed on port 8080,
displays each payload, and speaks the Toki Pona line using the free
browser **Web Speech API** (high pitch + fast rate for the Happy avatar,
low pitch + slow rate for the Sad avatar), with mouth-flap animation while
speaking. A **“play demo payload”** button injects sample payloads so the
GUI can be tested with no backend keys at all.

If browser voices are too inconsistent for the installation, the free
self-hosted upgrade path is [Piper TTS](https://github.com/rhasspy/piper)
(MIT-licensed, CPU-only): synthesize server-side and stream audio URLs in
the payload.

### Deploying

```sh
docker build -t sadclown .
docker run -p 8080:8080 -p 8081:8081 \
  -e TAVILY_API_KEY=... -e LLM_API_KEY=... sadclown
```

Any container host works (Fly.io, Railway, Render, a $0 Oracle free-tier
VM). Two notes for public deployment:

- If the frontend is served over HTTPS, browsers require the WebSocket to
  be `wss://` — put a TLS-terminating proxy (Caddy/nginx/host router) in
  front of port 8080, or expose both ports through the same proxy.
- The page derives the WebSocket URL from its own hostname, so no
  configuration is needed as long as port 8080 is reachable on the same
  host.

### Safety constraints

- No `head`, `read`, `fromJust`, or `undefined` — partial failure paths use
  `Maybe` / `Either`.
- Network errors and rate limits are encapsulated in `ExceptT` so a failed
  poll cycle never kills the WebSocket server.

## License

[WTFPL](LICENSE) — Do What The Fuck You Want To Public License, version 2.
