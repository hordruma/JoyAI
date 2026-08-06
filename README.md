# JoyAI
An Art Project

## SadClown Pipeline

A purely functional Haskell backend that ingests internet commentary about
generative AI (via Tavily), inverts its sentiment through an LLM engine
(Claude), translates the inversion into Toki Pona, and streams structured
payloads over WebSockets to a dual-avatar frontend:

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
│  3. LLM inversion + Toki Pona (Claude API) │
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
| `src/Network/LLM.hs` | LLM inversion engine (Claude Messages API, JSON-schema structured output) |
| `app/Main.hs` | WebSocket broadcast server (port 8080), health endpoint (port 8081), polling event loop |

### Building

```sh
cabal build
```

### Running

```sh
export TAVILY_API_KEY=tvly-...
export ANTHROPIC_API_KEY=sk-ant-...
cabal run sadclown-pipeline
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

### Safety constraints

- No `head`, `read`, `fromJust`, or `undefined` — partial failure paths use
  `Maybe` / `Either`.
- Network errors and rate limits are encapsulated in `ExceptT` so a failed
  poll cycle never kills the WebSocket server.

## License

[WTFPL](LICENSE) — Do What The Fuck You Want To Public License, version 2.
